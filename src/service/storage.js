/**
 * 批次目录与下载目录的存储策略（service 层，从 server.js 下沉）
 * 目录命名 / 增量复用 / 来源标记 / 启动清扫——与 HTTP 无关，server 只做调用
 *
 * 来源标记（MARKER）：每个新建批次目录写入 .ncm-batch.json 记录来源类型，
 * 防止增量歌单把同名榜单/时间戳批次目录误认领为自己的（同名歌会被错误跳过）。
 * 无标记的旧目录视为"歌单命名目录"向后兼容（该形态历史上只有歌单会产生）。
 *
 * id→基础名 索引（INDEX_NAME）：批次目录落 .ncm-index.json，增量匹配优先按歌曲 id 认领历史文件名
 * （只凭歌名在"同名两首/旧文件属于已移出歌单的同名歌"等极端情况会认错）。只增不删：
 * 歌移出歌单条目保留不清理。读写见 readIndexFile / mergeIndexFile（损坏即退回名字匹配）。
 */
const fs = require('fs')
const path = require('path')
const core = require('../core')
const logger = require('./logger')

// 索引写失败告警去重（按目录）：逐首成功都会合并写索引，同一目录的持续性失败（只读盘/磁盘满）
// 只告警一次，恢复成功即清零——不然 600 首歌单会刷 600 条同样的错
const idxWriteWarned = new Set()
// 索引临时文件序号：同一进程内多次合并写不会撞名（与 pid 一起保证跨进程也不撞）
let idxTmpSeq = 0

const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
const MARKER = '.ncm-batch.json'
const INDEX_NAME = '.ncm-index.json'
const REPORT_NAME = '下载结果.txt'

/** 批次文件夹的时间戳：2026-10-01 14-30-05（Windows 文件名安全，不含冒号） */
function timestampName(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`
}

/** 批次目录名主干（不含 base 路径）：有名字用名字，否则时间戳；清洗 Windows 非法/保留名
 *  ownerId（如歌单 id）非空时追加到目录名里：仅靠歌单名会让两个同名歌单共用一个目录，
 *  A 的同名文件会把 B 的歌误判成"已存在"而跳过（实测：网易云"我喜欢的音乐"这类重名极常见）
 */
function batchStem(name, ownerId = null) {
  let stem = (name && core.download.sanitize(name)) || timestampName()
  // 兜底：清掉残留控制字符；Windows 保留设备名/结尾点或空格会让 mkdirSync 失败
  stem = stem.replace(/[\u0000-\u001f]/g, '')
  if (ownerId !== null && ownerId !== undefined && ownerId !== '') {
    stem = `${stem} [${core.download.sanitize(String(ownerId)).slice(0, 24)}]`
  }
  if (WIN_RESERVED.test(stem) || /[. ]$/.test(stem) || !stem) stem = '_' + stem
  return stem
}

/**
 * 为一批下载分配独立子目录，保证不同批次互不覆盖：
 * 给了名字（歌单名/榜单名）就用名字，否则用启动时间戳；已存在同名目录则自动加序号
 * @param type 来源类型（playlist/chart/timestamp），写入来源标记
 * @param ownerId 归属实体 id（歌单 id）。会进目录名与标记，防止同名不同歌单互相认领
 */
function createBatchDir(base, name, type = 'timestamp', ownerId = null) {
  const stem = batchStem(name, ownerId)
  let dir = path.join(base, stem)
  let n = 2
  while (fs.existsSync(dir)) dir = path.join(base, `${stem} (${n++})`)
  fs.mkdirSync(dir, { recursive: true })
  try {
    fs.writeFileSync(path.join(dir, MARKER), JSON.stringify({ type, name: name || null, ownerId: ownerId == null ? null : String(ownerId), at: new Date().toISOString() }))
  } catch (e) {
    // 标记失败不阻塞下载，只损失增量认领的精确性——但得有痕，不然事后无法解释"为什么重复下载了"
    logger.error('storage', `.ncm-batch.json 来源标记写入失败（增量认领精确性受损）: ${dir} — ${core.error.errMsg(e)}`)
  }
  return dir
}

/**
 * 增量歌单用：已存在与名字（+id）匹配的批次目录则返回它（否则 null，不新建）。
 * 只匹配首目录（忽略 "名字 (2)" 这类历史重名副本）——增量语义是"补全同一个歌单"。
 * 认领规则（按顺序试，带 id 的目录优先，再退回无 id 的旧目录）：
 *  1. 来源标记类型不符（榜单/时间戳批次）→ 不认领，继续试下一个候选
 *  2. 标记里有 ownerId 且与请求的不同 → 同名不同歌单，绝不认领
 *  3. 标记缺失或无 ownerId → 旧版本产物，按"歌单命名目录"向后兼容认领
 */
function findBatchDir(base, name, type = 'playlist', ownerId = null) {
  if (!name) return null
  const candidates = [batchStem(name, ownerId)]
  const plain = batchStem(name)
  if (plain !== candidates[0]) candidates.push(plain) // 旧目录：只有歌单名、没有 id 后缀
  for (const stem of candidates) {
    const dir = path.join(base, stem)
    if (!fs.existsSync(dir)) continue
    let marker
    try {
      marker = JSON.parse(fs.readFileSync(path.join(dir, MARKER), 'utf8'))
    } catch (e) {
      // 只有"文件不存在"才是旧版本产物（向后兼容认领）。文件在却读不出来/解析失败是**不可信**状态，
      // 此前一律当旧目录认领——而榜单或时间戳批次目录一旦与歌单同名就会被歌单误认领，
      // 歌单的歌被误判"已存在"而永久跳过，正是这个标记当初要防的跨来源污染
      if (e && e.code === 'ENOENT') return dir
      logger.error('storage', `批次标记不可读或已损坏（不认领该目录）: ${dir} — ${core.error.errMsg(e)}`)
      return null
    }
    // JSON 合法但不是对象（如 "null" / "123" / 数组）：同样不可信，不能让它穿过下面的类型校验
    if (!marker || typeof marker !== 'object' || Array.isArray(marker)) {
      logger.error('storage', `批次标记格式异常（不认领该目录）: ${dir}`)
      return null
    }
    if (marker.type && marker.type !== type) continue
    if (marker.ownerId != null && String(marker.ownerId) !== String(ownerId)) continue
    return dir
  }
  return null
}

/**
 * 启动清扫下载目录：只删 *.part、*.tagtmp（下载半成品与标签临时文件），
 * mp3 / flac / lrc / 来源标记 / id→基础名索引（.ncm-index.json）/ 批次结果报告与其余未知文件一律保留——
 * 用户顺手放的 txt 说明、封面等不得误删（索引被删只会退回名字匹配，但能留则留）。递归进入批次子目录（子目录本身保留）。
 */
function sweepDownloads(dir) {
  let removed = 0
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return 0 }
  for (const ent of entries) {
    const p = path.join(dir, ent.name)
    try {
      // 用 dirent 判断类型（不跟随链接）：符号链接/联接一律跳过，避免越界删除与死循环；
      // junction 在部分 Node 下报 isDirectory()=true，必须再用 lstat 确认（lstat 不跟随，联接报 symlink）
      if (ent.isSymbolicLink()) continue
      try {
        if (fs.lstatSync(p).isSymbolicLink()) continue
      } catch { continue }
      if (ent.isDirectory()) { removed += sweepDownloads(p); continue }
      if (!ent.isFile()) continue
      // .part/.tagtmp 是半成品；.ncm-index.json.<pid>.<n>.tmp 是索引合并写的临时名——
      // 同样是"我们自己造的、写坏了就是垃圾"的中间态，与半成品同口径清掉。
      // 其余（音频/歌词/标记/索引/报告/用户自放文件）一律保留，不做白名单删除
      if (!/\.part$/i.test(ent.name) && !/\.tagtmp$/i.test(ent.name) &&
          !new RegExp(`^${INDEX_NAME.replace(/\./g, '\\.')}\\..+\\.tmp$`).test(ent.name)) continue
      fs.unlinkSync(p)
      removed++
    } catch { /* 被占用等异常跳过，不阻塞启动 */ }
  }
  return removed
}

/**
 * 扫描批次目录，返回已有产物索引
 * 从 incremental 下沉到本模块：下载命名分配（download.assignBaseNames）也要读磁盘已有产物，
 * 放 storage 避免循环依赖；incremental 原样再导出，调用方不受影响
 * @returns { audio: Map<base, Set<ext>>, lrc: Set<base> }
 *   audio 按扩展名分桶（同一基础名可同时有 mp3 与 flac——音质补下共存），扩展名一律小写；
 *   目录不存在/不可读返回空索引。只认 mp3/flac/lrc——.ncm-index.json 等 json/标记文件天然不匹配，不会被当成歌
 */
function scanDir(dir) {
  const audio = new Map()
  const lrc = new Set()
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return { audio, lrc } }
  for (const ent of entries) {
    if (!ent.isFile()) continue
    const m = ent.name.match(/^(.*)\.(mp3|flac|lrc)$/i)
    if (!m) continue
    const base = m[1]
    // '.mp3' 这类无基础名的文件不索引（否则 taken 混入空串）；扩展名已小写，大小写混排共存
    if (!base) continue
    const ext = m[2].toLowerCase()
    if (ext === 'lrc') lrc.add(base)
    else {
      if (!audio.has(base)) audio.set(base, new Set())
      audio.get(base).add(ext)
    }
  }
  return { audio, lrc }
}

/**
 * 读批次目录的 id→基础名 索引（.ncm-index.json）。
 * 增量匹配的第一优先级：命中歌曲 id 就直接用它的历史基础名认领，
 * 彻底绕开"只凭歌名"在同名/移出歌单旧文件等极端情况下的误认。
 * 只增不删：歌移出歌单条目也保留（不清理），命中即认领、永不猜名。
 * 文件缺失 / 内容损坏 / 结构非法一律返回空 Map——退回名字匹配（历史行为），绝不抛错；
 * 损坏（读到了但解析失败）落一条日志，与"无文件"区分开，不然事后无法解释为什么按名字匹配。
 * @returns { Map<string, string> } String(id) → 基础文件名（不带扩展名）
 */
function readIndexFile(dir) {
  const map = new Map()
  let text = null
  try {
    text = fs.readFileSync(path.join(dir, INDEX_NAME), 'utf8')
  } catch { return map } // 无文件：首次认领旧目录，按名字规则跑并回填
  try {
    const raw = JSON.parse(text)
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return map
    for (const [id, base] of Object.entries(raw)) {
      // 索引里的基础名是全项目唯一"被读取而非被生成"的命名输入（本项目自己写的条目必然已清洗），
      // 手改或从别处恢复的文件里一个 "nul" / "a/b" 会让下游 path.join 打在 NUL 设备上
      // 或越出批次目录，而报错完全看不出跟索引有关。读取边界统一清洗一次
      const safe = typeof base === 'string' ? core.download.sanitize(base) : ''
      if (safe) map.set(String(id), safe)
    }
  } catch {
    logger.error('storage', `.ncm-index.json 损坏（JSON 解析失败），本次增量按歌名匹配: ${dir}`)
  }
  return map
}

/**
 * 合并写入 id→基础名 索引（只增不删）：已有条目原样保留，同 id 以新值为准（落盘名是唯一事实），
 * 新 id 追加。合并读改写，写失败静默返回 false——索引缺了只损失精确性，不值得让下载任务标错。
 * @param entries Map|普通对象|[[id, base], ...]
 * @returns {boolean} 是否写盘成功
 */
function mergeIndexFile(dir, entries) {
  if (!dir || !entries) return false
  try {
    const merged = readIndexFile(dir)
    // Map 与 [id, base] 数组都直接按对迭代；普通对象先转 [key, value]
    const pairs = (entries instanceof Map || Array.isArray(entries)) ? entries : Object.entries(entries)
    let dirty = false
    for (const [id, base] of pairs) {
      if (id === undefined || id === null || id === '') continue
      // 索引里的基础名也要过一遍清洗：它是唯一"被读取而非被生成"的命名输入，
      // 手改或从别处恢复的 .ncm-index.json 里一个 "nul"/"a/b" 会让 path.join 越出批次目录，
      // 或在 Windows 上 ENOENT，而报错完全看不出跟索引有关（本项目自己写的条目必然已清洗）
      const safeBase = typeof base === 'string' ? core.download.sanitize(base) : ''
      if (!safeBase) continue
      const k = String(id)
      // 与现有值一致就不算变更：重复批次每首白白重写一遍整份索引，只在真有变化时落盘
      if (merged.get(k) === safeBase) continue
      merged.set(k, safeBase)
      dirty = true
    }
    if (!dirty) return true // 已是最新（含索引本就不存在且无有效条目）：不落盘
    // 先写 .tmp 再改名覆盖：直接写索引名时，进程在写入中途被杀/磁盘满会留下截断 JSON
    // （下次增量退回按名匹配）；rename 是原子动作——旧索引要么完整保留、要么整体被替换。
    // .tmp 不会被 scanDir 认作歌（扩展名 tmp），改名失败清掉 tmp 再上抛。
    // 临时名带 pid+序号：固定名在"两个进程写同一批次目录"时会互相抢同一个 tmp——
    // 防双开是本服务的既有场景（instance.stopOldService 就为此存在），stop.js 也会加载本模块
    const tmpPath = path.join(dir, `${INDEX_NAME}.${process.pid}.${++idxTmpSeq}.tmp`)
    fs.writeFileSync(tmpPath, JSON.stringify(Object.fromEntries(merged)), 'utf8')
    try {
      fs.renameSync(tmpPath, path.join(dir, INDEX_NAME))
    } catch (e) {
      try { fs.unlinkSync(tmpPath) } catch { /* 清不掉留给下次覆盖 */ }
      throw e
    }
    idxWriteWarned.delete(dir)
    return true
  } catch (e) {
    if (!idxWriteWarned.has(dir)) {
      logger.error('storage', `.ncm-index.json 写入失败，增量认领将退回按歌名匹配: ${dir} — ${core.error.errMsg(e)}`)
      idxWriteWarned.add(dir)
    }
    return false
  }
}

/**
 * 写批次结果报告（下载结果.txt）：任务日志只存内存、重启即没，
 * 每个批次收尾时在批次文件夹里落一份纯文本，供事后翻查（尤其挂机大歌单后核对失败明细）。
 * 纯写入失败不抛错（报告缺了不值得让任务标错）。
 */
function writeBatchReport(dir, { label, br, summary }) {
  try {
    // 老数据兼容：existed/noLyric 缺失视为 0（不占篇幅），failed 缺失视为空数组（不让报告整体失败）
    const failed = Array.isArray(summary.failed) ? summary.failed : []
    const brText = { 320: '320k MP3', 2000: '无损 FLAC' }[String(br)] || String(br || '默认')
    // 汇总行分桶拼装：非零桶才出现（同音质已存在/暂无歌词平时不占篇幅），与任务卡片/前端汇总同口径
    const parts = [`新下载 ${summary.ok}`]
    if (summary.existed) parts.push(`同音质已存在 ${summary.existed}`)
    if (summary.filled) parts.push(`补歌词 ${summary.filled}`)
    if (summary.noLyric) parts.push(`暂无歌词 ${summary.noLyric}`)
    parts.push(`跳过 ${summary.skipped}`, `失败 ${failed.length}`)
    const lines = [
      `批次：${label || '未命名批次'}`,
      `时间：${timestampName()}`,
      `音质：${brText}`,
      `共 ${summary.total} 首：${parts.join('，')}`,
    ]
    if (failed.length) {
      lines.push('', '失败明细：')
      for (const f of failed) lines.push(`  ${f.name || f.id} — ${f.error || '未知错误'}`)
    }
    if (summary.skippedNames && summary.skippedNames.length) {
      lines.push('', `跳过（已存在 ${summary.skippedNames.length} 首）：`)
      for (const n of summary.skippedNames) lines.push(`  ${n}`)
    }
    // CRLF：Windows 记事本直接打开不挤成一行
    fs.writeFileSync(path.join(dir, REPORT_NAME), lines.join('\r\n') + '\r\n', 'utf8')
    return true
  } catch (e) {
    logger.error('storage', `${REPORT_NAME} 写入失败（目录不可写？）: ${dir} — ${core.error.errMsg(e)}`)
    return false
  }
}

module.exports = {
  timestampName, batchStem, createBatchDir, findBatchDir, sweepDownloads, scanDir,
  readIndexFile, mergeIndexFile, writeBatchReport, MARKER, INDEX_NAME, REPORT_NAME,
}
