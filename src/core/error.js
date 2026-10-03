/**
 * 错误文案核心模块：把失败载体归一成可读文案（纯映射，无 IO）
 *
 * NCM 库（NeteaseCloudMusicApi）失败时 reject 的是普通对象 { status, body, cookie }
 * 而不是 Error —— 调用方直接取 .message 会拿到 undefined。统一口径放这里，
 * 供 HTTP 响应、下载任务日志、登录错误提示共用，避免两份实现漂移：
 * 带 body 的对象错误 JSON 化（body 是字符串则直接用），其余取 message，最后兜底 String(err)
 */
// string body 上限：NCM 对非 JSON 响应会把整个响应体塞进 body（代理/劫持时常是整页 HTML），
// 任务日志每首失败都要存、/api/jobs 又被前端高频轮询，几十 KB 一条会把响应撑爆
const MAX_BODY_LEN = 300

// 错误载体里可能有循环引用（NCM 的 body 理论上是解析后的 JSON，但代理/拦截器塞进来的
// 未必是）：JSON.stringify 遇环会抛 TypeError，而调用方是在"处理一个错误"的路径上调我们，
// 这里抛会把调用方的真正错误顶掉 —— 拿不到字符串时退回 String(err.body)
function safeText(v) {
  if (typeof v === 'string') return v
  if (v == null) return ''
  try { return JSON.stringify(v) } catch { return String(v) }
}

function errMsg(err) {
  // 显式分支而非 && || 链：err 存在但 body/message 都空时（如 {status:503, body:null}）
  // 会掉进 String(err) 产出 "[object Object]"，把唯一的 status 线索也丢了
  let m
  if (!err || typeof err !== 'object') {
    m = String(err)
  } else if (typeof err.body === 'string') {
    m = err.body
  } else if (err.body != null) {
    m = safeText(err.body)
  } else if (err.message) {
    m = err.message
  } else {
    m = err.status != null ? `HTTP ${err.status}` : String(err)
  }
  m = String(m)
  // 只截 string body 分支：JSON body（{code,msg} 几十字节）与 e.message 分支行为不变，
  // HTTP 侧正常错误文案（几十字节）也不会触及上限
  if (err && typeof err.body === 'string' && m.length > MAX_BODY_LEN) {
    m = `${m.slice(0, MAX_BODY_LEN)}…（响应过长已截断，原文 ${m.length} 字符）`
  }
  return m
}

/**
 * 瞬时/终态分级：决定 withRetry 是否值得再试一次
 *  - true（值得重试）：无 body 的网络 Error、fetch 失败、超时、HTTP 5xx/429、断流/截断
 *  - false（重试无用）：noUrl（阶梯全无资源）、400/404 等 4xx、文件校验失败
 * NCM 库 reject 的是普通对象 { status, body } 而非 Error：按 status / body.code 判断
 */
function isTransient(err) {
  if (!err) return false
  // 终态：服务端确认该档位无资源，重跑阶梯也一样
  if (err.noUrl === true) return false
  // 终态：用户主动取消任务（AbortError）——重试等于和取消对着干（多烧一次 800ms 退避+请求）。
  // 超时是另一回事（TimeoutError），仍然算瞬时
  if (err.name === 'AbortError') return false
  // 终态：adb 未安装（环境故障，重试装不上）与传输停滞（deviceSuspect：USB 半死/进程挂死）。
  // 断连的恢复逻辑在 service/phone 的 isRetriablePushErr + 宽限重推里，这里重试只会白烧一轮：
  // 立即背靠背重跑同一条 adb 命令，设备还没来得及重新枚举，必然再失败一次
  if (err.noAdb === true || err.deviceSuspect === true) return false

  const msg = typeof err.message === 'string' ? err.message : ''
  const body = err.body
  const text = `${msg} ${safeText(body)}`
  // 终态：文件校验失败（内容错了，重下同一链接大概率还是错，省磁盘）
  if (/文件校验失败|校验失败/.test(text)) return false
  // 终态：参数类错误（未知音质参数/等级）——同一参数重试必然同错
  if (/未知音质参数|未知音质等级/.test(text)) return false
  // 终态：媒体容器结构异常（如 FLAC 块链损坏）——同一文件重下解析还是坏
  if (/结构异常/.test(text)) return false
  // 终态：业务文案已确认无资源（无 noUrl 标记时的兜底）
  if (/无可用链接/.test(text)) return false
  // 终态：内容过大（重下同一链接不会变小；尤其手机目的地 maxBytes 截断路径）
  if (/内容过大/.test(text)) return false

  // HTTP 状态提取：NCM 对象 status 优先，其次常见别名，最后从文案里抠 HTTP xxx
  let status = null
  if (typeof err.status === 'number') status = err.status
  else if (typeof err.statusCode === 'number') status = err.statusCode
  else if (err.response && typeof err.response.status === 'number') status = err.response.status
  else {
    const m = text.match(/HTTP\s*(\d{3})/i) || text.match(/status\s*[:=]\s*(\d{3})/i)
    if (m) status = Number(m[1])
  }
  if (status != null && Number.isFinite(status)) {
    if (status === 429 || status === 408 || (status >= 500 && status <= 599)) return true
    if (status >= 400 && status < 500) return false
    // 2xx/3xx 被 throw 多半是业务错误载体，落到下面的 body.code / 文案判断
  }

  // NCM 业务码：body.code（HTTP 200 包业务错是网易常态）
  let code = null
  if (body && typeof body === 'object' && typeof body.code === 'number') code = body.code
  if (code != null && code !== 200) {
    if (code === 429 || (code >= 500 && code < 600)) return true
    // 3xx（含 301 需登录）/4xx（含 400/404）一律终态；其他负码等未知业务错也不盲重试
    return false
  }

  // 文案直判：超时 / fetch 失败 / 断流截断 → 瞬时
  const lower = text.toLowerCase()
  if (/超时|timeout|timed out|etimeout|econnreset|econnrefused|enotfound|eai_again|econnaborted|socket hang up|network|fetch failed|failed to fetch|fetchfail/i.test(text)) return true
  if (/断流|截断|不完整|incomplete|premature|aborted|abort|大小异常/.test(text)) return true
  if (err.name === 'TimeoutError' || err.name === 'AbortError' || err.code === 'ETIMEDOUT' || err.code === 'ECONNRESET' || err.code === 'ENOTFOUND') return true
  // HTTP 文案兜底（status 字段缺失时）：5xx/429 瞬时，4xx 终态
  const hm = text.match(/HTTP\s*(5\d\d|429)\b/i)
  if (hm) return true
  if (/HTTP\s*4\d\d\b/i.test(text)) return false

  // 默认：无 body 的普通 Error 视为网络抖动，值得重试（保持旧行为全重试）；
  // 带 body 却无可识别码的 NCM 对象同样给一次重试机会
  return true
}

module.exports = { errMsg, isTransient }
