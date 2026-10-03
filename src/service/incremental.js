/**
 * 增量歌单下载：同名批次文件夹已存在时，扫描已有产物，只补缺失部分（仅增不删）
 *
 * 策略（按产品拍板，默认开启、无用户开关）：
 *  - 音频已有（不论 mp3/flac）且歌词已有 → 整首跳过，不重新下载
 *  - 音频已有而歌词缺失 → 只补 .lrc（含翻译合并），不动音频
 *  - 音频缺失 → 正常走完整下载（统一骨架 pipeline.runBatch + 落盘后端）
 *  - 歌单里被移除的歌不做任何删除——目录只增不减
 * 匹配规则：分类与落盘共用同一份命名分配（naming.assignBaseNames）——先认领磁盘已有产物
 * （纯歌名与"歌名 - 歌手"两种形态都认），再给要下载的歌分配不冲突的名字（同批同名组全组加歌手）。
 * **认领优先按歌曲 id**：批次目录存有 .ncm-index.json（id→基础名，storage.readIndexFile/mergeIndexFile），
 * 命中 id 直接用历史 base 认领（纯名/带歌手都认），只有 id 不在索引才走名字逻辑——
 * 修复"同名同歌手/旧文件属于已移出歌单的同名歌"只凭歌名会认错的残余问题（HANDOFF 已知问题）。
 * 只增不删：歌移出歌单索引条目保留；索引缺失/损坏退回名字匹配（向后兼容）。
 * 改命名不会脱钩：分配逻辑唯一出处是 naming.assignBaseNames / baseNameOf
 */
const fs = require('fs')
const path = require('path')
const dl = require('./download')
const naming = require('./naming')
const core = require('../core')
const storage = require('./storage')
const { throwIfCancelled } = require('./util')
const { scanDir } = storage
// 与 naming.assignBaseNames 共用同一把尺子（决策 78）：分配与对账必须用同一个比较口径，
// 否则一边认为"没占用"、另一边认为"已存在"，结果就是 existsSync 命中 → 永久跳过
const { nameKey } = naming

/**
 * 三分类（纯函数）
 * @param index.idMap 可选：String(id) → 历史基础名（storage.readIndexFile 的产物，批次目录
 *   .ncm-index.json）。命中 id 的歌直接认领它的历史 base（纯名/"歌名 - 歌手"形态都认），
 *   未命中的歌才走 assignBaseNames 现有认领/分配；缺省（无该字段）与引入前行为逐字一致。
 * @param opts.lyrics 是否保留"音频在、歌词缺"的补词候选（缺省 true，与历史行为一致）；
 *   显式传 false 时 fill 清空并把这批并入 skipped——补词口径的形状知识只在这一处，
 *   调用方只传开关（server 只算一次歌词判定，不再在门面里改写 plan 的内部形状）
 * @param opts.qualityExt 音质补下（网页勾选"音质不同也补下"时传入目标扩展名 'mp3'/'flac'，缺省 null）：
 *   同基础名已有音频但**不是目标音质**时照样下载补齐——旧音质文件保留（只增不删），
 *   已有歌词不重写（lyricsFor 不含它）；不传则维持原口径（有任何音频即视为已存在）
 * @returns { download: song[], fill: song[], skipped: {id,name}[], bases: Map<song,base>, lyricsFor: Set<song> }
 *   bases 是分类与后续落盘共用的命名分配（downloadMany/fillLyric 都从这里取名，保证一致）；
 *   lyricsFor = 下载列表里确实缺歌词的歌（run 只在调用方开了歌词时把它透传给骨架）
 */
function plan(songs, index = {}, { lyrics = true, qualityExt = null } = {}) {
  // 入口统一归一：index 的形状由 scanDir（本地/设备两条管线同形状）保证，
  // 但手工调用/未来新调用方可能只给部分字段。在一处补齐形状，
  // 好过在后面每个使用点散落 `|| new Map()` —— 漏一处就是一个 undefined 解引用
  const audioIndex = (index && index.audio) instanceof Map ? index.audio : new Map()
  const lrcIndex = (index && index.lrc) instanceof Set ? index.lrc : new Set()
  // idMap 兼容两种载体（Map / 普通对象），缺失或非法视为"无索引"→ 纯名字逻辑（向后兼容）
  const idMap = (index && index.idMap instanceof Map)
    ? index.idMap
    : (index && index.idMap && typeof index.idMap === 'object') ? new Map(Object.entries(index.idMap)) : null
  // 第一步：ID 命中的歌先认领历史 base（覆盖后续按名字算出的结果），并把这些 base 标为已占——
  // 未命中的同名歌因此绝不会抢走它们（"同名两首不互认"的关键：A/B 各按自己的 id 拿各自的旧名）
  const override = new Map()
  const hitBases = new Set()
  if (idMap) {
    for (const s of songs) {
      if (!s || s.id === undefined || s.id === null) continue
      const b = idMap.get(String(s.id))
      // 空串/非串不认；同一 base 被两个 id 指向（索引损坏/人工改动）时先到先得，
      // 后者退回名字逻辑——绝不让两首歌共用一个 base（会互相覆盖文件）
      if (typeof b !== 'string' || !b || hitBases.has(b)) continue
      override.set(s, b)
      hitBases.add(b)
    }
  }
  // 第二步：命名分配。命中的歌稳定前置（先占先得：它们的历史名先被占住，同名未命中的歌才会拿到新名），
  // 未命中歌保持原相对顺序；taken 追加 hitBases 保证未命中歌"认领/分配"两阶段都避让历史名。
  // hitBases 同时作为 claimed 预置传入：历史 base 是"(2)"这类非字面形态时，字面名恰同的新歌
  // 不得在认领阶段抢走它（抢走会把旧文件误判成新歌的"已存在"而永久跳过）——只许避让不许认领
  const ordered = override.size
    ? [...songs.filter((s) => override.has(s)), ...songs.filter((s) => !override.has(s))]
    : songs
  const assigned = naming.assignBaseNames(ordered, new Set([...audioIndex.keys(), ...lrcIndex, ...hitBases]), hitBases)
  // 第三步：命中歌用历史 base 覆盖分配结果（无论该 base 是纯名还是带歌手），未命中歌沿用分配结果
  const bases = override.size
    ? new Map(songs.map((s) => [s, override.has(s) ? override.get(s) : assigned.get(s)]))
    : assigned
  const download = []
  const fill = []
  const skipped = []
  const lyricsFor = new Set()
  // 索引/现状查表同样走大小写折叠键（决策 78）：scanDir 的键是**磁盘上的实际大小写**，
  // 而 API 歌名的大小写可能被上传者改过（Hello World → hello world）。不折叠就会
  // 判成"文件不存在"→ 进下载列表 → existsSync 在 NTFS/ext4 上却返回 true →
  // 走 existed 分支跳过 —— 这首歌永远下不下来，而日志说它已存在（与命名分配同源）
  // 反向映射：折叠键 → 磁盘实际名。命中后要把 base 改写成磁盘上的写法，
  // 否则 bases 里存着 'hello world'、磁盘上是 'Hello World'，两者在 NTFS 上是同一个文件
  // 却对不上账（写入用前者、扫盘回来说后者，索引与磁盘名永久错位）
  const audioByKey = new Map()
  const diskNameByKey = new Map()
  for (const [k, v] of audioIndex) { audioByKey.set(nameKey(k), v); diskNameByKey.set(nameKey(k), k) }
  for (const k of lrcIndex) if (!diskNameByKey.has(nameKey(k))) diskNameByKey.set(nameKey(k), k)
  const lrcKeys = new Set([...lrcIndex].map(nameKey))
  for (const s of songs) {
    const bk = nameKey(bases.get(s))
    const existingExts = audioByKey.get(bk)
    // 命中磁盘现状时把 base 统一成磁盘实际写法（决策 78）：分配给的是 API 的大小写，
    // 而 scanDir 回的是磁盘的大小写。不统一的话 bases 与磁盘名对不上，
    // 索引回填会记下一个磁盘上并不存在的名字
    const diskName = diskNameByKey.get(bk)
    if (diskName) bases.set(s, diskName)
    if (!existingExts || !existingExts.size) {
      download.push(s)
      if (!lrcKeys.has(bk)) lyricsFor.add(s)
    } else if (qualityExt && !existingExts.has(qualityExt)) {
      // 音质补下：目标音质缺失 → 补下；歌词已有则不重写（用户拍板：只增不删，歌词也算"已有"）
      download.push(s)
      if (!lrcKeys.has(bk)) lyricsFor.add(s)
    } else if (!lrcKeys.has(bk)) fill.push(s)
    else skipped.push({ id: s.id, name: s.name })
  }
  if (lyrics) return { download, fill, skipped, bases, lyricsFor }
  // 关闭补词时，"音频已在、只缺歌词"的歌既不下也不写词 → 并入跳过口径（口径与日志一致：
  // 每首歌仍恰好一条日志）。否则它们不计下载、不计跳过、不写日志，汇总分子分母对不上、
  // 进度条到不了 100%，响应里的 skipped 也少算
  return { download, fill: [], skipped: [...skipped, ...fill.map((s) => ({ id: s.id, name: s.name }))], bases, lyricsFor }
}

/**
 * 只补歌词（音频已在的歌）：取词 → 合并翻译 → 写同名 .lrc。
 * 落盘实现由 backend 决定（本地 fsSink.saveLyric / 手机 adbSink.pushLyric）；
 * base 为 plan() 分配的基础名（该歌的音频文件就叫这个名）；缺省按歌名推（兼容手工调用）。
 * 失败不抛错（返回结果对象），可选项不拖垮整个任务；
 * 唯一例外：设备断连（isBatchAbort：deviceGone/noAdb）必须上抛——否则整份 fill 列表
 * 会逐首空转各等一轮宽限。
 * @returns { ok, name, lrcFile?, noLyric?, error? }
 */
async function fillLyric(song, dir, base, signal, backend) {
  const name = song.name || String(song.id)
  const bk = backend || dl.fsSink(dir)
  try {
    const lrcFile = await bk.writeLyric(song.id, base || naming.baseNameOf(song), signal)
    if (!lrcFile) return { ok: true, name, noLyric: true }
    return { ok: true, name, lrcFile }
  } catch (e) {
    if (bk.isBatchAbort(e)) throw e
    return { ok: false, name, error: core.error.errMsg(e) }
  }
}

/**
 * 执行增量计划：索引回填 → 下载缺失音频（统一骨架）→ 逐首补缺失歌词。
 * 本地（job 直调）与手机（phone.run 注入 backend + downloadMany）共用这一份循环；
 * 任务队列（startJob）只注入回调写日志。
 * @param opts 透传骨架（dir/br/lyrics/cover/signal），另有注入点：
 *   - opts.backend: 落盘后端（phone.run 传 adbSink；缺省 fsSink(opts.dir)）
 *   - opts.downloadMany: 测试注入（单测注入 fakeMany 验证透传契约）
 * @param cbs.onProgress (p, item) => void；cbs.onFile (result, item) => void（补歌词也走 onFile）
 * @returns { results, fillResults }
 */
async function run(plan, opts = {}, cbs = {}) {
  const { onFile, onProgress } = cbs
  const signal = opts.signal
  throwIfCancelled(signal)
  const backend = opts.backend || dl.fsSink(opts.dir)
  const many = opts.downloadMany || dl.downloadMany
  // 索引回填（只增不删）：plan 的完整命名分配（含按名字认领的旧目录、被跳过与补词的歌）
  // 合并进批次目录的 .ncm-index.json——首次认领无索引的旧目录时全量回填，
  // 之后这些歌一律按 id 认领，不再靠歌名猜。放在空计划早退之前：全跳过的批次正是最该回填的场景。
  // 仅在目录真实存在时写（测试/手工调用可能传占位 dir，不得凭空建目录/在设备上建目录）；
  // dirExists 对设备错误已容错，写失败静默
  if (typeof opts.dir === 'string' && opts.dir && plan.bases instanceof Map && plan.bases.size) {
    if (backend.dirExists(opts.dir)) {
      backend.writeIndexFile(opts.dir, [...plan.bases].map(([s, b]) => [s && s.id, b]))
    }
  }
  const downloadList = plan.download || []
  const fillList = plan.fill || []
  // 空计划零调用：download/fill 都空时直接返回，不调 downloadMany（避免无意义的目录扫描与封面初始化）
  if (!downloadList.length && !fillList.length) return { results: [], fillResults: [] }
  // bases 透传给骨架：分类与落盘必须用同一份命名分配（否则同名歌会错位）。
  // lyricsFor 只在调用方开了"下载时写词"时生效；skipIfExists（音质补下防降级覆盖）随 opts 透传
  const results = await many(downloadList, {
    ...opts,
    bases: plan.bases,
    lyricsFor: opts.lyrics ? plan.lyricsFor : new Set(),
    onProgress,
    onFile,
  })
  const fillResults = []
  // 补词循环整体包 try/catch（决策 79）：此前只有循环**结束后**的一次 abort 检查，
  // 于是"音频下完 400 首、补词到第 30 首时点取消"会丢掉全部 400 条下载结果——
  // 卡片显示"下载 0，跳过 590，失败 0"，而磁盘上躺着 400MB 音频，报告也说新下载 0。
  try {
    for (const s of fillList) {
      throwIfCancelled(signal)
      const r = await fillLyric(s, opts.dir, plan.bases && plan.bases.get(s), signal, backend)
      fillResults.push(r)
      // 观察回调包 try/catch：抛错不得中断整份补词列表（与骨架的包裹口径一致）
      if (onFile) try { onFile(r, s) } catch { /* 回调异常不影响批次 */ }
    }
  } catch (e) {
    // 只在还没有部分结果时补挂（骨架已经挂过的不覆盖）
    if (!Array.isArray(e.partialResults)) e.partialResults = results
    if (!Array.isArray(e.partialFillResults)) e.partialFillResults = fillResults
    throw e
  }
  // 协作式取消在末尾兜底：abort 恰好落在最后一首之后时循环内不再检查，这里补一次。
  // 任务层需要已完成的各首才能在"取消"时仍给出汇总并落批次报告，故把部分结果挂在错误对象上
  if (signal && signal.aborted) throw Object.assign(
    Object.assign(new Error('任务已取消'), { name: 'AbortError' }),
    { partialResults: results, partialFillResults: fillResults },
  )
  return { results, fillResults }
}

/** 汇总任务结果（纯函数，供任务队列写 job.result 与前端展示） */
function summarize({ total, results, fillResults = [], skipped = 0 }) {
  const skippedList = Array.isArray(skipped) ? skipped : []
  // existed = 音质补下模式命中 skipIfExists、目标文件已在而没真下。单独计数，
  // 不能混进 ok —— 批次报告里写"新下载 N"必须等于真正落盘的新文件数
  const downloaded = results.filter((r) => r.ok && !r.existed)
  const existed = results.filter((r) => r.ok && r.existed)
  return {
    total,
    ok: downloaded.length,
    existed: existed.length,
    skipped: Array.isArray(skipped) ? skipped.length : (skipped || 0),
    // 跳过明细（名字列表）供批次结果报告（下载结果.txt）使用；HTTP/前端只用 skipped 计数
    skippedNames: skippedList.map((s) => s.name),
    // 补词成功要分两桶：真写进 .lrc 的（filled）与站内本来就无词的（noLyric）——
    // "补歌词 N" 必须等于真正落盘的新歌词数，无词不算补词（否则用户对照文件数对不上账）
    filled: fillResults.filter((r) => r.ok && !r.noLyric).length,
    noLyric: fillResults.filter((r) => r.ok && r.noLyric).length,
    failed: [...results, ...fillResults].filter((r) => !r.ok),
    files: downloaded.map((r) => r.filepath),
  }
}

module.exports = { scanDir, plan, fillLyric, run, summarize }
