/**
 * 命名与产物规则（唯一出处）：
 *  - 文件命名：sanitize/baseNameOf/assignBaseNames——下载落盘与增量匹配共用同一份分配，
 *    改命名只改这里（决策 11/13/42/78 的全部行为锁在本文件）
 *  - 歌词写盘：saveLyric（取词 → 合并翻译 → 原子落盘）
 *  - 封面取回：fetchCover（按魔数判型）+ coverCache（批次级 LRU，按 picUrl 去重）
 * 独立成模块的原因：统一批量骨架（pipeline.js）与本地/手机两个落盘后端都要用这些规则，
 * 而骨架又落在 download.js 的导出后面——不拆开会形成循环依赖。
 */
const fs = require('fs')
const path = require('path')
const core = require('../core')
const storage = require('./storage')

const DOWNLOAD_TIMEOUT = 10 * 60 * 1000 // 真正的音乐下载：单文件超时 10 分钟（这是唯一允许慢的环节）
const RESOLVE_TIMEOUT = 12 * 1000       // 解链：12 秒（2026-10-02 实测直连 TLS 握手 ~3.8s、中位数 4~6s，留 2~3 倍余量；阶梯最多 2 次）
const LYRIC_TIMEOUT = 3 * 1000          // 歌词：3 秒（实测 ~160ms），取不到就跳过（可选项不值得久等）
const COVER_TIMEOUT = 10 * 1000         // 封面：10 秒（实测 ~170ms/371KB；封面是体积波动最大的一环，慢网多留余量）
// 两条落盘管线（本地 fs / 手机 adb）复用同一组分步上限：策略参数唯一出处，勿在彼处另抄一份
const TIMEOUTS = { DOWNLOAD: DOWNLOAD_TIMEOUT, RESOLVE: RESOLVE_TIMEOUT, LYRIC: LYRIC_TIMEOUT, COVER: COVER_TIMEOUT }

/** 文件名非法字符清洗（core.download.sanitize 的转发：命名规则的入口统一在本模块） */
const sanitize = (name) => core.download.sanitize(name)

/**
 * 歌曲在磁盘上的基础文件名（不带扩展名）——命名规则的唯一出处：
 * 下载落盘（两条管线）与增量匹配（incremental）都从它取，改命名只改这里
 */
function baseNameOf(song) {
  return sanitize(song.name) || String(song.id)
}

/**
 * 名字比较键：NTFS 与 Android ext4/f2fs 都是**大小写不敏感**的，而 Set.has 是大小写敏感的。
 * 不折叠的后果（决策 78）：歌单里已有 `Hello World.mp3`，再遇到一首 `hello world` 时
 * `taken.has('hello world')` 为 false → 分到 base 'hello world' → plan 判它需下载 →
 * existsSync 在大小写不敏感盘上返回 true → 走了 existed 分支"同音质已存在"，
 * **这首歌永远不会被下载**，而日志与报告都断言它在。每轮增量都重复，且不会自愈。
 * 与 dest.sameLocalPath 的路径比较口径一致。
 */
const nameKey = (s) => (process.platform === 'win32' ? String(s).toLowerCase() : String(s))

/** 目标目录里已被占用的基础名（音频+歌词，不分扩展名）：命名分配时一律避开，绝不覆盖已有文件 */
function takenBases(dir) {
  const idx = storage.scanDir(dir)
  return new Set([...idx.audio.keys(), ...idx.lrc])
}

/**
 * 为一批歌曲分配落盘基础文件名（不带扩展名）。两条规则：
 *  1. 同批次内同名歌（清洗后同基础名）为一组，**全组都加" - 歌手"后缀**（产品拍板：两首都加，
 *     不只第二首）；单独一首且名字未被占用时仍是纯歌名
 *  2. 绝不与 taken（磁盘已有产物基础名，多为增量复用目录）重名
 * 极端重名（同名同歌手，如歌单里重复收录）在后面再追加 " (n)" 序号。
 * 磁盘上已有同基础名（纯歌名或"歌名 - 歌手"形态）的歌视为"已存在"，直接认领那个名字——
 * 旧版纯歌名命名的产物在本规则下仍能被增量认出，不会重下。
 * 返回 Map<song, base>（按传入的歌曲对象为键，调用方传入同一批对象即可取回）。
 * @param claimedPreseed 可选：视为"已被认领"的基础名预置集合（incremental.plan 的 id 命中 base）。
 *   这些名字属于按 id 认领的歌，别的歌既不能认领也不得复用——否则新歌字面名恰好等于某个
 *   "(n)" 形态的历史 base 时会在认领阶段抢走它，把旧文件误判成自己的"已存在"而永久跳过
 */
function assignBaseNames(songs, taken = new Set(), claimedPreseed = null) {
  // 不污染调用方传入的 Set：序号分配要在本批内稳定，跨批复用同一 Set 不得被上批的分配污染
  taken = new Set(taken)
  // 存在性判定一律走折叠键（决策 78：NTFS/ext4 大小写不敏感，Set.has 大小写敏感）。
  // 取值仍保留原始大小写——写出去的文件名必须与歌名一致，只是"占没占过"按盘上的规矩判
  const takenKeys = new Set([...taken].map(nameKey))
  // 折叠键 → 磁盘实际写法：认领磁盘上已有的名字时必须返回**磁盘上那个写法**。
  // 认领的语义就是"那个文件就是这首歌"，返回 API 的大小写会让记账与磁盘名错位
  // （NTFS 上两者指向同一文件，但 scanDir 回的是磁盘写法，索引记的却是 API 写法）
  const diskSpelling = new Map([...taken].map((n) => [nameKey(n), n]))
  // 原始同名计数（认领前）：pending 被认领拆小后 group.length 会缩水，必须看原始数，
  // 否则同名同歌手/同名不同歌手的第二首会退回纯歌名，与 "(n)" 序号系列脱钩
  const rawCounts = new Map()
  for (const s of songs) {
    const raw = baseNameOf(s)
    const k = nameKey(raw)
    rawCounts.set(k, (rawCounts.get(k) || 0) + 1)
  }
  const artistBaseOf = (s) => {
    const artist = sanitize(s.artist || '')
    return artist ? `${baseNameOf(s)} - ${artist}` : ''
  }
  const assigned = new Map()
  const pending = []
  // 先认领：磁盘上已有的（两种命名形态都认），保持原文件名不动。先认先得——
  // 两首同名歌只有第一首能认领磁盘上的同名旧文件，第二首进 pending 拿带歌手的新名字
  //（否则它会被误判为"已存在"而跳过，正是本次要修的误跳过问题）
  const claimed = new Set([...(claimedPreseed || [])].map(nameKey))
  const seen = new Set()
  for (const s of songs) {
    // 同一对象引用在数组里出现两次时，本函数用 Map<对象, 文件名> 返回结果，只能存一份——
    // 第二处会静默覆盖第一处的文件名，批次内两首歌写进同一个文件。宁可显式报错也不能悄悄覆盖
    if (seen.has(s)) {
      throw new Error(`assignBaseNames: 歌曲数组含重复对象引用（id=${s.id}），无法为两次出现分配不同文件名`)
    }
    seen.add(s)
    const raw = baseNameOf(s)
    const withArtist = artistBaseOf(s)
    if (takenKeys.has(nameKey(raw)) && !claimed.has(nameKey(raw))) {
      // 认领：返回磁盘上的实际写法（决策 78），不是 API 给的大小写
      assigned.set(s, diskSpelling.get(nameKey(raw)) || raw)
      claimed.add(nameKey(raw))
    } else if (withArtist && takenKeys.has(nameKey(withArtist)) && !claimed.has(nameKey(withArtist))) {
      assigned.set(s, diskSpelling.get(nameKey(withArtist)) || withArtist)
      claimed.add(nameKey(withArtist))
    } else {
      pending.push(s)
    }
  }
  // 再分配：剩余的歌按基础名分组，同组全部加歌手后缀
  const groups = new Map()
  for (const s of pending) {
    const raw = baseNameOf(s)
    const k = nameKey(raw)
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(s)
  }
  for (const [, group] of groups) {
    const firstRaw = baseNameOf(group[0])
    // 同批同名组全组加歌手：看原始同名数（rawCounts），pending 被认领拆小后 group.length 会缩水；
    // takenKeys.has(raw) 保留（磁盘已有纯名时独名歌也要加后缀，绝不覆盖）
    const useArtist = group.length > 1 || (rawCounts.get(nameKey(firstRaw)) || 0) > 1 || takenKeys.has(nameKey(firstRaw))
    const used = new Set()
    for (const s of group) {
      const raw = baseNameOf(s)
      let base = useArtist ? (artistBaseOf(s) || raw) : raw
      // 序号探测同样走折叠键：磁盘上已有 `歌 (2).mp3` 而本批要发 `歌 (2)` 时，
      // 大小写不一致就会判定"没占过"，然后 existsSync 在大小写不敏感盘上返回 true
      if (takenKeys.has(nameKey(base)) || used.has(nameKey(base))) {
        let n = 2
        while (takenKeys.has(nameKey(`${base} (${n})`)) || used.has(nameKey(`${base} (${n})`))) n++
        base = `${base} (${n})`
      }
      used.add(nameKey(base))
      takenKeys.add(nameKey(base))
      diskSpelling.set(nameKey(base), base) // 同批内后续歌认领本批刚起的名字时也要拿到一致写法
      assigned.set(s, base)
    }
  }
  return assigned
}

/**
 * 取歌词并合并翻译后写入指定路径（两条管线的歌词写盘共用；文件名/位置由调用方给定）
 * @returns lrcFile 路径；无可写歌词返回 null；失败抛错由调用方决定容错
 */
async function saveLyric(songId, filepath) {
  const { lrc, tlyric } = await core.retry.withRetry(
    () => core.lyric.get(songId),
    { retries: 0, timeoutMs: LYRIC_TIMEOUT },
  )
  const merged = core.lyric.mergeTranslation(lrc, tlyric)
  if (!merged) return null
  // 歌词同样走原子替换（.part 临时名 + rename），与音频/标签/索引同一纪律：
  // 直接 writeFileSync 是"先截断再写"，磁盘满或进程被杀会留下半截 .lrc——
  // 而 scanDir 只看 .lrc 是否存在，下一轮增量就把这首歌判成"词已齐全"永久跳过，
  // 缺口再也不会被补。半截歌词比没有歌词更难发现（播放器显示得出来内容但是断的）
  const tmpPath = filepath + '.part'
  try {
    fs.writeFileSync(tmpPath, merged, 'utf8')
    fs.renameSync(tmpPath, filepath)
  } catch (e) {
    try { fs.unlinkSync(tmpPath) } catch { /* 清不掉留给启动清扫（只删 .part/.tagtmp） */ }
    throw e
  }
  return filepath
}

/** 取封面并按魔数判型（下载单曲与批次共用；批次层按 picUrl 去重后把结果传进后端） */
async function fetchCover(picUrl, { timeoutMs = COVER_TIMEOUT } = {}) {
  const coverUrl = picUrl + (picUrl.includes('?') ? '&' : '?') + 'param=1500y1500'
  const buf = await core.download.fetchBuffer(coverUrl, { timeoutMs })
  // CDN 返回格式常与 URL 后缀不符，按魔数判定实际格式（判型唯一出处 core.tag.sniffImageMime）
  const mime = core.tag.sniffImageMime(buf)
  if (!mime) throw new Error('封面内容异常')
  return { buf, mime }
}

/**
 * 批次级封面缓存（LRU 上限 40，util.createLruCache）：按 picUrl 去重，同专辑的歌共用一次请求；
 * 失败也缓存（批次级短暂标记，批次结束即丢弃），避免同坏封面每首重试；
 * 偶发抖动至多让本批同 picUrl 余歌缺封面，下一批重新拉取即恢复
 */
function coverCache() {
  const { createLruCache } = require('./util')
  return createLruCache((picUrl) => fetchCover(picUrl))
}

module.exports = {
  TIMEOUTS, sanitize, baseNameOf, nameKey, takenBases,
  assignBaseNames, saveLyric, fetchCover, coverCache,
}
