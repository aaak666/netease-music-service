/**
 * 手机目的地下载管线（ADB 直写，零本地磁盘）——设备侧落盘后端 + 断连容错
 *  - 批次目录/标记/索引与本地完全同名同格式（storage.batchStem / .ncm-batch.json / .ncm-index.json）
 *  - 批量下载的决策逻辑统一在 service/pipeline.runBatch（与本地管线共用同一骨架，
 *    "两管线口径对齐"从结构上收口）；本文件只提供 adb 落盘后端与设备端操作原语
 *  - 逐首：解链（同款重试分级）→ 内存取流 → 内存打标签（含封面）→ base64 管道直写 → 远端 md5 校验
 *    全程不经本地磁盘；没有 .part/.tagtmp，可靠性由逐文件 md5 校验兜底（不符即删半成品）
 *  - 结果/回调形状与本地管线逐字对齐 → server 的任务卡片与汇总零改动
 *
 * 已知取舍（v1）：adb 调用走同步 spawnSync（单次 ~50ms，推送 ~0.3-1.5s/首），任务执行期间
 * 事件循环会被阻塞——UI 轮询/取消请求要等当前次 adb 调用结束才被处理（每首内部多次调用，
 * 最长可能积压数秒）；换 async 需重写整条 adb 通道，收益不成比例，v1 如实接受。
 */
const core = require('../core')
const storage = require('./storage')
const dl = require('./download')
const naming = require('./naming')
const pipeline = require('./pipeline')
const incremental = require('./incremental')
const adbSvc = require('./adb')
const logger = require('./logger')
const { throwIfCancelled, mergeSignals, sleep, assertIntegrity } = require('./util')
const adb = core.adb

const PUSH_TIMEOUT = 30 * 1000   // 标记/索引/歌词等小文件推送上限
const AUDIO_PUSH_TIMEOUT = 3 * 60 * 1000 // 音频推送上限：≤80MB 走 USB 远快于取流的 10 分钟预算；
                                         // 停滞到超时视为断连征兆（spawnSync 层超时带 deviceSuspect 标记）
const MAX_AUDIO_BYTES = 64 * 1024 * 1024 // 音频内存上限基线；按 resolve 返回的实际 size 动态放宽（超长无损也能下）
const MAX_AUDIO_BYTES_CEIL = 512 * 1024 * 1024 // 放宽的绝对天花板：size 是接口字段、未经校验，
                                                 // 不封顶的话一个异常值就能把内存护栏形同虚设
                                                 // （手机管线单首峰值约 3.3~4.3 倍文件大小——chunks + concat +
                                                 //  标签 concat + base64 串同时在世）
// 大文件按保守 USB 速率（2MB/s）放宽推送预算：固定 3 分钟会让 150MB 的 24bit 无损每次都稳定超时，
// 于是被当成断连征兆白重推两遍（单首 ≈600MB 无效 USB 流量），且每次都是 3 分钟的 spawnSync 阻塞
const audioPushTimeout = (bytes) => {
  const need = Math.ceil((Number(bytes) || 0) / (2 * 1024 * 1024)) * 1000
  return Math.max(AUDIO_PUSH_TIMEOUT, need + 30 * 1000)
}
/** 内存护栏：基线 → 按接口 size 放宽 → 绝对天花板封顶（size 缺失时不误伤超长无损） */
const audioMaxBytes = (declaredSize) =>
  Math.min(MAX_AUDIO_BYTES_CEIL, Math.max(MAX_AUDIO_BYTES, (Number(declaredSize) || 0) * 1.1 + 1024 * 1024))

// ---- 设备断连/接触不良容错 ----
// USB 断触的典型形态是几秒内自行恢复；恢复窗口内从内存 buffer 重推（不重新下载），
// 超过宽限仍不在线才中止整批——继续逐首失败只会把剩余每首都完整下载进内存再推失败，
// 白烧几百次网易请求（600 首歌单断线 = 600 次无效取流）。
const RECONNECT_GRACE_MS = 10 * 1000  // 单轮恢复宽限：USB 重枚举通常 1~3s，10s 留足余量
const RECONNECT_ROUNDS = 2            // 最多两轮宽限（首推失败 → 等→重推 → 再失败 → 等→重推 → 中止），
                                      // 上限 20s——"恢复后又断"的极限接触不良不会把一首拖成分钟级
// 可注入的运行参数（单测缩短宽限用；运行时勿动）
const tuning = { graceMs: RECONNECT_GRACE_MS, rounds: RECONNECT_ROUNDS }
// adb 对断连的报错形态（stderr 原文）：device 'SER' not found / device offline / device
// unauthorized / device still connecting / device not responding / error: closed /
// no devices/emulators found / waiting for device / more than one device（状态错乱）；
// pushBuffer 的"设备端写入失败: <stderr>"包裹原文后仍能被同一正则命中。
// 传输层故障一并纳入：adb: transport error / protocol fault / cannot connect to daemon ——
// 这些同样是 USB/线缆/驱动层的问题，此前落在正则外被判终态，600 首歌单会逐首白烧取流。
// 另有两条不上文案的暗号：spawnSync 层异常（ETIMEDOUT 等）与空输出异常退出（进程死），由
// core/adb 打 deviceSuspect 标记——传输停滞型断连（USB 半死、adb 挂到超时）没有 stderr 可匹配
const DEVICE_ERR_RE = /device[^\n]*(not found|offline|unauthorized|still connecting|not responding)|error: closed|no devices|waiting for device|more than one device|transport error|protocol fault|cannot connect to daemon|failed to (start|check server)|device still authorizing/
// md5 不符 = 传输损坏，USB 接触不良时高发：buffer 还在内存里，重推零成本
const MD5_ERR_RE = /md5 校验不符/
// adb 可执行文件本身消失（platform-tools 被隔离/移动、PATH 变动）：环境故障而非断连，
// 重推与等设备都没用，但**绝不能**继续逐首——否则剩余每首都会完整下载进内存再失败
const isAdbMissingErr = (e) => Boolean(e && e.noAdb)
const isRetriablePushErr = (e) =>
  (e && e.deviceSuspect) ||
  DEVICE_ERR_RE.test((e && e.message) || '') ||
  MD5_ERR_RE.test((e && e.message) || '')
/** 设备/ADB 已不可用且重推无望：中止整批的信号（与 deviceGone 同义，供调用方统一识别） */
const isBatchAbortErr = (e) => Boolean(e && (e.deviceGone || e.noAdb))

// 索引写失败告警去重（按目录）：逐首成功都会合并写索引，持续性失败只告警一次（与 storage 同口径）
const idxWriteWarned = new Set()
// 设备端索引临时名的进程内序号（配合 pid 保证跨进程不撞名，见 mergeIndexFile）
let idxTmpSeq = 0

/** 等设备重新就绪：到期前每 ≤500ms 重探（status 有缓存，必须先失效）；恢复返回 true。
 *  signal 透传给 sleep——任务取消不必等宽限走完 */
async function waitForDevice(graceMs, signal) {
  const deadline = Date.now() + graceMs
  for (;;) {
    adbSvc.invalidate()
    const st = adbSvc.status()
    if (st && st.state === 'ready') return true
    if (Date.now() >= deadline) return false
    await sleep(Math.min(500, Math.ceil(graceMs / 4)), signal)
  }
}

/**
 * 设备直写的统一入口（音频/歌词都走这里）：失败先分级——设备类/md5 类错误给恢复宽限
 * （每轮等设备回来就从内存 buffer 重推，不重新下载；最多两轮）；宽限内不回来则抛
 * deviceGone（调用方中止整批）。非设备类错误原样上抛（不重试，与全项目"终态不重试"口径一致）
 */
async function pushToDevice(buf, remotePath, { signal, timeoutMs } = {}) {
  let last
  for (let attempt = 0; attempt <= tuning.rounds; attempt++) {
    // 每轮开头都要查取消：此前只在 waitForDevice 之后查，而 waitForDevice 之前的第一次
    // pushBuffer 是同步 spawnSync（最长 PUSH_TIMEOUT=30s，期间事件循环被占满，
    // 连 DELETE /api/job/:id 都解析不了）。取消若恰好落在"音频推完、歌词还没推"之间，
    // 那次 .lrc 推送仍会跑满 30 秒，用户点完取消界面毫无反应
    throwIfCancelled(signal)
    try {
      adb.pushBuffer(buf, remotePath, timeoutMs ? { timeoutMs } : undefined)
      if (attempt > 0) logger.log('phone', `设备已恢复，重推成功: ${remotePath}`)
      return
    } catch (e) {
      if (!isRetriablePushErr(e)) {
        // 终态失败（设备端"磁盘已满"等）此前只活在内存卡片里，重启即蒸发——必须落盘留痕
        logger.error('phone', `推送失败（终态不重试）: ${remotePath} — ${e.message}`)
        throw e
      }
      last = e
    }
    if (attempt < tuning.rounds) {
      logger.log('phone', `推送失败（${last.message}），等待设备恢复（≤${Math.round(tuning.graceMs / 1000)}s，第 ${attempt + 1}/${tuning.rounds} 轮）: ${remotePath}`)
      const back = await waitForDevice(tuning.graceMs, signal)
      throwIfCancelled(signal)
      if (!back) break
    }
  }
  const e = new Error(`手机已断开连接，任务中止（等待恢复超时）：${last.message}`)
  e.deviceGone = true
  throw e
}

/**
 * 列出目的地根下的既有批次目录名（用于 " (n)" 去重与批次目录复用）。
 * 根目录不存在/暂不可读不是致命故障——按"无既有目录"继续，下面的 mkdir -p 会把它建回来
 * （与 storage.createBatchDir 的 mkdirSync(recursive) 自愈口径一致）。
 * 只有 adb 本身不可用才上抛：那不是目录问题，等设备/等重推都无意义，交给上层中止整批。
 */
function listDirsTolerant(root) {
  try {
    return new Set(adb.listDirs(root))
  } catch (e) {
    if (isAdbMissingErr(e)) throw e
    logger.error('phone', `目的地根目录扫描失败（按无既有批次目录处理）: ${root} — ${core.error.errMsg(e)}`)
    return new Set()
  }
}

/** 设备端基础名清洗与命名分配的唯一出处仍是 storage.batchStem / naming.assignBaseNames */
function createBatchDir(base, name, type = 'timestamp', ownerId = null) {
  const root = base.replace(/\/+$/, '')
  const stem = storage.batchStem(name, ownerId)
  // 同 stem 已存在（如旧目录 marker 类型不符被 findBatchDir 拒认、榜单同名重跑）时追加 " (n)"，
  // 与 storage.createBatchDir 的口径逐字一致——手机侧静默复用同名目录会覆盖旧 marker，
  // 且两批歌混进同一目录后增量对账必然互相污染
  const dirs = listDirsTolerant(root)
  let leaf = stem
  let n = 2
  while (dirs.has(leaf)) leaf = `${stem} (${n++})`
  const dir = `${root}/${leaf}`
  adb.mkdirP(dir)
  const marker = JSON.stringify({ type, name: name || null, ownerId: ownerId == null ? null : String(ownerId), at: new Date().toISOString() })
  try {
    adb.pushBuffer(Buffer.from(marker, 'utf8'), `${dir}/${storage.MARKER}`, { timeoutMs: PUSH_TIMEOUT })
  } catch (e) {
    // 标记失败不阻塞建任务（与 storage.createBatchDir 同口径），但要有痕：事后无法解释"为什么重复下载了"。
    // 设备类/adb 缺失除外——那不是"标记写不进去"，而是设备根本不在，此刻建出来的任务注定失败：
    // 标成批次中止信号交给 job 层如实回 400（否则它会带着陈旧的 5s 就绪缓存开跑，
    // 首首扫描就炸，报出原始 adb 英文串而不是"手机已断开"）
    logger.error('phone', `.ncm-batch.json 来源标记写入失败（增量认领精确性受损）: ${dir} — ${core.error.errMsg(e)}`)
    if (isBatchAbortErr(e) || DEVICE_ERR_RE.test((e && e.message) || '')) {
      const err = new Error(`手机已断开连接，批次未开始: ${core.error.errMsg(e)}`)
      err.deviceGone = true
      throw err
    }
  }
  return dir
}

/** 复用批次目录的查找规则与 storage.findBatchDir 逐字一致（含旧目录无 id 后缀的回退） */
function findBatchDir(base, name, type = 'playlist', ownerId = null) {
  if (!name) return null
  const root = base.replace(/\/+$/, '')
  let dirs
  try { dirs = listDirsTolerant(root) } catch (e) { return null }
  const candidates = [storage.batchStem(name, ownerId)]
  const plain = storage.batchStem(name)
  if (plain !== candidates[0]) candidates.push(plain) // 旧目录：只有歌单名、没有 id 后缀
  for (const stem of candidates) {
    if (!dirs.has(stem)) continue
    const dir = `${root}/${stem}`
    let marker
    try {
      marker = JSON.parse(adb.readText(`${dir}/${storage.MARKER}`))
    } catch { /* 无/坏标记 = 旧版本产物，保持向后兼容 */ return dir }
    if (marker && marker.type && marker.type !== type) continue
    if (marker && marker.ownerId != null && String(marker.ownerId) !== String(ownerId)) continue
    return dir
  }
  return null
}

/** 设备目录清单 → storage.scanDir 同形状（audio: Map<base, Set<ext>>，lrc: Set<base>） */
function scanDir(dir) {
  const audio = new Map()
  const lrc = new Set()
  for (const name of adb.listFiles(dir)) {
    const dot = name.lastIndexOf('.')
    if (dot <= 0) continue
    const ext = name.slice(dot + 1).toLowerCase()
    const base = name.slice(0, dot)
    if (ext === 'mp3' || ext === 'flac') {
      if (!audio.has(base)) audio.set(base, new Set())
      audio.get(base).add(ext)
    } else if (ext === 'lrc') {
      lrc.add(base)
    }
  }
  return { audio, lrc }
}

/** 读设备端 id→基础名索引（格式/容错与 storage.readIndexFile 一致：无文件 = 空索引；
 *  读到了但解析失败 = 损坏，落日志与"无文件"区分开） */
function readIndexFile(dir) {
  const map = new Map()
  let text = null
  try {
    text = adb.readText(`${dir}/${storage.INDEX_NAME}`)
  } catch { return map } // 无文件：首次认领旧目录，按名字规则跑并回填
  try {
    const raw = JSON.parse(text)
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [id, base] of Object.entries(raw)) {
        // 与 storage.readIndexFile 同口径：索引是唯一"被读取"的命名输入，
        // 手改/恢复的文件里的 "nul"、"a/b" 会打在保留设备名上或越出批次目录
        const safe = typeof base === 'string' ? core.download.sanitize(base) : ''
        if (safe) map.set(String(id), safe)
      }
    }
  } catch {
    logger.error('phone', `.ncm-index.json 损坏（JSON 解析失败），本次增量按歌名匹配: ${dir}`)
  }
  return map
}

/** 合并写索引（只增不删、无变化不落盘、失败告警去重）——与 storage.mergeIndexFile 同语义 */
function mergeIndexFile(dir, entries) {
  if (!dir || !entries) return false
  try {
    const merged = readIndexFile(dir)
    const pairs = (entries instanceof Map || Array.isArray(entries)) ? entries : Object.entries(entries)
    let dirty = false
    for (const [id, base] of pairs) {
      if (id === undefined || id === null || id === '') continue
      if (typeof base !== 'string' || !base) continue
      const k = String(id)
      if (merged.get(k) === base) continue
      merged.set(k, base)
      dirty = true
    }
    if (!dirty) return true
    // 先推 .tmp 再 mv 覆盖：pushBuffer 的失败路径会 rm 目标路径——直接写索引名时，
    // 一次推送失败就会把设备端原有的整份历史索引删掉（id→base 全丢，增量退回按名匹配）。
    // .tmp 扩展名不会被 scanDir 认作歌；推送成功后 mv 失败则清掉 tmp 再上抛，原索引无损
    // 临时名必须带 pid+序号（与 storage.mergeIndexFile 同）：固定名时两个写入方
    // （第二个服务实例、tools/phone-fill.js 指向同一目录）会互相覆盖 tmp，
    // A 的 mv 把 B 的内容搬成正式索引，A 刚 flush 的 10 条就此丢失
    const tmpPath = `${dir}/${storage.INDEX_NAME}.${process.pid}.${++idxTmpSeq}.tmp`
    const target = `${dir}/${storage.INDEX_NAME}`
    adb.pushBuffer(Buffer.from(JSON.stringify(Object.fromEntries(merged)), 'utf8'), tmpPath, { timeoutMs: PUSH_TIMEOUT })
    try {
      adb.shell(`mv ${adb.shq(tmpPath)} ${adb.shq(target)}`)
    } catch (e) {
      try { adb.rm(tmpPath) } catch { /* 清不掉则留给下次合并覆盖 */ }
      throw e
    }
    idxWriteWarned.delete(dir)
    return true
  } catch (e) {
    // 逐首成功都会合并写索引：同一目录的持续性失败只告警一次（恢复成功即清零），不刷屏。
    // 设备类/adb 缺失不参与去重——那往往正是断连的第一个现场，去重会把"手机什么时候掉的"
    // 这条唯一线索吞掉，用户只看到后面某首歌的一句无关推送失败
    const dev = isBatchAbortErr(e) || (e && e.deviceSuspect) || DEVICE_ERR_RE.test((e && e.message) || '')
    if (dev || !idxWriteWarned.has(dir)) {
      logger.error('phone', `.ncm-index.json 写入失败，增量认领将退回按歌名匹配: ${dir} — ${core.error.errMsg(e)}`)
      idxWriteWarned.add(dir)
    }
    return false
  }
}

/** 歌词推送（翻译合并口径与 saveLyric 一致）；无可写歌词返回 null，失败抛错由调用方容错 */
async function pushLyric(songId, dir, base, signal) {
  const { lrc, tlyric } = await core.retry.withRetry(
    () => core.lyric.get(songId),
    { retries: 0, timeoutMs: naming.TIMEOUTS.LYRIC },
  )
  const merged = core.lyric.mergeTranslation(lrc, tlyric)
  if (!merged) return null
  const remote = `${dir}/${base}.lrc`
  await pushToDevice(Buffer.from(merged, 'utf8'), remote, { timeoutMs: PUSH_TIMEOUT, signal })
  return remote
}

/**
 * 内存取流（带字节进度）：fetchBuffer 不吐进度，而任务卡片的字节进度条依赖 onProgress——
 * 用 reader 手动攒 buffer，进度语义与本地管线 streamTo 对齐（received/total/percent）
 * @param signal 可选的外部取消信号（任务取消在取流阶段即时生效）：util.mergeSignals 与超时合并
 * @returns { buf, received, total, encoded } encoded = 响应带 content-encoding（CDN 透明压缩）：
 *   此时 content-length 是压缩字节数、实收是解压后字节数，两者必然不等——调用方的
 *   截断/大小校验必须跳过（util.assertIntegrity 统一处理，两条管线共用一份）
 */
async function fetchBufferWithProgress(url, { timeoutMs = naming.TIMEOUTS.DOWNLOAD, maxBytes, onProgress, signal } = {}) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const resp = await fetch(url, { signal: mergeSignals(signal, timeoutSignal) })
  if (!resp.ok || !resp.body) throw new Error(`下载失败: HTTP ${resp.status}`)
  const total = Number(resp.headers.get('content-length')) || 0
  const encoded = resp.headers.get('content-encoding')
  const chunks = []
  let received = 0
  const reader = resp.body.getReader()
  // 抛错前必须取消 reader：连接与已缓冲数据否则悬挂到 undici 超时才被回收
  const stop = async (e) => {
    try { await reader.cancel() } catch { /* 已结束则无事 */ }
    throw e
  }
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      received += value.length
      if (maxBytes && received > maxBytes) await stop(new Error(`内容过大: ${received}B`))
      if (onProgress) {
        try { onProgress({ received, total, percent: total ? Math.floor((received / total) * 100) : 0 }) } catch { /* 观察回调不影响下载 */ }
      }
    }
  } catch (e) {
    await stop(e)
  }
  return { buf: Buffer.concat(chunks), received, total, encoded: Boolean(encoded) }
}

/**
 * 手机侧落盘后端：内存取流 → 内存打标签（embedError 容错）→ base64 管道直写（md5 校验 +
 * 断连宽限重推）。平台差异全部封在这里，骨架（pipeline.runBatch）只消费统一形状。
 */
function createAdbSink(dir) {
  const d = String(dir || '').replace(/\/+$/, '')
  // 运行时刻现状清单：skipIfExists 与"绝不覆盖"以它为准（prepare/scanExisting 时刷新，
  // 落盘后 noteStored/noteLyric 手动跟进——设备端没有廉价的逐首实时查询）
  let present = null
  // 索引批次缓冲：逐首 mergeIndexFile 每首要 1~2 次 spawnSync（读旧索引+写新），600 首累计
  // 约 1 分钟纯索引 IO。内存攒批、每 10 首刷一次 + 收尾兜底刷一次——进程崩溃最多丢 9 首的
  // 精确认领（退回按名匹配、可自愈），换来约 10 倍的设备端索引 IO 削减
  const pendingIdx = []
  const flushIdx = () => {
    if (!pendingIdx.length) return
    const batch = pendingIdx.splice(0, pendingIdx.length)
    mergeIndexFile(d, batch)
  }
  return {
    kind: 'phone',
    logTag: 'phone',
    prepare() {
      // 运行时刻复查设备在线：建任务入口查过一次，但任务可能排队很久——拔线后逐首失败
      // 不如整体快速失败。必须先 invalidate：就绪态缓存 5s，排队期间掉线的设备会被这份陈旧
      // 缓存放行，然后首首扫描就炸（报原始 adb 英文串而不是"手机已断开"）。
      // status 自身抛错（如 adb 缺失的边缘）不拦任务，交给后面的逐首错误呈现
      try {
        adbSvc.invalidate()
        const st = adbSvc.status()
        if (st && st.state !== 'ready') throw new Error('手机已断开（' + st.message + '），任务终止')
      } catch (e) { if (e && /手机已断开/.test(e.message)) throw e }
      // 目录可能在排队期间被用户删掉（SD 卡重插/清理）：本地管线每首 mkdirSync 自愈，设备侧同样兜一次。
      // 放在现状扫描之前——目录不存在时 find 会抛，而推送是直接重定向到终路径的，
      // 父目录缺失属于终态错误（非可重试），600 首歌单会逐首白烧一次取流
      try { adb.mkdirP(d) } catch (e) {
        if (isBatchAbortErr(e) || DEVICE_ERR_RE.test((e && e.message) || '')) {
          // 设备类/adb 缺失：目录建不出来 = 后续每首的推送都必然失败，立刻中止整批
          //（继续跑下去就是每首完整下载进内存再失败，正是本管线存在的理由要防的事）
          const err = new Error(`手机已断开连接，任务中止（批次目录不可达）: ${core.error.errMsg(e)}`)
          err.deviceGone = true
          throw err
        }
        logger.error('phone', `批次目录创建失败: ${d} — ${core.error.errMsg(e)}`)
      }
    },
    scanExisting() {
      // 目录读不到不是致命故障：按"空现状"继续，与 storage.scanDir（读不到返回空索引）同口径；
      // 未捕获的话一个 find 失败会掀掉整批，任务卡只留一句原始 adb 串、一首都没下
      try {
        present = scanDir(d)
      } catch (e) {
        if (isAdbMissingErr(e)) throw e
        logger.error('phone', `批次目录现状扫描失败（按空目录继续，本批不覆盖任何已有文件）: ${d} — ${core.error.errMsg(e)}`)
        present = { audio: new Map(), lrc: new Set() }
      }
      return present
    },
    audioPath(base, ext) { return `${d}/${base}.${ext}` },
    existedSize() { return null }, // 设备端没有廉价的尺寸查询，existed 记账不带 size
    async storeAudio(resolved, { base, song, cover, mime, signal, onProgress }) {
      const ext = resolved.ext
      const filepath = `${d}/${base}.${ext}`
      // 取流（内存、带字节进度）+ 截断/大小校验（util.assertIntegrity 与本地管线共用）：
      // 断流属瞬时错误值得重试；内存上限按 resolve 宣称的 size 动态放宽（超长无损不再被 64MB 基线一刀切拒之门外）
      const audio = await core.retry.withRetry(
        async () => {
          const r = await fetchBufferWithProgress(resolved.url, {
            timeoutMs: naming.TIMEOUTS.DOWNLOAD,
            maxBytes: audioMaxBytes(resolved.size),
            signal,
            onProgress,
          })
          assertIntegrity({ received: r.received, total: r.total, expected: resolved.size, encoded: r.encoded, url: resolved.url })
          return r.buf
        },
        { retries: 1, backoffMs: 800, shouldRetry: (e) => core.error.isTransient(e),
          onRetry: (e, i) => logger.log('phone', `第 ${i + 1} 次取流失败（瞬时错误），重试: ${song.name || song.id} — ${core.error.errMsg(e)}`) },
      )
      // 打标签失败不得吃掉已经下好、已经付费的音频（与本地管线 embedError 同口径）：
      // FLAC 首块非 STREAMINFO 这类合法文件不能整首丢失。退路仍要过 verifyAudioHead：
      // 原样音频本身若不是合法音频，照旧整首失败（不能推坏文件上设备）
      let tagged = audio
      let embedError = null
      try {
        tagged = ext === 'flac'
          ? core.tag.embedFlacBuf(audio, { title: song.name, artist: song.artist, album: song.album, cover, mime })
          : core.tag.embedMp3Buf(audio, { title: song.name, artist: song.artist, album: song.album, cover, mime })
        core.tag.verifyAudioHead(tagged)
      } catch (e) {
        embedError = core.error.errMsg(e)
        logger.error('phone', `标签内嵌失败（音频原样写入，不丢整首）: ${song.name || song.id} — ${embedError}`)
        tagged = audio
        core.tag.verifyAudioHead(tagged)
      }
      await pushToDevice(tagged, filepath, { signal, timeoutMs: audioPushTimeout(tagged.length) })
      return { filepath, size: tagged.length, embedError }
    },
    async writeLyric(songId, base, signal) {
      return pushLyric(songId, d, base, signal)
    },
    mergeIndex(pairs) {
      pendingIdx.push(...pairs)
      if (pendingIdx.length >= 10) flushIdx()
    },
    flushIndex: flushIdx,
    // 增量回填用（incremental.run 开头全量回填）：立即写（不走批次缓冲——空计划早退后
    // 缓冲里的回填会丢）；dirExists 对设备错误容错返回 false，对 adb 缺失由调用方兜
    dirExists(d) {
      try { return adb.dirExists(d) } catch { return false }
    },
    writeIndexFile(d, pairs) { mergeIndexFile(d, pairs) },
    noteStored(base, ext) {
      // 本批内后续同名避让与补下判定以已落盘现状为准；该 base 已有其他扩展名时合并而非覆盖
      //（音质补下 base 已有 mp3、补 flac 落盘后 mp3 信息不得从内存清单丢失）
      if (!present) return
      const existing = present.audio.get(base)
      if (existing) existing.add(ext)
      else present.audio.set(base, new Set([ext]))
    },
    noteLyric(base) { if (present) present.lrc.add(base) },
    isBatchAbort(e) { return isBatchAbortErr(e) },
  }
}

/**
 * 批量直写（手机管线）：统一骨架 service/pipeline.runBatch + adbSink。
 * 旧版的手写循环（重复引用预筛/命名分配/封面 LRU/断连中止契约）全部在骨架里，
 * 与本地管线共用一份；本函数只负责目录参数与后端装配。
 */
async function downloadMany(songs, opts = {}) {
  const dir = String((opts && opts.dir) || '').replace(/\/+$/, '')
  if (!dir) throw new Error('phone.downloadMany 需要 dir（设备端批次目录）')
  return pipeline.runBatch(songs, opts, createAdbSink(dir))
}

/** 补歌词（plan.fill 的歌只推 .lrc，不动音频）；签名与旧版一致（song, dir, base, signal），
 *  实现在 incremental.fillLyric（backend 注入手机侧）——deviceGone 上抛语义不变 */
async function fillLyric(song, dir, base, signal) {
  return incremental.fillLyric(song, dir, base, signal, createAdbSink(dir))
}

/**
 * 执行增量计划（手机目的地版）：与 incremental.run 同形状——
 * 索引全量回填 → downloadMany 直写缺失音频 → 逐首补缺失歌词。
 * 显式传本模块的 downloadMany（运行时读 exports：单测对 svc.phone.downloadMany 的桩生效）
 */
function run(plan, opts = {}, cbs = {}) {
  return incremental.run(plan, {
    ...opts,
    backend: createAdbSink(opts.dir),
    downloadMany: module.exports.downloadMany,
  }, cbs)
}

module.exports = {
  createBatchDir, findBatchDir, scanDir, readIndexFile, mergeIndexFile, downloadMany, fillLyric, run,
  pushToDevice, _tuning: tuning,
}
