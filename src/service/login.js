/**
 * 登录服务：二维码轮询策略 + cookie 落盘
 * 单步原语来自 core.login；"自动打开图片"等桌面交互是 CLI 关切，不在服务层起外部进程
 */
const path = require('path')
const core = require('../core')
const logger = require('./logger')

/**
 * 只生成二维码（同步等待图片落盘），返回 key 供后续轮询
 * 适合 Web 场景：先确保二维码文件存在，再异步轮询，避免前端拿到 404 图片
 */
async function createQr(qrPath) {
  // 每一跳都必须有超时（决策 93）：NeteaseCloudMusicApi 的 agent **完全没有 timeout 配置**，
  // 而音乐.163.com 在"TCP 连上但不回包"（酒店/公司网关黑洞）时会永久挂起。
  // 未加超时时 /api/login/start 永不返回 → loginState.busy 永不清 → 之后每次点登录都拿到
  // {"already":true} 并对着一张旧码死等 → **除非重启服务否则再也登不上**，且首次点击时
  // 前端连弹窗都不开（弹窗在 await 之后才 open），按钮看起来完全失灵
  const key = await core.retry.withTimeout(core.login.createQrKey(), 10000)
  await core.retry.withTimeout(core.login.createQrImage(key, qrPath), 15000)
  return key
}

/**
 * 轮询扫码状态直到成功/过期/超时，cookie 自动保存
 * 轮询期瞬时网络错误自动重试（终态错误直接上抛，超时统一报"登录超时"）
 * @returns 成功后的 cookie 字符串
 */
async function pollQr(key, { timeout = 180000, onStatus = () => {} } = {}) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    await new Promise((r) => setTimeout(r, 2000))
    let st
    try {
      // 单次轮询也要有超时（决策 93）：外层 while 的 timeout 检查只在**两轮之间**跑，
      // 一次挂死的 checkQr 能让整个 180s 预算形同虚设，用户永远看不到"登录超时"
      st = await core.retry.withTimeout(core.login.checkQr(key), 10000)
    } catch (err) {
      // 轮询期网络抖动（DNS/超时/连接重置等瞬时错误）不判死：2s 后下一轮继续，
      // 由外层 timeout 统一收尾为"登录超时"；终态错误（isTransient=false）直接上抛，
      // 避免把"key 非法"这类本可速败的问题拖成 3 分钟 hanging
      if (!core.error.isTransient(err)) throw err
      continue
    }
    const { code, cookie } = st
    if (code === 800) throw new Error('二维码已过期，请重新登录')
    if (code === 802) onStatus('scanned')
    if (code === 803) {
      // 803 却没带 cookie 是异常响应形态：此时绝不能把盘上可能有效的好 cookie 覆盖成空串
      // （cookie.save 对空串照写不误）——如实抛错保留现有登录态，用户重试即可
      if (!cookie || !String(cookie).trim()) {
        throw new Error('登录响应异常（扫码成功但未返回 cookie），已保留现有登录态，请重试')
      }
      core.cookie.save(cookie)
      onStatus('ok')
      return core.cookie.get()
    }
  }
  throw new Error('登录超时')
}

/**
 * 扫码登录全流程（CLI 用）：生成二维码 → 轮询 → 落盘
 * @param {object} opts
 *   - qrPath: 二维码图片路径（默认项目根 qr.png）
 *   - open: 生成后调用 onOpen(qrPath)（CLI 传它来打开看图器；服务层不碰外部进程，缺省不打开）
 *   - timeout: 超时毫秒（默认 180000）
 *   - onStatus: (msg) => void，waiting / scanned / ok
 */
async function qrLogin({ qrPath = path.join(__dirname, '../../qr.png'), open = false, onOpen, timeout = 180000, onStatus = () => {} } = {}) {
  const key = await createQr(qrPath)
  if (open && typeof onOpen === 'function') onOpen(qrPath)
  onStatus('waiting')
  return pollQr(key, { timeout, onStatus })
}

// ---- cookie 有效性探测（/api/status 用）：5 分钟缓存，cookie 值一变即失效重探 ----
// cookie = 被探测过的那串 cookie（值变化覆盖网页扫码与另一进程的 login.js 扫码登录），
// at = 最近一次探测时刻，valid = 探测结论（null = 尚未知）
const PROBE_TIMEOUT = 5 * 1000    // login_status 探测（实测 ~70ms）：单请求、最多 5 分钟一次，5s 内必须给出结论
const PROBE_CACHE_MS = 5 * 60 * 1000
let cookieProbe = { at: 0, cookie: null, valid: null }
// 登录态翻转告警去重（边缘触发）：上次对外呈现过的状态，翻到 expired / 从 expired 恢复才落日志
let lastCookieState = null
// 同一 cookie 的并发探测共享一次请求：缓存过期瞬间前端的轮询与详情页同时打 /api/status，
// 不去重会对 login_status 连发两发（共享 Promise，谁先到谁发起，后来者同结果）
let probeInFlight = null // { cookie, promise }

/**
 * 探测当前 cookie 是否有效，返回 missing / valid / expired / unknown
 * unknown = 探测没跑成（断网/502/超时/限流）：只记探测时刻防连环重探、不写结论，到期自动重探；
 * 只有服务端真实答复（301 未登录等 3xx/4xx）才定性为 expired——网络故障被误判成"登录过期"
 * 会让用户白扫一次码（此前正是这样误判）
 */
async function probeCookieState() {
  if (!core.cookie.has()) return 'missing'
  const current = core.cookie.get()
  // cookie 变了（新登录落盘）→ 缓存立即失效，本轮就重探，不让用户登录成功后还看到"已过期"
  if (cookieProbe.cookie !== current) cookieProbe = { at: 0, cookie: current, valid: null }
  if (Date.now() - cookieProbe.at > PROBE_CACHE_MS) {
    if (!probeInFlight || probeInFlight.cookie !== current) {
      const promise = (async () => {
        try {
          // 等待超时被 withTimeout 拦下时是 Error、没有 body——同样落进下面"探测没跑成"的分支
          const r = await core.retry.withTimeout(core.raw('login_status'), PROBE_TIMEOUT)
          cookieProbe = { at: Date.now(), cookie: current, valid: Boolean(r.body.data && r.body.data.code === 200) }
        } catch (e) {
          // NCM 库用普通对象 reject：body.code 5xx/429 是它对传输失败（DNS/连接中断/超时/限流）的统一改写，
          // 无 body 的超时/断网同理——都属于"探测没跑成"而不是"cookie 过期"
          const code = e && e.body && Number(e.body.code)
          const unknown = !Number.isFinite(code) || code === 429 || (code >= 500 && code < 600)
          if (unknown) cookieProbe.at = Date.now()
          else cookieProbe = { at: Date.now(), cookie: current, valid: false }
        }
      })()
      probeInFlight = { cookie: current, promise }
      promise.finally(() => { if (probeInFlight && probeInFlight.promise === promise) probeInFlight = null })
    }
    await probeInFlight.promise
  }
  // valid === null（从未探成，如首轮即断网）如实报 unknown，不谎称 valid（此前缺省 valid 会误导"已登录"）
  const state = cookieProbe.valid === false ? 'expired' : cookieProbe.valid === true ? 'valid' : 'unknown'
  // 登录态过期此前零痕迹（cookie 从 valid 翻 expired 用户只能靠网页上偶然的失败感知），翻转时落一条
  if (state !== lastCookieState) {
    if (state === 'expired') logger.error('login', '登录态已过期（网页会提示重新扫码登录）')
    else if (state === 'valid' && lastCookieState === 'expired') logger.log('login', '登录态已恢复（cookie 已更新）')
    lastCookieState = state
  }
  return state
}

module.exports = { qrLogin, createQr, pollQr, probeCookieState }
