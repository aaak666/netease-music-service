/**
 * HTTP 薄门面：只做路由、参数解析与响应格式
 * 业务一律走 src/service（编排层），原子能力经 service.core 可达；
 * 任务编排（队列/建任务/取消/瘦身）在 service/job，实例管理在 service/instance
 */
const express = require('express')
const path = require('path')
const fs = require('fs')
const { execFile } = require('child_process')
const svc = require('./src/service')

const app = express()
// PORT 必须一次性归一成**数字**并校验（决策 89）。此前是未校验的字符串，被 5 个地方各自解析：
//  - '0' → Node 合法绑定（随机端口），SELF_BASE 变成 http://127.0.0.1:0/meting，
//    所有 /meting 返回的 url/pic/lrc 自链接全废，启动服务.bat 也打开一个打不开的地址
//  - ' 3000 '（多一个空格，极易手误）→ Node 会 trim 后正常监听 3000，但 instance.js 用
//    endsWith(':' + port) 做字符串比对 → 永远匹配不上 → **防双开守卫静默失效**，
//    两个实例同时跑并互相清扫对方的 .part
//  - 'abc' / '99999' → 启动时才抛 Node 内部的英文错
//  - '0x1F90' → 绑定 8080，但比对时用的是字面 '0x1F90'
const RAW_PORT = process.env.PORT
let PORT = 3000
if (RAW_PORT && String(RAW_PORT).trim() !== '') {
  const n = Number(String(RAW_PORT).trim())
  // 0 也拒：随机端口会让 SELF_BASE 的自链接与 .bat 的自动开浏览器双双失效，且无处可查
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    console.error(`PORT 非法：${JSON.stringify(RAW_PORT)}（应为 1~65535 的整数；0 会随机换端口，使 /meting 自链接与启动脚本全部失效）`)
    process.exit(2)
  }
  PORT = n
}
const PKG_VERSION = require('./package.json').version || 'dev'
// 缺省只监听本机回环：cookie 是账号钥匙，局域网里的陌生设备不该摸到这个服务。
// 确实需要手机/其他设备访问时，用 HOST=0.0.0.0 显式放开（SELF_BASE 同步改，供外部播放器拼绝对地址）
const HOST = process.env.HOST || '127.0.0.1'
const SELF_BASE = process.env.SELF_BASE || `http://127.0.0.1:${PORT}/meting`
// 环境变量给的相对路径按启动 cwd 漂移（裸 node server.js 从别处起会指到别处）——统一绝对化
// 并校验（决策 90）：~ 不做展开会静默建出字面量 "~" 目录；指向一个文件则每首歌都失败在
// ENOTDIR，且报的是服务端 500。用户填错一个值的后果不该是"服务看着正常但一首都下不了"
const rawDownloadDir = process.env.DOWNLOAD_DIR || path.join(__dirname, 'downloads')
const DOWNLOAD_DIR = path.resolve(
  /^~($|[\\/])/.test(rawDownloadDir)
    ? path.join(require('os').homedir(), rawDownloadDir.slice(1))
    : rawDownloadDir,
)
try {
  if (fs.existsSync(DOWNLOAD_DIR) && !fs.statSync(DOWNLOAD_DIR).isDirectory()) {
    console.error(`DOWNLOAD_DIR 不是文件夹：${DOWNLOAD_DIR}`)
    process.exit(2)
  }
} catch (e) {
  console.error(`DOWNLOAD_DIR 无法访问：${DOWNLOAD_DIR} — ${errMsg(e)}`)
  process.exit(2)
}
// 门面直穿 core 的约定：仅限"单次原语调用"（如 /meting 的 song/pic/lrc）；
// 出现循环/组装/策略即下沉 service，不让门面长业务

// 统一错误文案：对象错误 JSON 化，其余取 message（实现下沉 src/core/error.js，
// HTTP 响应 / 任务日志 / 登录错误共用一份，避免两处实现漂移）
const errMsg = svc.core.error.errMsg

// 秒级快速失败（HANDOFF 第二节"除音乐本体外全部秒级快速失败"）：NCM 底层 axios 未设 timeout，
// 网络抖动会让请求无限挂起、接口永远不返回（用户只看到"没反应"）——
// 这里给"取曲 / 榜单 / 状态探测"的调用加等待上限，超时抛可读错误走既有 errMsg 文案。
// 多请求链路（/meting playlist、/recommend、/chart/:id）的 30s 预算与建任务同源，定义在 service/job
const withTimeout = svc.core.retry.withTimeout
// 预算按 2026-10-02 实测校准（本机直连网易）：单接口 70~600ms，200 首歌单全量取曲 ~0.8s，
// 万首大歌单（~21 次串行请求）推算 ~6s。预算取"最坏规模 × 网络劣化余量"，不再是拍脑袋的宽上限：
const FETCH_TIMEOUT = 10 * 1000      // 单请求（实测 ≤0.6s，留 15 倍余量）：/chart、/api/charts（清单缓存命中 0 请求、
                                     // 未命中只 toplist 一次）、/meting 的 lrc/pic
                                     // （song 可逗号分隔多 id、url 有 2 次解析的降级阶梯——两者归多请求口径用 JOB_FETCH_TIMEOUT）
const JOB_FETCH_TIMEOUT = svc.job.JOB_FETCH_TIMEOUT // 串行多请求链路（实测推算最坏 ~6s，留 5 倍余量）

const { missingId, badCount } = svc.params
const { isNotFoundErr, httpStatus } = svc.httputil

/**
 * 纯文本响应（强制 text/plain）。
 * /meting /recommend /chart 这几族历史上用 res.send(字符串)，Express 缺省给 text/html；
 * 而错误文案走 errMsg 会原样带回网易（或代理/劫持页）的响应体——最多 300 字符的 HTML。
 * 用户在浏览器里直接打开 http://127.0.0.1:3000/meting?... 时，那段 HTML 就在**本服务的源**下
 * 执行脚本（cookie 就在同源）。这里统一按纯文本发，浏览器只显示不执行。
 */
const sendPlain = (res, status, msg) => res.type('text/plain; charset=utf-8').status(status).send(msg)

app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))
// JSON 解析失败等进入这里的请求，返回 JSON 而非默认 HTML 错误页（此时 CORS 中间件还没轮到，需自行补头）
app.use((err, req, res, next) => {
  if (err) {
    if (res.headersSent) return next(err) // 响应已发出：再 set 会抛，且这个错误已无法传达给客户端
    // 客户端发坏 JSON 也是要留痕的事件（排查"点了没反应"时能对上时间线），双写落盘
    svc.logger.error('http', `请求体解析失败（${err.status || 500}）${req.method} ${req.path}: ${errMsg(err)}`)
    res.set('Access-Control-Allow-Origin', '*')
    // 与正常 CORS 同口径：预检失败路径也要带上 Methods/Headers，否则浏览器看不到头
    res.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    // body-parser 会把原始请求体挂在 err.body 上，而 errMsg 优先取它 —— 于是
    // `{"source":` 这种坏 JSON 的响应体就是**用户自己那段坏 JSON 的原样回显**，
    // 既不说明问题又等于把输入再吐一遍（决策 88）。改成说人话
    const msg = err.type === 'entity.parse.failed' ? '请求体不是合法 JSON'
      : err.type === 'entity.too.large' ? '请求体过大（上限 100KB）'
        : errMsg(err)
    return res.status(err.status || 500).json({ error: msg })
  }
  next()
})

app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*')
  res.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
  // POST /api/download 发 JSON 会触发预检（Access-Control-Request-Headers: content-type），
  // 缺了 Allow-Headers 浏览器直接拦掉，表现是"按钮点了没反应"
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

// ---------- Meting 兼容端点 ----------
app.get('/meting', async (req, res) => {
  const { type, id, cover } = req.query
  // 五种 type 都要 id：缺 id 时底层 cleanIds 会早退成空数组/抛错， previously 500，
  // 实为客户端缺参，统一 400（提示与 /api/download 的"需要…ID"同口径）
  if (type === 'playlist' || type === 'song' || type === 'lrc' || type === 'pic' || type === 'url') {
    if (missingId(id)) return sendPlain(res, 400, '缺少 id 参数')
  }
  try {
    switch (type) {
      case 'playlist': {
        // 歌单是"1 次详情 + 每 500 首 1 次批量详情"的串行链路，与建任务同口径用 30s 总预算
        const pl = await withTimeout(svc.playlist.get(id), JOB_FETCH_TIMEOUT)
        return res.json(svc.meting.formatSongs(pl.songs, SELF_BASE))
      }
      case 'song': {
        // 逗号分隔多 id 时是分批串行链路（>500 id 有多批）：按多请求口径给 30s 预算，单 id 也无害
        const songs = await withTimeout(svc.core.song.getDetail(id), JOB_FETCH_TIMEOUT)
        return res.json(svc.meting.formatSongs(songs, SELF_BASE))
      }
      case 'lrc': {
        // 与下载写出的 .lrc 同口径：译文按时间戳插在原文行下方（此前只回原文，
        // 同一首歌"下载的歌词有译文、网页面板没有"，两处口径不一致）
        const { lrc, tlyric } = await withTimeout(svc.core.lyric.get(id), FETCH_TIMEOUT)
        const merged = svc.core.lyric.mergeTranslation(lrc, tlyric)
        return res.type('text/plain; charset=utf-8').send(merged || '[00:00.00] 暂无歌词')
      }
      case 'pic': {
        const s = await withTimeout(svc.core.song.getOne(id), FETCH_TIMEOUT)
        // 文案与站内中文口径一致（此前英文 'no pic'，与其他 404 中文案割裂）
        if (!s || !s.picUrl) return sendPlain(res, 404, '暂无封面')
        // 非数字/负数/0 会拼出 param=NaNyNaN 跳到坏图：非法回退 300（缺省同值）
        const rawSize = Number(cover || req.query.size || 300)
        const size = Number.isFinite(rawSize) && rawSize > 0 ? Math.floor(rawSize) : 300
        return res.redirect(s.picUrl + (s.picUrl.includes('?') ? '&' : '?') + `param=${size}y${size}`)
      }
      case 'url': {
        // 默认音质与其他路径一致（缺省无损 2000）；显式 level 优先，非法值 400（显式空串同样拒绝，不静默回退到 br）
        let lv
        try {
          lv = svc.core.quality.toLevel('level' in req.query ? req.query.level : svc.params.brOf(req.query))
        } catch (e) {
          return sendPlain(res, 400, e.message)
        }
        // 降级阶梯（lossless 无资源回退 exhigh）最多 2 次串行解析，慢网 2×4~6s 会撞 10s 单请求
        // 预算——归多请求口径用 30s 预算（与建任务管线对同一解析给的预算对齐，不再互相矛盾）
        const r = await withTimeout(svc.resolve.resolveWithFallback(id, { level: lv }), JOB_FETCH_TIMEOUT)
        if (req.query.format === 'json') {
          return res.json([{ url: r.url, size: r.size, br: r.br, level: r.level, type: r.type }])
        }
        return res.redirect(r.url)
      }
      default:
        return sendPlain(res, 400, 'type 非法，支持：playlist / song / url / pic / lrc')
    }
  } catch (err) {
    svc.logger.error('http', `GET /meting（type=${type} id=${id}）: ${errMsg(err)}`)
    // 找不到类（如下游 404/空歌单）归 404，其余 500（此前一律 500，客户端无法区分缺参/无资源与服务端故障）
    sendPlain(res, httpStatus(err), errMsg(err))
  }
})

// ---------- 个性化推荐 ----------
const RECOMMEND_SOURCES = {
  daily: () => svc.recommend.daily().then((songs) => ({ songs })),
  fm: (q) => svc.recommend.fm({ mode: q.mode, total: Number(q.total || q.limit) || 30 }),
  heart: (q) => svc.recommend.heartMode(q.pid, q.id, { count: Number(q.count) || 100 }).then((songs) => ({ songs })),
  simi: (q) => svc.recommend.simi(q.id, { total: Number(q.total) || 30 }),
}

app.get('/recommend/:source', async (req, res) => {
  // hasOwn 查表：source='constructor' 会取到 Object.prototype.constructor（真值），
  // 通过 !fn 检查后被当函数调用 → 500 + JavaScript 内部错误（决策 77，与 job.js 同口径）
  const fn = Object.hasOwn(RECOMMEND_SOURCES, req.params.source) ? RECOMMEND_SOURCES[req.params.source] : undefined
  // 未知来源是客户端传参错，与 /api/download 同口径归 400（此前 404，与建任务入口不一致）
  if (typeof fn !== 'function') return sendPlain(res, 400, '未知来源，支持：daily / fm / heart / simi')
  // 各源必填与数量校验：缺 id/传非法数量时底层会空查或静默回退成缺省数，提前 400 让调用方立刻发现
  const q = req.query
  if (req.params.source === 'simi' && missingId(q.id)) return sendPlain(res, 400, 'simi 来源需要歌曲 ID')
  if (req.params.source === 'heart' && (missingId(q.pid) || missingId(q.id))) return sendPlain(res, 400, 'heart 来源需要歌单 ID（pid）与歌曲 ID（id）')
  if (req.params.source === 'fm' && (('total' in q && badCount(q.total)) || ('limit' in q && badCount(q.limit)))) return sendPlain(res, 400, '数量参数非法，应为大于 0 的数字')
  if (req.params.source === 'simi' && ('total' in q && badCount(q.total))) return sendPlain(res, 400, '数量参数非法，应为大于 0 的数字')
  if (req.params.source === 'heart' && ('count' in q && badCount(q.count))) return sendPlain(res, 400, '数量参数非法，应为大于 0 的数字')
  // fm/simi 数量上限与建任务入口同源（循环拉批撞 30s 预算只会白烧请求）
  if ((req.params.source === 'fm' || req.params.source === 'simi') && Number(q.total) > svc.job.MAX_RECOMMEND_TOTAL) {
    return sendPlain(res, 400, `数量过大（上限 ${svc.job.MAX_RECOMMEND_TOTAL}），请分批请求`)
  }
  try {
    // 整条路由统一用链路预算：fm/simi 是循环拉批（串行多请求），daily/heart 虽是单请求但 30s 只是上限宽、
    // 对它无害——按 source 分别取预算徒增复杂度
    const { songs, batches } = await withTimeout(fn(req.query), JOB_FETCH_TIMEOUT)
    if (!songs.length) return sendPlain(res, 404, '无推荐内容（检查登录状态）')
    if (req.query.format === 'raw') return res.json({ batches, count: songs.length, songs })
    return res.json(svc.meting.formatSongs(songs, SELF_BASE))
  } catch (err) {
    svc.logger.error('http', `GET /recommend/${req.params.source}: ${errMsg(err)}`)
    // 找不到类归 404（如 heart 的歌单不存在），其余 500
    sendPlain(res, httpStatus(err), errMsg(err))
  }
})

// ---------- 下载 ----------
// 旧版同步 GET /download/* 已改造为异步任务端点（返回 jobId，与 /api/download 同源，
// 走同一个全局串行队列）——编排见 service/job.createTask

// ---------- 排行榜 ----------
app.get('/chart', async (req, res) => {
  try {
    return res.json(await withTimeout(svc.chart.charts(req.query.refresh === '1'), FETCH_TIMEOUT))
  } catch (err) {
    svc.logger.error('http', `GET /chart: ${errMsg(err)}`)
    sendPlain(res, httpStatus(err), errMsg(err))
  }
})

app.get('/chart/:id', async (req, res) => {
  try {
    // 冷缓存时 = 清单 1 次 + 歌单详情 1 次 + 每 500 首 1 批详情 → 串行链路，用 30s 预算（热缓存时更快）
    // limit 口径与歌单一致：0/空/非法视为全量（playlist.get 内已收敛），此处不额外 400
    const chart = await withTimeout(svc.chart.get(req.params.id, { limit: Number(req.query.limit) || undefined }), JOB_FETCH_TIMEOUT)
    if (req.query.format === 'raw') return res.json(chart)
    return res.json(svc.meting.formatSongs(chart.songs, SELF_BASE))
  } catch (err) {
    svc.logger.error('http', `GET /chart/${req.params.id}: ${errMsg(err)}`)
    // "找不到榜单"归 404，其余 500（此前一律 500，不存在的榜单名也被报成服务端故障）
    sendPlain(res, httpStatus(err), errMsg(err))
  }
})

// ==================== Web UI 专用 API ====================

/**
 * 下载任务建任务入口（Web UI 的 POST /api/download 与旧版 GET /download/* 共用）：
 * 校验/取曲/增量对账/入队都在 service/job.createTask，门面只把 {code, body} 回给客户端
 * 显式 .catch(next) 兜住 createTask 内部 try 之外的意外抛出：Express 5 会把 async 处理器的
 * 拒绝转给错误中间件，但没有这行时返回的 Promise 是悬空的——请求永远不结束，
 * 浏览器一直转圈，按钮 800ms 后恢复却什么提示都没有
 */
async function createDownloadJob(paramsBody, res, next) {
  const { code, body } = await svc.job.createTask(paramsBody || {}, { downloadDir: DOWNLOAD_DIR })
  return res.status(code).json(body)
}
const runDownloadJob = (p, res, next) => { createDownloadJob(p, res, next).catch(next) }

app.post('/api/download', (req, res, next) => runDownloadJob(req.body, res, next))

// 旧版下载端点：语义从"同步等全部下完"改为"创建任务返回 jobId"（同一全局队列）
app.get('/download/:source', (req, res, next) => runDownloadJob({ ...req.query, source: req.params.source }, res, next))

app.get('/download/chart/:id', (req, res, next) => runDownloadJob({ ...req.query, source: 'chart', id: req.params.id }, res, next))

app.get('/api/job/:id', (req, res) => {
  const job = svc.job.jobs.get(req.params.id)
  if (!job) return res.status(404).json({ error: '任务不存在' })
  // 句柄含函数与 Abort 控制器，不得直接序列化（见 job.toPublicJob 注释）。
  // logTotal 与 /api/jobs 的终端态形状对齐（运行态保全量日志，logTotal = 全长）
  res.json({ ...svc.job.toPublicJob(job), logTotal: (job.log || []).length })
})

app.delete('/api/job/:id', (req, res) => {
  const { code, body } = svc.job.cancelJob(req.params.id)
  res.status(code).json(body)
})

app.get('/api/jobs', (req, res) => {
  // 列表轮询瘦身（前端 1.5s 一次）：done/error/cancelled 任务把日志截到最后 100 行、去掉逐首 files 与
  // 跳过明细（前端用不到，报告已落盘）——挂几个大任务过夜时不再每 1.5s 重传几十 KB。
  // running/queued 保持全量（前端贴底跟随依赖完整日志增量）；要完整数据走 /api/job/:id。
  // cancelled 同为终端态，同样瘦身（其 log 末尾的"已取消"在 slice(-100) 内，不会丢结论）。
  // 所有出参统一过 slimJob：既瘦身又摘掉 queue 句柄（此前详情/列表都直接透出 handle，含不可序列化的函数与控制器）。
  // 截断必须保活动任务：串行队列下一个 600 首任务跑 1~2 小时，期间排满 20 个新任务时
  // 按 startedAt 一刀切会把运行中的卡片挤出列表（失去进度与取消入口）——
  // running/queued 全量入列（队列本身串行，活动任务远少于 20），终端态按时间补足到 20 条
  const sorted = [...svc.job.jobs.values()].sort((a, b) => b.startedAt - a.startedAt)
  const active = sorted.filter((j) => j.status === 'running' || j.status === 'queued')
  const terminal = sorted.filter((j) => j.status !== 'running' && j.status !== 'queued')
  const list = [...active, ...terminal.slice(0, Math.max(0, 20 - active.length))].map((j) => svc.job.slimJob(j))
  res.json(list)
})

// ---- 榜单清单（下拉框用） ----
// 10 分钟缓存命中时 0 请求，未命中/refresh=1 才 fetchToplist 一次 → 归单请求口径，用 FETCH_TIMEOUT
app.get('/api/charts', async (req, res) => {
  try {
    res.json(await withTimeout(svc.chart.charts(req.query.refresh === '1'), FETCH_TIMEOUT))
  } catch (err) {
    // 与 /chart、/chart/:id 同口径落盘：榜单下拉框是 UI 里唯一走这个端点的地方，
    // 它持续失败时界面只显示"加载失败，点击重试"，不留任何痕迹就无法事后排查
    svc.logger.error('http', `GET /api/charts: ${errMsg(err)}`)
    res.status(httpStatus(err)).json({ error: errMsg(err) })
  }
})

// ---- 扫码登录（cookie 失效时在网页里完成） ----
// status 是给界面看的显示态；busy 是"有没有轮询在跑"的独占标记，两者必须分开：
// pollQr 只回调 'scanned'/'ok'，从不下发 'running'，此前拿 status==='running' 当重入守卫
// 结果是用户扫码后（状态已变 'scanned'）再点一次"重新扫码登录"会开出第二个 key 与第二条轮询，
// 而第一条成功后的 cleanupQr 会把共用的 qr.png 删掉——那是第二条的二维码。
// loginGen 是代号：只有最新一轮有权改状态与删二维码，迟到的旧轮次只能安静收尾
const loginState = { status: 'idle', error: null, busy: false }
let loginGen = 0
const QR_PATH = path.join(__dirname, 'qr.png')

app.get('/api/login/start', async (req, res) => {
  if (loginState.busy) return res.json({ started: true, already: true })
  loginState.busy = true
  loginState.status = 'running'
  loginState.error = null
  const gen = ++loginGen
  // 终态（成功/过期/超时/异常）后二维码即失效：删掉图片文件，不在工作区残留。
  // 只有代号匹配的轮次能删——共用同一个 qr.png 路径，删错的就是新一轮的码
  const cleanupQr = () => {
    if (gen !== loginGen) return
    try { fs.unlinkSync(QR_PATH) } catch { /* 已不存在则无事 */ }
  }
  try {
    // 先同步生成二维码，响应返回时图片必定存在（前端随即拉取不会 404）
    const key = await svc.login.createQr(QR_PATH)
    svc.logger.log('login', '开始扫码登录（二维码已生成）')
    svc.login.pollQr(key, {
      timeout: 180000,
      onStatus: (s) => { if (gen === loginGen) loginState.status = s },
    }).then(() => {
      cleanupQr()
      loginState.busy = false
      if (gen !== loginGen) return // 已被新一轮接管：不覆写它的状态
      loginState.status = 'ok'
      svc.logger.log('login', '扫码登录成功，cookie 已保存')
    }).catch((e) => {
      cleanupQr()
      loginState.busy = false
      if (gen !== loginGen) return
      loginState.status = 'error'
      loginState.error = errMsg(e)
      svc.logger.error('login', `扫码登录失败: ${errMsg(e)}`)
    })
    res.json({ started: true })
  } catch (e) {
    // createQr 抛错时也要清图：否则留在工作区的 qr.png 会被后续 /api/login/qr 当成有效码发出去，
    // 而它的 key 已经失效（网易立刻回 800），用户扫码永远失败
    cleanupQr()
    loginState.busy = false
    loginState.status = 'error'
    loginState.error = errMsg(e)
    svc.logger.error('login', `扫码登录启动失败: ${errMsg(e)}`)
    res.status(500).json({ error: errMsg(e) })
  }
})

app.get('/api/login/status', (req, res) => {
  res.json({ status: loginState.status, error: loginState.error, cookie: svc.core.cookie.has() })
})

app.get('/api/login/qr', (req, res) => {
  // 引号用全角“”（与站内中文案一致，此前半角 "" 在中文句式里割裂）
  if (!fs.existsSync(QR_PATH)) return res.status(404).json({ error: '二维码尚未生成，请先点击“重新扫码登录”' })
  // 客户端中断连接时 sendFile 会带错回调：此时头已发出，再 status() 会抛 ERR_HTTP_HEADERS_SENT
  res.sendFile(QR_PATH, (e) => { if (e && !res.headersSent) res.status(404).json({ error: '二维码读取失败' }) })
})

// ---- 健康探测：防双开识别 + 进程健康检查用（专用路径，静态文件不会遮蔽它） ----
app.get('/api/ping', (req, res) => {
  res.type('text/plain; charset=utf-8').send('netease-music-service')
})

// ---- 打开下载目录（execFile 免去 shell 解析；3 秒节流防连点） ----
// 按目标目录分别节流：全局单时间戳会把"连点不同批次文件夹"也吞掉（第二个目录打不开 yet 返回 ok:true 误导前端），
// 此处 Map<target, 上次打开时刻> + throttled 回执，前端可据此提示"操作太快"
// 缺省跟随当前目的地（目的地切到哪，打开的就是哪）；?dest=default 显式指回缺省下载根；
// phone 目的地的文件在设备上，电脑端 explorer 打不开，明确 400
const lastOpenByDir = new Map()
app.get('/api/open-folder', (req, res) => {
  const destQuery = req.query.dest
  let root
  if (destQuery === 'default') {
    // 显式指回缺省下载根：激活目的地是手机时用户仍有机会打开电脑端的默认目录
    root = DOWNLOAD_DIR
  } else if (destQuery) {
    const d = svc.dest.get(String(destQuery))
    if (!d) return res.status(404).json({ error: '下载位置不存在' })
    if (d.kind === 'phone') return res.status(400).json({ error: '手机上的文件夹无法在电脑上直接打开' })
    // 目的地指向的目录已消失（U 盘拔出/网络盘断开）：如实报错，不悄悄 mkdir 重建——
    // 重建会掩盖"目的地失效"这一事实，用户以为在往原位置存歌
    if (!fs.existsSync(d.path)) return res.status(404).json({ error: `下载位置当前不可访问（目录不存在）: ${d.path}` })
    root = d.path
  } else {
    // 缺省跟随当前目的地（目的地切到哪，打开的就是哪）；手机目的地同样 400
    const dest = svc.dest.resolve(DOWNLOAD_DIR)
    if (dest.kind === 'phone') return res.status(400).json({ error: '手机上的文件夹无法在电脑上直接打开' })
    root = dest.base
  }
  fs.mkdirSync(root, { recursive: true })
  // 可选 name：打开某一批次子目录；必须解析后仍落在目的地根内（拒绝 . / .. 穿越）
  let target = root
  if (req.query.name) {
    const resolvedRoot = path.resolve(root)
    const leaf = path.basename(String(req.query.name))
    const cand = path.resolve(resolvedRoot, leaf)
    // 按 Win32 的实际归一规则先收拾一遍 leaf 再判包含关系：文件系统把结尾的点和空格吃掉，
    // "?name=..%20" 的字符串前缀检查是过的（'C:\root\.. ' 以 'C:\root\' 开头），
    // 但 existsSync/explorer 看到的是 'C:\' —— 检查通过、实际打开了目的地根之外的目录。
    // 同时禁掉 ':'（NTFS 备用数据流）与其它 Win32 非法字符：它们同样能穿透前缀检查
    const normLeaf = leaf.replace(/[ .]+$/, '')
    const relative = path.relative(resolvedRoot, cand)
    const contained = normLeaf && normLeaf !== '.' && normLeaf !== '..' &&
      !/[:*?"<>|\u0000-\u001f]/.test(leaf) &&
      relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
    if (contained) target = cand
  }
  // 实际打开的目录：目标被删了就退回根目录（此前 exec 用回退路径、回包却报不存在的 target，前后端口径分裂）
  const opened = fs.existsSync(target) ? target : root
  const now = Date.now()
  const last = lastOpenByDir.get(target) || 0
  let throttled = false
  if (now - last > 3000) {
    // Map 无界增长兜底：按目录节流的条目数没有自然上限。
    // 淘汰最旧一条而不是整体清零——key 的叶子半段来自用户可控的 ?name=，攒够 501 个不同名字
    // 再点一次真实目录就能把清零触发出来，等于节流被绕过、连点会真的连弹一堆 explorer 窗口
    if (!lastOpenByDir.has(target) && lastOpenByDir.size > 500) {
      lastOpenByDir.delete(lastOpenByDir.keys().next().value)
    }
    lastOpenByDir.set(target, now)
    // explorer.exe 打开成功后自己 detach 并以退出码 1 结束——Windows 已知行为，不是失败。
    // 此前无条件 console.error('explorer 打开失败')，让"文件夹到底开没开"这道排查线索永远是假的
    execFile('explorer', [opened], (e) => {
      if (e && e.code !== 1) console.error('explorer 打开失败:', opened, e.message || e)
    })
  } else {
    throttled = true
  }
  res.json({ ok: true, dir: opened, throttled })
})

// ---- 下载位置（目的地）：列表 / 添加 / 激活 / 删除；pick 弹原生文件夹选择对话框 ----
// pick 是阻塞调用（PowerShell FolderBrowserDialog，实现在 core/dialog.pickFolder）：
// 单实例锁防连点叠出多个对话框；5 分钟无操作超时
let pickInFlight = false

app.get('/api/dest', (req, res) => {
  res.json({ list: svc.dest.list(), active: svc.dest.activeId(), defaultDir: DOWNLOAD_DIR })
})

app.post('/api/dest', async (req, res) => {
  const b = req.body || {}
  try {
    if (b.action === 'pick') {
      if (pickInFlight) return res.status(409).json({ error: '文件夹选择对话框已在打开中，请先完成或取消' })
      pickInFlight = true
      try {
        const p = await svc.core.dialog.pickFolder()
        if (!p) return res.status(400).json({ error: '已取消选择' })
        const dest = svc.dest.addLocal(p)
        return res.json({ ok: true, dest, list: svc.dest.list(), active: svc.dest.activeId() })
      } finally { pickInFlight = false }
    }
    if (b.action === 'addLocal') {
      const dest = svc.dest.addLocal(String(b.path || ''))
      return res.json({ ok: true, dest, list: svc.dest.list(), active: svc.dest.activeId() })
    }
    if (b.action === 'addPhone') {
      const dest = svc.dest.addPhone(String(b.path || ''))
      return res.json({ ok: true, dest, list: svc.dest.list(), active: svc.dest.activeId() })
    }
    return res.status(400).json({ error: '未知 action（支持 pick / addLocal / addPhone）' })
  } catch (err) {
    // PowerShell 缺失是环境故障（500），用户路径错是入参错（400）——混成 400 会让前端把环境问题当"路径填错"
    return res.status(err && err.noPowerShell ? 500 : 400).json({ error: errMsg(err) })
  }
})

// 文件系统类故障归 500、参数类归 400：与 /api/dest 的处理同一口径。
// destinations.json 只读/磁盘满/被编辑器锁住时是服务端环境问题，混成 400 会让前端
// 提示"下载位置不存在"，用户去反复重选文件夹，而真正的原因（写不进去）没人看得到
const FS_FAULT_CODES = ['EACCES', 'EPERM', 'EROFS', 'ENOSPC', 'EMFILE', 'ENFILE', 'EBUSY']
const statusForDestErr = (err) => (err && FS_FAULT_CODES.includes(err.code) ? 500 : 400)

app.post('/api/dest/active', (req, res) => {
  // body 为 JSON 原始类型（"abc"/123/数组）时 'id' in req.body 会抛 TypeError 归 500，
  // 实为客户端传参错——先判型归 400。
  // 缺 body 更要拦：Express 5 没有 urlencoded 解析器，text/plain 或表单 POST 会让
  // req.body 保持 undefined，原写法于是走 id='' 分支把目的地**静默改回缺省**并持久化——
  // 一次格式错误的请求就全局改了下载位置，返回的还是 200 {ok:true}
  const b = req.body
  if (!b || typeof b !== 'object' || Array.isArray(b)) {
    return res.status(400).json({ error: '需要 JSON 请求体，例如 {"id":"d1"}' })
  }
  try {
    // 空串是合法输入：dest.setActive('') 就是"切回缺省 downloads\"（下拉框第一项传的就是空串）
    const id = b.id == null ? '' : String(b.id)
    svc.dest.setActive(id)
    res.json({ ok: true, active: svc.dest.activeId(), list: svc.dest.list() })
  } catch (err) { res.status(statusForDestErr(err)).json({ error: errMsg(err) }) }
})

app.delete('/api/dest/:id', (req, res) => {
  // 不存在归 404（与 /api/job/:id、open-folder 的"资源不存在"口径一致，此前 400 混入参数错误）
  if (!svc.dest.get(req.params.id)) return res.status(404).json({ error: `下载位置不存在: ${req.params.id}` })
  try {
    svc.dest.remove(req.params.id)
    res.json({ ok: true, active: svc.dest.activeId(), list: svc.dest.list() })
  } catch (err) { res.status(statusForDestErr(err)).json({ error: errMsg(err) }) }
})

// ---- ADB 状态（手机直写的基础可用性）：就绪/未授权/无设备/未装 adb 四态 + 设备型号，5s 缓存 ----
app.get('/api/adb', (req, res) => {
  res.json(svc.adb.status())
})

app.get('/api/status', async (req, res) => {
  // cookie 有效性探测（缓存/四态语义在 service/login.probeCookieState）：
  // missing / valid / expired / unknown（unknown = 探测没跑成，如断网/502/超时）
  const cookieState = await svc.login.probeCookieState()
  // 当前生效目的地：kind（default/local/phone）+ 名称；UI 据此展示与校验
  const dest = svc.dest.resolve(DOWNLOAD_DIR)
  res.json({ cookie: cookieState, downloadDir: DOWNLOAD_DIR, dest: { kind: dest.kind, id: dest.id, name: dest.name, base: dest.base } })
})

// ---- 未知路径的兜底：/api/* 一律 JSON 404 ----
// Express 对未匹配路径返回自带的 HTML 错误页，而前端 api() 按 JSON 解析它会抛，
// 错误文案变成"Unexpected token <"，用户完全看不出是路径打错了。
// 非 /api 路径（静态资源/未知页面）仍走 Express 默认行为，不是 API 契约的一部分
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    res.set('Access-Control-Allow-Origin', '*')
    res.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    return res.status(404).json({ error: `接口不存在: ${req.method} ${req.path}` })
  }
  next()
})

// 根路径 `/` 由静态中间件返回 Web UI 首页（曾有一个纯文本帮助路由，被静态遮蔽从未可达，已删；
// 端点清单见 HANDOFF.md 第七节，健康探测用 /api/ping）

// 兜底错误处理：注册在所有路由之后——路由内同步抛错或 async 拒绝都能返回 JSON（而非默认 HTML 错误页）
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err)
  svc.logger.error('http', `未处理错误 ${req.method} ${req.path}: ${errMsg(err)}`)
  res.set('Access-Control-Allow-Origin', '*')
  // 错误路径也要带 CORS（前端 fetch 才能读到 JSON 而非 CORS 空错，此前只补了 Origin）
  res.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  // NCM 的 404 载体走到这里也按 httpStatus 归 404（此前兜底只认 err.status，body.code=404 会被抬成 500）
  const st = (err && err.status) || httpStatus(err) || 500
  res.status(st).json({ error: errMsg(err) })
})

if (require.main === module) {
  // 进程级兜底：崩溃时 stderr 随控制台窗口一起消失，service.log 是唯一幸存者。
  // 只在作为主程序运行时注册——被测试 import 时不得劫持测试进程的异常处理
  process.on('uncaughtException', (e) => {
    svc.logger.error('process', `服务遇到未捕获异常，即将退出: ${e && e.stack ? e.stack : svc.core.error.errMsg(e)}`)
    process.exit(1)
  })
  process.on('unhandledRejection', (r) => {
    svc.logger.error('process', `未处理的 Promise 拒绝（不影响运行）: ${svc.core.error.errMsg(r)}`)
  })
  ;(async () => {
    if (await svc.instance.stopOldService(PORT)) svc.logger.log('server', '已停止旧服务实例（防止双开）')
    const swept = svc.storage.sweepDownloads(DOWNLOAD_DIR)
    if (swept) svc.logger.log('server', `启动清扫: 已清理 ${swept} 个半成品（.part/.tagtmp）`)
    const server = app.listen(PORT, HOST, () => {
      console.log(`netease-music-service 已启动: http://127.0.0.1:${PORT}`)
      if (HOST === '0.0.0.0') console.log('已放开监听所有网卡（HOST=0.0.0.0），局域网内其他设备可访问——cookie 泄露风险自负')
      // 启动横幅：环境一屏可查（node 版本 / 应用版本 / cookie / 生效目的地 / adb 初始状态）
      const dest = svc.dest.resolve(DOWNLOAD_DIR)
      const adbState = svc.adb.status()
      svc.logger.log('server', `启动完成 PORT=${PORT} HOST=${HOST} PID=${process.pid} Node=${process.version} 版本=${PKG_VERSION} 下载根=${DOWNLOAD_DIR} 目的地=${dest.name}(${dest.kind}) cookie=${svc.core.cookie.has() ? '已加载' : '未配置'} adb=${adbState.state}`)
    })
    server.on('error', (e) => {
      if (e.code === 'EADDRINUSE') {
        // 探一下占用者是不是本服务旧实例（/api/ping 专用路径）：旧实例停止失败未退干净时
        // 文案不能误导用户去查"其他程序"
        svc.instance.isOurs(PORT).then((ours) => {
          svc.logger.error('server', ours
            ? `端口 ${PORT} 被另一个本服务实例占用且停止失败，无法启动——请用"停止服务.bat"结束旧实例后重试`
            : `端口 ${PORT} 被其他程序占用，无法启动（可用 netstat -ano | findstr ${PORT} 定位占用进程）`)
          process.exit(1)
        }).catch(() => {
          svc.logger.error('server', `端口 ${PORT} 被占用，无法启动（探测占用者失败，可用 netstat -ano | findstr ${PORT} 定位）`)
          process.exit(1)
        })
        return
      }
      svc.logger.error('server', `监听失败: ${svc.core.error.errMsg(e)}`)
      process.exit(1)
    })
  })().catch((e) => {
    svc.logger.error('server', `启动失败: ${svc.core.error.errMsg(e)}`)
    process.exit(1)
  })
}

// 导出面收敛到外部真正需要的：stop.js 用 PORT/findListenerPid/stopOldService（实现已下沉
// service/instance，此处再导出保住旧引用），测试用 app；
// _test 只暴露纯本地可测的小函数（404 映射/出参净化/参数校验），不含任何 IO，单测可直调；
// _internals.jobs 必须是 service/job 里那份共享 Map 实例（测试直接注假任务/清场恢复）
module.exports = {
  app, PORT, SELF_BASE,
  stopOldService: svc.instance.stopOldService,
  findListenerPid: svc.instance.findListenerPid,
  isOurs: svc.instance.isOurs,
  _test: { isNotFoundErr, httpStatus, toPublicJob: svc.job.toPublicJob, slimJob: svc.job.slimJob, missingId, badCount, flagOn: svc.params.flagOn },
  _internals: { lastOpenByDir, jobs: svc.job.jobs },
}
