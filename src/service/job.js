/**
 * 下载任务编排（service 层，从 server.js 下沉）
 * 任务记录/全局串行队列/来源取曲/建任务校验/批次目录与增量对账/取消语义——与 HTTP 帧格式无关，
 * server 门面只把 createTask 的 {code, body} 与 cancelJob 的结果原样回给客户端
 */
const path = require('path')
const core = require('../core')
const retry = require('../core/retry')
const download = require('./download')
const phone = require('./phone')
const incremental = require('./incremental')
const storage = require('./storage')
const playlist = require('./playlist')
const chart = require('./chart')
const recommend = require('./recommend')
const dest = require('./dest')
const adb = require('./adb')
const queue = require('./queue')
const params = require('./params')
const httputil = require('./httputil')
const logger = require('./logger')

// 建任务的取曲链路给总预算而非单请求上限：playlist 多批详情、simi/fm 循环拉批都是串行多请求，
// 预算过紧（如按单请求取 15s）会让大歌单从"慢但能下"变成"永远失败"（超时后底层继续跑、重试必然同点再超时）。
// server 门面的 /meting playlist、/recommend、/chart/:id 同类链路也复用这份预算（原样导出）
const JOB_FETCH_TIMEOUT = 30 * 1000

// fm/simi 的单次取曲数量上限：两源都是循环拉批（批间还有退避延迟），total 过大必然撞 30s
// 建任务预算——底层拉批继续跑、白烧网易请求后仍以 500 收场。提前 400 让用户分批
const MAX_RECOMMEND_TOTAL = 300

// 自定义 local 目的地的 .part/.tagtmp 清扫节流：sweepDownloads 是同步递归整棵目录树，
// 指向大盘/网络盘时一次可达数秒且阻塞事件循环（1.5s 的前端轮询一并停摆）。
// 按目录最多 10 分钟全扫一次；半成品最多滞留 10 分钟无碍——scanDir 不认 .part，不影响增量对账
const SWEEP_INTERVAL_MS = 10 * 60 * 1000
const lastSweepAt = new Map()

// ---- 下载任务队列（全局串行：同一时刻只跑一个任务，其余排队；后台执行，前端轮询） ----
const jobs = new Map()
let jobSeq = 0
const jobQueue = queue.createSerialQueue()

// 任务出参净化：queue 句柄含 fn/controller/signal（函数与 Abort 控制器），不得序列化给前端
// （JSON 会吞掉函数、漏出空对象，还让每 1.5s 的轮询变大）。解构摘掉 handle，其余原样
function toPublicJob(job) {
  if (!job) return job
  const { handle, ...pub } = job
  return pub
}

// 终端任务瘦身：done/error/cancelled 只留末 100 行日志 + 去掉逐首 files/跳过明细（报告已落盘，
// 前端卡片用不到）。running/queued 保持全量（贴底跟随依赖完整日志）；cancelled 同为终端态，同样瘦身
function slimJob(j) {
  if (j.status === 'running' || j.status === 'queued') return toPublicJob(j)
  const pub = toPublicJob(j)
  return {
    ...pub,
    log: (pub.log || []).slice(-100),
    logTotal: (pub.log || []).length,
    result: pub.result ? { ...pub.result, files: undefined, skippedNames: undefined } : null,
  }
}

function startJob(label, songs, opts) {
  const id = String(++jobSeq)
  // batchKey = 批次目录的归属键（来源类型 + 实体 id）。重复任务合并必须比它，不能比目录名：
  // 同名歌单在修复前共用目录名，比名会把两个不相关的任务并成一个（A 的进度显示成 B 的）
  // dir/br/skippedPreflight 挂在 job 上：排队中取消发生在 startJob 的任务体之前，
  // 那时 finish() 还没被定义，必须能从 job 本身取到落报告所需的路径与预检跳过数（决策 74）
  const job = {
    id,
    label,
    folder: opts && opts.dir ? path.basename(opts.dir) : '',
    dir: (opts && opts.dir) || '',
    br: (opts && opts.br) || 0,
    skippedPreflight: (opts && opts.plan && Array.isArray(opts.plan.skipped)) ? opts.plan.skipped.length : 0,
    destKind: (opts && opts.destKind) || 'default',
    destName: (opts && opts.destName) || '',
    // destId 必须落到 job 上（决策 81）：前端"打开文件夹"要靠它把任务绑回当时的下载位置。
    // 此前只写进了 opts 而没进 job，toPublicJob 展开 job 后 destId 恒为 undefined，
    // 服务端只好回落到"当前激活的目的地"——切过位置后点旧任务的按钮会打开另一个盘
    destId: (opts && opts.destId) || '',
    batchKey: (opts && opts.batchKey) || '',
    status: 'queued',
    cancelled: false,
    log: [],
    result: null,
    error: null,
    total: songs.length,
    startedAt: Date.now(),
    processed: 0,
  }
  jobs.set(id, job)
  // 只保留最近 50 个任务，防止内存无限增长（排队中/进行中的不驱逐）
  while (jobs.size > 50) {
    const evictable = [...jobs.values()]
      .filter((j) => j.status !== 'running' && j.status !== 'queued')
      .sort((a, b) => a.startedAt - b.startedAt)
    if (!evictable.length) break // 全在运行/排队时不驱逐，避免队列里的任务从视图消失
    jobs.delete(evictable[0].id)
  }
  // 创建日志在投递前落笔：队列空闲时任务回调会同步开跑，放在 push 之后会排在"开始"之后（时序颠倒）。
  // 音质/歌词/封面开关一并入日志：事后回答"这批是按无损还是 320 下的、为什么没有歌词"全靠它
  const on = (v) => (v ? '开' : '关')
  logger.log('job', `#${id} 创建: ${label}（${songs.length} 首 → ${(opts && opts.destKind) === 'phone' ? '手机 ' : ''}${(opts && opts.dir) || '默认目录'}，音质 ${(opts && opts.br) || '默认'}，歌词 ${on(opts && opts.lyrics)}，封面 ${on(opts && opts.cover)}）`)
  const handle = jobQueue.push(async (signal) => {
    // queued 取消竞态兜底：cancel() 已摘除时本函数根本不会执行；abort 先到则直接收尾
    if (job.cancelled || (signal && signal.aborted)) {
      job.status = 'cancelled'
      job.log.push('已取消')
      return
    }
    job.status = 'running'
    const startedMs = Date.now()
    // 结果容器与收尾函数都提到 try 外：取消/失败时仍要为"已完成的各首"做汇总与落盘。
    // 此前 downloadMany 遇 AbortError 会把 results 整个丢掉、job.js 直接走 catch 返回，
    // 于是 600 首下到 480 首取消/失败时既没有 job.result 也没有 下载结果.txt——
    // "到底哪几首已经下好了"重启后无从查证，与批次报告的存在动机直接冲突
    let results = []
    let fillResults = []
    // plan 提到 try 外：finish() 会读它，若留在 try 内 const 声明，catch 分支调用 finish 时
    // 恰好还没赋值就是 TDZ（"Cannot access 'plan' before initialization"），把真错误换成看不懂的崩栈
    let plan = null
    /** 统一终态收口：清 current、汇总、落批次报告、写状态与日志（成功/取消/失败共用一条路径） */
    const finish = (status, err) => {
      job.current = null // 终态必须清：否则已完成的卡片还显示"进行中 N/M · 当前: <上一首>"
      job.handle = null // 释放 AbortController 与挂在它上面的取消监听（退化的 mergeSignals 不会自动摘）
      // opts 可能为 undefined（startJob 是公开导出，允许 startJob(label, songs) 这种最简调用）。
      // finish 会在 catch 里被调用，此处若裸解引用就会二次抛错——而它抛在 catch 里没人接，
      // 任务会永远停在 running（进不了驱逐列表、还会被 findDup 按 batchKey 认领）
      const o = opts || {}
      const secs = Math.round((Date.now() - startedMs) / 1000)
      // 部分结果：管线在中止时会把已完成的各首挂在错误对象上（download/phone/incremental 三处一致）
      const rs = (err && Array.isArray(err.partialResults) && err.partialResults.length)
        ? err.partialResults : results
      const fs = (err && Array.isArray(err.partialFillResults) && err.partialFillResults.length)
        ? err.partialFillResults : fillResults
      job.result = incremental.summarize({
        total: songs.length,
        results: rs,
        fillResults: fs,
        skipped: plan ? plan.skipped : 0,
      })
      // 批次结果报告（下载结果.txt）：任务日志只存内存、重启即没，落一份到批次文件夹供事后翻查。
      // 取消/失败也要落——半途而废的批次恰恰最需要事后核对。
      // 手机目的地没有可写的本地路径，v1 不落报告（进度看任务卡片日志）
      if (o.destKind !== 'phone') {
        try { storage.writeBatchReport(o.dir, { label, br: o.br, summary: job.result }) } catch { /* 报告缺失不值得让任务标错 */ }
      }
      job.status = status
      if (err) job.error = core.error.errMsg(err) // 不用 e.message：NCM 库 reject 的是普通对象，会产出 "[object Object]"
      // 完成/取消/失败日志与卡片汇总、批次报告同一分桶口径：existed/filled/noLyric 非零才出现，
      // 跳过/失败恒显示（"失败 0"本身是对账信息），各桶之和 = 总数
      const r = job.result
      const parts = [`下载 ${r.ok}`]
      if (r.existed) parts.push(`同音质已存在 ${r.existed}`)
      if (r.filled) parts.push(`补歌词 ${r.filled}`)
      if (r.noLyric) parts.push(`暂无歌词 ${r.noLyric}`)
      parts.push(`跳过 ${r.skipped}`, `失败 ${r.failed.length}`)
      const tail = `（已处理 ${job.processed}/${songs.length} 首，耗时 ${secs}s）`
      if (status === 'done') logger.log('job', `#${id} 完成: ${label} — ${parts.join('，')}${tail}`)
      else if (status === 'cancelled') {
        job.log.push('已取消')
        logger.log('job', `#${id} 取消于 ${job.processed}/${songs.length} 首（耗时 ${secs}s）`)
      } else {
        // 失败原因必须进卡片日志（决策 80）：job.result 在**所有**终态路径上都是真值对象，
        // 前端据此渲染汇总，于是 job.error 分支永远走不到 —— 用户只看到红色"出错"卡片
        // 配一句"失败 0"，真正的原因只躺在 logs/service.log 里。
        // 典型场景：手机任务在排队期间被拔线，buildTask 抛"手机已断开"，一首都没下
        job.log.push(`失败：${label} — ${job.error}`)
        logger.error('job', `#${id} 失败: ${label} — ${job.error}${tail}`)
      }
    }
    // 这一行必须留在 try 内：它是本函数唯一裸解引用 opts/songs 的语句，而 startJob 是公开导出
    // （svc.job.startJob）。被以 startJob(label, songs) 形式调用时 opts 为 undefined 会抛 TypeError，
    // 抛在 try 外会被队列的 catch 吞掉 → 任务永远停在 running：既进不了驱逐列表（50 上限形同虚设），
    // 又会被 findDup 按 batchKey 认领，导致此后同批次的每次请求都被并进这个死任务、静默不下载
    try {
      logger.log('job', `#${id} 开始: ${label}（${songs.length} 首，目的地 ${opts.destKind || 'default'}${opts.destName ? `/${opts.destName}` : ''}）`)
      plan = opts.plan
      // 增量歌单：跳过的先记账（每首歌在日志里恰好一条，进度条分母 = 全部歌数）
      if (plan) {
        // 全角标点与站内中文案一致（此前半角括号/冒号，前端 startsWith('跳过') 不受影响，只改符号形状）
        for (const s of plan.skipped) {
          job.log.push(`跳过（已存在）：${s.name}`)
          job.processed++
        }
        if (!plan.download.length && !plan.fill.length) job.log.push('歌单无新增内容，全部跳过')
      }
      // 下载与补词的逐首循环、容错、汇总都在 service（incremental.run / downloadMany），本层只写日志与进度
      const onProgress = (p, song) => { job.current = { name: song.name, received: p.received, total: p.total } }
      const onFile = (r) => {
        job.current = null
        job.processed++
        // "（已重试）"是旧口径：逐首失败前并没有可靠的重试发生，如实写"失败"
        if (!r.ok) job.log.push(`失败：${r.name || r.id} — ${r.error}`)
        else if (r.existed && r.filepath) job.log.push(`跳过（同音质已存在${r.lrcFile ? '，已补歌词' : ''}）：${path.basename(r.filepath)}`)
        else if (r.filepath) {
          const extra = `${r.lrcFile ? ' +歌词' : ''}${r.embedded ? ' +内嵌封面' : ''}${r.embedError ? `（内嵌失败：${r.embedError}）` : ''}`
          job.log.push(`完成：${path.basename(r.filepath)}${extra}`)
        } else if (r.lrcFile) job.log.push(`补歌词：${path.basename(r.lrcFile)}`)
        else job.log.push(`补歌词：${r.name} — 暂无歌词`)
      }
      // 手机目的地的两类任务都必须走 phone 管线：plan 任务（歌单/补词）走 phone.run，
      // 无 plan 任务（单曲/批量单曲/每日推荐等 timestamp 批次）走 phone.downloadMany——
      // 若漏分流，本地管线的 path.join 会把设备路径折到当前盘（C:\sdcard\…），文件悄悄落本地盘
      const phoneTask = opts.destKind === 'phone'
      const out = plan
        ? await ((phoneTask ? phone.run : incremental.run)(plan, { ...opts, signal }, { onProgress, onFile }))
        : await (phoneTask
            ? phone.downloadMany(songs, { ...opts, signal, onProgress, onFile })
            : download.downloadMany(songs, { ...opts, signal, onProgress, onFile }))
      results = Array.isArray(out) ? out : (out.results || [])
      fillResults = Array.isArray(out) ? [] : (out.fillResults || [])
      // 协作式取消在末尾兜底：abort 恰好落在最后一首之后时循环内不再检查，这里补一次
      if (job.cancelled || (signal && signal.aborted)) {
        finish('cancelled', null)
        return
      }
      finish('done', null)
    } catch (e) {
      // 取消优先于失败：abort 到达后的 AbortError 走 cancelled，不计 error
      if (job.cancelled || (signal && signal.aborted)) {
        finish('cancelled', e)
        return
      }
      finish('error', e)
    }
  })
  job.handle = handle
  return id
}

// Web UI 建任务的取曲来源：来源名 → 取曲目并给批次命名信息
const UI_SOURCES = {
  daily: async (b) => ({ songs: await recommend.daily(), label: `每日推荐` }),
  fm: async (b) => {
    const names = { DEFAULT: '私人FM', FAMILIAR: '私人雷达', EXPLORE: '私人漫游' }
    const r = await recommend.fm({ mode: b.mode, total: Number(b.total) || 30 })
    return { songs: r.songs, label: names[b.mode] || '私人FM' }
  },
  simi: async (b) => {
    const r = await recommend.simi(b.id, { total: Number(b.total) || 30 })
    return { songs: r.songs, label: `相似歌曲(${b.id})` }
  },
  playlist: async (b) => {
    // 按 limit 先截断 trackIds 再取详情（0/未传/非法 = 全部）：想下 20 首不必先把几千首的详情全拉回来
    const pl = await playlist.get(b.id, { limit: Number(b.limit) })
    // dirName 决定批次目录名，ownerId 一起带上：两个同名歌单（"我喜欢的音乐"很常见）
    // 靠名字会共用一个目录，A 的同名文件会把 B 的歌误判成"已存在"而跳过
    return { songs: pl.songs, label: `歌单: ${pl.name}`, dirName: pl.name, ownerId: String(pl.id) }
  },
  chart: async (b) => {
    const chartData = await chart.get(b.id, { limit: Number(b.limit) || undefined })
    return { songs: chartData.songs, label: `榜单: ${chartData.name}`, dirName: chartData.name }
  },
  song: async (b) => ({ songs: await core.song.getDetail(b.id), label: `单曲(${b.id})` }),
  // 单曲批量排队：一次多个 id，落盘到以启动时间命名的独立文件夹（见 createBatchDir）
  songs: async (b) => {
    const ids = Array.isArray(b.ids) ? b.ids : String(b.ids || '').split(',').map((x) => x.trim()).filter(Boolean)
    const songs = await core.song.getDetail(ids)
    return { songs, label: `批量单曲(${songs.length}首)` }
  },
}

/**
 * 下载任务统一入口：Web UI 的 POST /api/download 与旧版 GET /download/* 共用
 * 入口校验（来源/榜单ID/音质）→ 取曲目 → 批次目录与增量对账 → 投递全局串行队列
 * @param {object} p 请求参数（body 或 query）
 * @param {object} ctx { downloadDir } 缺省下载根（目的地的 "default" 兜底）
 * @returns {{ code: number, body: object }} HTTP 状态与响应体（成功 200，校验缺口 400，没取到歌 404）
 */
async function createTask(p, ctx) {
  const { downloadDir } = ctx || {}
  const { brOf, brError, flagOn, missingId, badCount } = params
  // 必须用 hasOwn 查表：UI_SOURCES 是普通对象字面量，p.source='constructor'/'toString'
  // 会取到 Object.prototype 上的方法（真值），通过下面的 !fn 检查，然后被当函数调用 →
  // 500 + 一句 JavaScript 内部错误，而不是本该给的 400"未知来源"（决策 77）
  const fn = Object.hasOwn(UI_SOURCES, p.source) ? UI_SOURCES[p.source] : undefined
  if (typeof fn !== 'function') return { code: 400, body: { error: '未知来源：' + p.source + '（支持：daily / fm / simi / playlist / chart / song / songs）' } }
  if (p.source === 'chart' && !(p.id && String(p.id).trim())) return { code: 400, body: { error: 'chart 来源需要榜单 ID 或名称' } }
  // 建任务入口的必填 ID 校验：缺 id 时底层会空查/抛错走 500，实为客户端缺参，提前 400
  //（chart/songs 已有各自校验，此处补齐其余三源；daily/fm 不需要 id）
  if (p.source === 'playlist' && missingId(p.id)) return { code: 400, body: { error: 'playlist 来源需要歌单 ID' } }
  if (p.source === 'song' && missingId(p.id)) return { code: 400, body: { error: 'song 来源需要歌曲 ID' } }
  if (p.source === 'simi' && missingId(p.id)) return { code: 400, body: { error: 'simi 来源需要歌曲 ID' } }
  if (p.source === 'songs' && !(Array.isArray(p.ids) ? p.ids.length : p.ids)) {
    return { code: 400, body: { error: 'songs 来源需要歌曲 ID 列表' } }
  }
  // songs 内容校验：全是非数字 id 时 getDetail 会静默过滤成空再报 404，提前 400 指明是 ID 非法
  if (p.source === 'songs') {
    const rawIds = Array.isArray(p.ids) ? p.ids : String(p.ids || '').split(',')
    const hasNumeric = rawIds.map((x) => String(x ?? '').trim()).some((x) => /^\d+$/.test(x))
    if (!hasNumeric) return { code: 400, body: { error: 'songs 来源的歌曲 ID 非法（应为数字 ID）' } }
  }
  // 建任务的数量校验：fm/simi 的 total 显式传了就必须 >0（此前 "abc" 会静默回退 30，用户以为生效）；
  // playlist/chart/song 的 limit 保持"非法视为全量"的既有口径，此处不拦
  if ((p.source === 'fm' || p.source === 'simi') && ('total' in p && badCount(p.total))) {
    return { code: 400, body: { error: '数量参数非法，应为大于 0 的数字' } }
  }
  if ((p.source === 'fm' || p.source === 'simi') && Number(p.total) > MAX_RECOMMEND_TOTAL) {
    return { code: 400, body: { error: `数量过大（上限 ${MAX_RECOMMEND_TOTAL}），请分批下载` } }
  }
  const brErr = brError(p)
  if (brErr) return { code: 400, body: { error: brErr } }
  try {
    const { songs, label, dirName, ownerId } = await retry.withTimeout(fn(p), JOB_FETCH_TIMEOUT)
    if (!songs.length) return { code: 404, body: { error: '没有取到歌曲（检查登录状态或 ID）' } }
    // limit 只接受 >=1 的整数（0/空/负数/NaN 视为全量；小数按注释约定也视为全量）
    const lim = Number(p.limit)
    const cut = Number.isInteger(lim) && lim >= 1 ? Math.min(lim, songs.length) : songs.length
    const picked = songs.slice(0, cut)
    // 增量歌单（默认开启，无开关）：downloads 下已有同名歌单批次目录时复用它，
    // 扫描已有产物——音频齐+歌词齐的跳过，缺歌词的只补 .lrc，只增不删。
    // 来源标记防跨来源认领：榜单/时间戳批次目录（.ncm-batch.json 类型不符）不会被歌单增量复用
    // ownerId 防同名歌单互相认领（歌单 id 进目录名与标记）
    // 音质补下（网页勾选框，缺省关）：同基础名已有别的音质也补下目标音质——旧音质文件保留（只增不删）、
    // 已有歌词不重写；解析降级回已有音质时按"同音质已存在"跳过（skipIfExists，不覆盖）
    // 只认显式 true/1（flagOn）：网页总是显式传 checkbox 布尔值，不受缺省口径影响；
    // 旧版 GET /download/* 等不传该参数的入口 → 关，与文档"缺省关"一致
    const fillQuality = flagOn(p.fillQuality)
    const batchType = { playlist: 'playlist', chart: 'chart' }[p.source] || 'timestamp'
    // 下载位置（目的地）：全局开关，缺省 = 项目 downloads\。归属键必须带目的地——
    // 同一歌单在两个目的地是两个独立批次，不带会比成同一个任务（A 目的地的进度显示成 B 的）
    const d = dest.resolve(downloadDir)
    // 批次归属键。**必须对每个来源都携带身份**（决策 73）：此前五源退化成同一个字面量
    // `timestamp||dest:default`，findDup 又被提前到目录分支之前，于是"下载单曲 A"还没跑完、
    // 再点"下载单曲 B"会被判成重复请求并合并，返回 200 already，第二首**从未被下载**却显示成功。
    // 归属实体按可靠性降级：歌单 ownerId > 榜单名 dirName > 来源自带身份（单曲 id / id 列表 /
    // 推荐流的 mode+total）。fm/simi 每次都是新的一批，本就不该合并——用时间桶之外的显式标记
    // 表达"每批都是新的"，而不是让它们共用一个空键。
    const batchIdent = ownerId != null ? String(ownerId)
      : dirName != null ? String(dirName)
        : (p.source === 'fm' ? `fm:${p.mode || 'DEFAULT'}:每次新建`
          : p.source === 'daily' ? 'daily:每次新建'
            : p.source === 'songs' ? `songs:${(Array.isArray(p.ids) ? p.ids : String(p.ids || '').split(',')).map((x) => String(x).trim()).filter(Boolean).join(',')}`
              : `${p.source}:${p.id != null ? String(p.id) : ''}`)
    // 选项也进键：同一歌单同时提交 320k 与无损是**两个不同的批次**，合并会让用户明确选的
    // 无损被静默丢弃（返回的仍是 200 already，用户以为无损任务也在跑）
    // 歌词判定只算一次，下载写词与增量补词共用同一个开关（此前是两套判定：
    // 旧 /download/* 端点不传 lyrics 时"不写词但补词"，同一请求出现两套口径）
    // 必须在 batchKey 之前求值：batchKey 要用它，而 const 的 TDZ 会直接抛
    const lyricsOn = !/^(false|0)$/i.test(String(p.lyrics))
    const batchKey = `${batchType}|${batchIdent}|dest:${d.id || 'default'}|br:${brOf(p)}|lyrics:${lyricsOn ? 1 : 0}`
    let plan = null
    const jobOpts = {
      batchKey,
      br: brOf(p),
      // 与增量补词同一开关（lyricsOn）：显式 false/0 才关，缺省开
      lyrics: lyricsOn,
      cover: p.cover === undefined || !/^(false|0)$/i.test(String(p.cover)),
      skipIfExists: fillQuality,
      destId: d.id,
      destKind: d.kind,
      destName: d.name,
    }
    // 同批次去重：同一歌单连点两次下载会命中同一批次目录，而 plan 在建任务时刻就扫描冻结——
    // 若前一个任务还在排队/执行，后建的任务会按"空目录"的旧 plan 全量重下并覆盖刚下好的文件。
    // 合并到原任务（前端轮询天然并入同一张卡片），不再重复消耗带宽/磁盘/网易请求。
    // 排除 cancelled：协作式取消下 status 仍是 running 直到管线观察到 abort，这个窗口里
    // 把新请求并进"正在收尾"的任务，用户看到的是"合并成功"然后什么都没下。
    // 放在批次目录分支之前（此前只在 findBatchDir 命中目录时才可达）：batchKey 对全部来源都有意义，
    // 连点两次"下载飙升榜"此前会开出两个 600 首任务、两个新目录、约 1200 次请求
    const findDup = () => [...jobs.values()].find((j) =>
      j.batchKey === batchKey && !j.cancelled && (j.status === 'queued' || j.status === 'running'))
    const dupEarly = findDup()
    if (dupEarly) {
      logger.log('job', `#${dupEarly.id} 合并: "${label}" 的重复下载请求（${picked.length} 首）并入进行中的任务`)
      return { code: 200, body: { jobId: dupEarly.id, count: picked.length, label, folder: dupEarly.folder, skipped: 0, already: true } }
    }
    if (d.kind === 'phone') {
      // 手机目的地：ADB 直写管线，批次目录/增量/索引与本地同格式（service/phone）。
      // 状态检查与对账之间设备可能恰好拔线：adb 原语抛错归 400"手机目的地不可用"（客户端可重试），
      // 不落 500（服务端没坏）
      // dir 必须声明在 try 外：try 块内的 let 出了块就是死绑定，下方 startJob 在 try 外引用，
      // 命中的会是同一作用域后面 local 分支的同名 let —— TDZ "Cannot access 'dir' before
      // initialization"，手机目的地建任务必炸（实机复现过的回归）
      let dir = null
      try {
        // 必须先失效缓存：status() 有 5 秒 TTL，而 UI 每 2 秒轮询一次 /api/adb。
        // 用户 t+0.5s 拔线、t+2s 点下载（仍在 TTL 内）→ 读到陈旧的 ready 通过闸门，
        // 紧接着 findBatchDir 抛原始 adb 字符串，用户看到英文 "device 'xxx' not found"
        // 而不是别处统一口径的"手机已断开连接"（其余三个探测点 phone/dest 都先失效）
        adb.invalidate()
        const st = adb.status()
        if (st.state !== 'ready') {
          logger.error('job', `建任务失败：手机目的地不可用（${st.message}）`)
          return { code: 400, body: { error: '手机目的地不可用：' + st.message } }
        }
        dir = batchType === 'playlist' ? phone.findBatchDir(d.base, dirName, 'playlist', ownerId) : null
        if (dir) {
          // 目标扩展名由音质映射（exhigh→mp3 / lossless→flac）；br 已在入口校验过，这里不会抛
          const qualityExt = fillQuality ? core.quality.extOf(core.quality.toLevel(brOf(p))) : null
          const idMap = phone.readIndexFile(dir)
          plan = incremental.plan(picked, { ...phone.scanDir(dir), idMap }, { lyrics: lyricsOn, qualityExt })
        } else {
          dir = phone.createBatchDir(d.base, dirName, batchType, ownerId)
        }
      } catch (e) {
        logger.error('job', `手机目的地对账失败: ${core.error.errMsg(e)}`)
        return { code: 400, body: { error: '手机目的地不可用（' + core.error.errMsg(e) + '）' } }
      }
      const jobId = startJob(label, picked, { dir, plan, ...jobOpts })
      return { code: 200, body: { jobId, count: picked.length, label, folder: path.basename(dir), skipped: plan ? plan.skipped.length : 0 } }
    }
    // default / local 目的地：同一套 fs 管线，仅批次根换成目的地目录（storage 全部以 base 为参数）
    const baseDir = d.base
    if (d.kind === 'local') {
      // 自定义目录的 .part/.tagtmp 清扫：跟随任务走（启动清扫仍只认缺省 downloads），按目录节流。
      // 队列空闲才扫：sweepDownloads 会递归删掉整棵树下所有 .part，而正在跑的任务正往其中
      // 批次子目录写 .part——libuv 以 FILE_SHARE_DELETE 打开文件，unlink 会"成功"，字节写进
      // 待删句柄后凭空消失，随后 rename 报 ENOENT，用户看到的是"文件被占用？"这种完全错误的诊断
      if (!jobQueue.active && !jobQueue.pending) {
        const last = lastSweepAt.get(baseDir) || 0
        if (Date.now() - last > SWEEP_INTERVAL_MS) {
          lastSweepAt.set(baseDir, Date.now())
          try { storage.sweepDownloads(baseDir) } catch { /* 清扫失败不阻塞任务 */ }
        }
      }
    }
    let dir = batchType === 'playlist' ? storage.findBatchDir(baseDir, dirName, 'playlist', ownerId) : null
    if (dir) {
      // 歌词补齐跟随歌词开关（fill 清空与 skipped 合并的形状知识在 plan() 里，门面只传开关）
      // 目标扩展名由音质映射（exhigh→mp3 / lossless→flac）；br 已在入口校验过，这里不会抛
      const qualityExt = fillQuality ? core.quality.extOf(core.quality.toLevel(brOf(p))) : null
      // id→基础名索引（.ncm-index.json，无/坏文件返回空 Map）：增量优先按歌曲 id 认领历史文件名，
      // id 不在索引才退回名字匹配（plan 内实现，本层只负责把该目录的索引传进去）
      const idMap = storage.readIndexFile(dir)
      plan = incremental.plan(picked, { ...storage.scanDir(dir), idMap }, { lyrics: lyricsOn, qualityExt })
    } else {
      dir = storage.createBatchDir(baseDir, dirName, batchType, ownerId)
    }
    const jobId = startJob(label, picked, { dir, plan, ...jobOpts })
    return { code: 200, body: { jobId, count: picked.length, label, folder: path.basename(dir), skipped: plan ? plan.skipped.length : 0 } }
  } catch (err) {
    // 只进控制台的错误等于没记（.bat 窗口一关就没），统一走双写
    logger.error('job', `建任务失败（${p.source}）: ${core.error.errMsg(err)}`)
    // 取曲失败里"找不到榜单/歌单"归 404，其余 500（此前一律 500，前端无法区分"ID 写错"与"服务端故障"）
    return { code: httputil.httpStatus(err), body: { error: core.error.errMsg(err) } }
  }
}

/**
 * 取消任务：queued→从等待队列摘除并置 cancelled；running→置 cancelled，
 * 协作式收尾（取消信号已注入两条管线的取流阶段，当前首即时断流，不再等大文件下完）。
 * done/error 的再删返回 400，cancelled 的再删幂等返回 ok。
 * @returns {{ code: number, body: object }}
 */
function cancelJob(id) {
  const job = jobs.get(id)
  if (!job) return { code: 404, body: { error: '任务不存在' } }
  if (job.status === 'queued') {
    job.cancelled = true
    try { if (job.handle && typeof job.handle.cancel === 'function') job.handle.cancel() } catch { /* 忽略 */ }
    job.status = 'cancelled'
    job.log.push('已取消')
    // 排队中取消也必须有完整的终态账（决策 74）：此前只置 status，result 留 null 且不落报告。
    // 后果有二：前端按 job.result 渲染汇总，同一张"已取消"卡片在排队取消时是空的、
    // 在执行中取消时是满的（同一状态两种形状）；批次目录已被 createTask 建好，
    // 用户打开会看到只有标记文件、没有任何解释它为何存在的 下载结果.txt
    job.result = incremental.summarize({
      total: job.total,
      results: [],
      fillResults: [],
      skipped: job.skippedPreflight || 0,
    })
    if (job.dir && job.destKind !== 'phone') {
      try { storage.writeBatchReport(job.dir, { label: job.label, br: job.br, summary: job.result }) } catch { /* 报告缺失不值得让取消标错 */ }
    }
    job.handle = null // 释放 AbortController 与其上的取消监听
    logger.log('job', `#${id} 取消（排队中，尚未开始）`)
    return { code: 200, body: { ok: true, status: 'cancelled' } }
  }
  if (job.status === 'running') {
    job.cancelled = true
    try { if (job.handle && typeof job.handle.cancel === 'function') job.handle.cancel() } catch { /* 忽略 */ }
    // 请求本身必须落日志：当前首是 10 分钟大文件时，用户点取消到实际停止之间日志里一片空白，
    // 会以为"点了没反应"；真正的"取消于 N/M"要等循环感知后才落
    logger.log('job', `#${id} 收到取消请求（当前歌曲中断下载，后续歌曲不再开始）`)
    return { code: 200, body: { ok: true, status: 'running', cancelled: true, message: '取消中，当前歌曲即将中断' } }
  }
  if (job.status === 'cancelled') return { code: 200, body: { ok: true, status: 'cancelled', already: true } }
  return { code: 400, body: { error: `任务已结束（${job.status}），无法取消` } }
}

module.exports = {
  jobs, jobQueue, startJob, UI_SOURCES, createTask, cancelJob, toPublicJob, slimJob, JOB_FETCH_TIMEOUT, MAX_RECOMMEND_TOTAL,
}
