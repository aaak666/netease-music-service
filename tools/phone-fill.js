/*
 * tools/phone-fill.js —— 手机歌单同步工具（应急 CLI）：把手机上"喜欢的音乐"批次目录补齐到当前项目口径
 *
 * 约束（用户拍板）：
 *  - 不把手机已有音频复制到 PC（对账只靠文件清单在内存完成）
 *  - 新下载的歌不经过本地磁盘：内存取流 → 内存打 ID3v2.3 标签 → base64 管道直写手机 → md5 校验
 *  - 新歌 320k MP3（exhigh；该档位降级阶梯只有自己，不会静默变无损；无音源即无版权，终态不重试）
 *
 * 全部原语复用项目自身（core.adb 的 pushBuffer/shq、core.tag 的内存打标签、service.download 的
 * 命名分配/封面/超时）——工具层不再维护任何字节级副本，避免与正式管线口径漂移。
 * 依赖 adb（C:\Users\<用户>\Tools\platform-tools\，或用环境变量 ADB 指定），
 * 手机需开启 USB 调试并授权。
 *
 * 与主管线（service/phone）的已知分叉（应急 CLI 接受，逐条留痕）：
 *  - 不走 pushToDevice 的断连恢复宽限：USB 抖动直接逐首失败，重跑本脚本即可续传
 *  - 音频推送用 core 默认 10 分钟超时（主管线 3 分钟）——CLI 场景宁可等，不断言
 *  - "音频在、歌词缺"的歌直接 skip 不补词（主管线 existed 分支会补）——应急补音频优先
 *  - 不经全局串行队列：与服务并存时同一设备目录会有两个写入方——启动时探 /api/ping 提醒
 *
 * 用法：node tools/phone-fill.js --dry-run | --run
 */
const http = require('http')
const MODE = process.argv.includes('--run') ? 'run' : 'dry'
// adb 定位统一走 core.adb（环境变量 ADB → ~/Tools/platform-tools → PATH），工具层不再自持一份
const REMOTE_DIR = '/sdcard/Music/aaak666喜欢的音乐 [7833074177]'
const PLAYLIST_NAME = 'aaak666喜欢的音乐'

const svc = require('../src/service')
const core = require('../src/core')
const adb = core.adb
const { resolveWithFallback } = require('../src/service/resolve')
const { createLruCache } = require('../src/service/util')
const TIMEOUTS = svc.download.TIMEOUTS

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)

/** 手机目录清单（形状与 storage.scanDir 一致）：基础名 → {audio:Set, lrc:Set}（只认 mp3/flac/lrc） */
function phoneState() {
  const audio = new Map(), lrc = new Set()
  for (const name of adb.listFiles(REMOTE_DIR)) {
    const dot = name.lastIndexOf('.')
    if (dot <= 0) continue
    const ext = name.slice(dot + 1).toLowerCase()
    const base = name.slice(0, dot)
    if (ext === 'mp3' || ext === 'flac') {
      if (!audio.has(base)) audio.set(base, new Set())
      audio.get(base).add(ext)
    } else if (ext === 'lrc') lrc.add(base)
  }
  return { audio, lrc }
}

/** 取歌单全量歌曲（登录态 cookie） */
async function findPlaylistSongs() {
  const { body: acc } = await core.raw('user_account')
  const uid = acc.profile && acc.profile.userId
  if (!uid) throw new Error('拿不到账号 uid（cookie 可能过期）')
  const { body: up } = await core.raw('user_playlist', { uid, limit: 100 })
  const hit = (up.playlist || []).find((p) => p.name === PLAYLIST_NAME)
  if (!hit) throw new Error('账号歌单里没找到: ' + PLAYLIST_NAME)
  log('歌单 id =', hit.id, '，曲目数 =', hit.count || (hit.trackIds || []).length)
  const pl = await svc.playlist.get(hit.id)
  // 按 id 去重（歌单重复收录会让同名组逻辑多下一份）
  const seen = new Set()
  return pl.songs.filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)))
}

/** 与服务并存检查：本工具不经全局串行队列——服务正跑手机任务时再跑它，同一设备目录
 *  会有两个写入方、两套命名分配（"同一时刻只跑一个"只是进程内不变量）。探到服务在跑就提醒 */
async function warnIfServiceRunning() {
  const port = process.env.PORT || 3000
  try {
    await new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/api/ping', timeout: 1500 }, (res) => { res.resume(); resolve() })
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
      req.on('error', reject)
    })
    log(`⚠ 检测到本服务正在运行（127.0.0.1:${port}）——若网页上有进行中的手机任务，请先完成/取消再跑本工具（两者不经同一队列，并发写同一设备目录会互相踩）`)
  } catch { /* 服务没起：本工具独自干活，无需提醒 */ }
}

async function main() {
  await warnIfServiceRunning()
  const songs = await findPlaylistSongs()
  log('歌单歌曲（按 id 去重后）:', songs.length)

  const phone = phoneState()
  log('手机已有: 音频', phone.audio.size, '首 / 歌词', phone.lrc.size, '个')

  // 命名分配与落盘同一出处：先认领手机已有产物，其余分配新名（同名组全组加歌手）
  const taken = new Set([...phone.audio.keys(), ...phone.lrc])
  const bases = svc.download.assignBaseNames(songs, taken)

  const download = [], skip = [], lrcOnly = []
  for (const s of songs) {
    const b = bases.get(s)
    if (phone.audio.has(b)) skip.push(s)
    else { download.push(s); if (phone.lrc.has(b)) lrcOnly.push(s) }
  }
  const assignedBases = new Set(bases.values())
  const unclaimed = [...phone.audio.keys()].filter((b) => !assignedBases.has(b))
  log(`对账结果: 已存在(跳过) ${skip.length}，需下载 ${download.length}（其中 ${lrcOnly.length} 首手机上已有歌词），手机上未被歌单认领的文件 ${unclaimed.length} 个`)
  if (unclaimed.length) log('未认领文件（多为已移出歌单的歌，保留不动）:', unclaimed.slice(0, 10).join(' | '), unclaimed.length > 10 ? '...' : '')

  // 读旧索引合并（只增不删，与 service/storage.mergeIndexFile 同语义）：整份覆盖会把
  // "已移出歌单的歌"的 id→base 条目清掉，主管线增量对账从此退回按名匹配——正是索引机制要消灭的场景
  const index = new Map()
  try {
    const raw = JSON.parse(adb.readText(`${REMOTE_DIR}/.ncm-index.json`))
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [id, base] of Object.entries(raw)) {
        if (typeof base === 'string' && base) index.set(String(id), base)
      }
    }
  } catch { /* 无/坏索引：从空开始（与主管线"坏文件降级"同口径） */ }
  const oldIndexSize = index.size
  for (const s of skip) index.set(String(s.id), bases.get(s))
  if (MODE === 'dry') {
    log('--- dry run，前 15 首待下载 ---')
    for (const s of download.slice(0, 15)) log('  ', s.id, bases.get(s), '-', s.artist)
    if (download.length > 15) log('   ... 等', download.length, '首')
    log('dry run 结束，未写任何数据。加 --run 执行真实下载')
    return
  }

  // 封面按 picUrl 去重（LRU 同 service.download.downloadMany 口径）
  const coverCache = createLruCache((picUrl) => svc.download.fetchCover(picUrl))
  const failed = []
  const t0 = Date.now()
  for (let i = 0; i < download.length; i++) {
    const s = download[i]
    const base = bases.get(s)
    const label = `[${i + 1}/${download.length}] ${s.name}`
    try {
      const resolved = await core.retry.withRetry(
        () => resolveWithFallback(s.id, { level: 'exhigh' }),
        { retries: 1, backoffMs: 800, timeoutMs: TIMEOUTS.RESOLVE, shouldRetry: (e) => core.error.isTransient(e) },
      )
      if (resolved.ext !== 'mp3') throw new Error('非 mp3 档位: ' + resolved.level)
      const { buf: audio } = await core.retry.withRetry(
        () => core.download.fetchBuffer(resolved.url, { timeoutMs: TIMEOUTS.DOWNLOAD }),
        { retries: 1, backoffMs: 800, shouldRetry: (e) => core.error.isTransient(e) },
      )
      const expected = Number(resolved.size) || 0
      if (expected > 0) {
        const diff = Math.abs(audio.length - expected)
        if (diff > 1024 && diff / expected > 0.01) throw new Error(`大小异常: 期望约 ${expected}B 实际 ${audio.length}B`)
      }
      // 封面按 picUrl 去重；歌词缺才补（手机已有歌词不重写）
      let cover = null, mime = null
      try {
        const c = await coverCache(s.picUrl)
        if (c) { cover = c.buf; mime = c.mime }
      } catch (e) { log('  封面失败(不影响音频):', e.message) }
      const tagged = core.tag.embedMp3Buf(audio, { title: s.name, artist: s.artist, album: s.album, cover, mime })
      core.tag.verifyAudioHead(tagged)
      const audioRemote = `${REMOTE_DIR}/${base}.mp3`
      adb.pushBuffer(tagged, audioRemote)

      if (!phone.lrc.has(base)) {
        try {
          const { lrc, tlyric } = await core.retry.withRetry(() => core.lyric.get(s.id), { retries: 0, timeoutMs: TIMEOUTS.LYRIC })
          const merged = core.lyric.mergeTranslation(lrc, tlyric)
          if (merged) adb.pushBuffer(Buffer.from(merged, 'utf8'), `${REMOTE_DIR}/${base}.lrc`)
        } catch { /* 歌词可选，失败不影响 */ }
      }
      index.set(String(s.id), base)
      const mb = (tagged.length / 1048576).toFixed(1)
      log(`${label} ✓ ${mb}MB (${Math.round((Date.now() - t0) / 1000)}s)`)
    } catch (e) {
      failed.push({ id: s.id, name: s.name, err: e.message })
      log(`${label} ✗ ${e.message}`)
    }
  }

  // 索引写回手机（扁平 {"id":"base"}，与 service/storage.readIndexFile 同格式）；
  // 先推 .tmp 再 mv 覆盖：pushBuffer 失败会 rm 目标路径，直接写索引名时一次失败就丢整份历史索引
  const tmpPath = `${REMOTE_DIR}/.ncm-index.json.tmp`
  adb.pushBuffer(Buffer.from(JSON.stringify(Object.fromEntries(index)), 'utf8'), tmpPath)
  adb.shell(`mv ${adb.shq(tmpPath)} ${adb.shq(`${REMOTE_DIR}/.ncm-index.json`)}`)
  log('已写 .ncm-index.json（', index.size, '条 = 旧索引', oldIndexSize, '条 + 本次歌单条目合并）')

  const fin = phoneState()
  log(`终态: 音频 ${fin.audio.size} 首 / 歌词 ${fin.lrc.size} 个 / 索引 ${index.size} 条`)
  if (failed.length) {
    log('失败清单（', failed.length, '首，重跑本脚本即可只补这些）:')
    for (const f of failed) log('  ', f.id, f.name, '—', f.err)
  } else {
    log('全部完成，零失败')
  }
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1) })
