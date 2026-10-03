/**
 * HTTP 状态映射（service 层共享）：错误对象 → 404/500 的归类口径
 * server 门面与 job 编排（createTask 返回 {code, body}）共用，避免两处映射漂移
 */

// 404/500 映射：NCM 库 reject 的是普通对象 {status, body} 而非 Error，门面此前一律 500，
// "榜单不存在/歌曲不存在"也被报成服务端故障。找不到类（404/找不到/不存在）归 404，其余 500
function isNotFoundErr(err) {
  if (!err) return false
  // 底层显式打的 notFound 旗标优先于一切嗅探（core/playlist.js 按语义打的标记）：
  // 不认它的话将来一改文案就会静默从 404 变 500
  if (err.notFound === true) return true
  const code = err.body && typeof err.body === 'object' ? err.body.code : undefined
  // 明确的"不存在"信号：HTTP 状态或业务码本身就是 404
  if (Number(err.status) === 404 || Number(err.statusCode) === 404 || Number(code) === 404) return true
  // NCM 业务码 301 = 未登录：与"没取到歌"同类（客户端可自愈——重新扫码登录），归 404 而非 500，
  // 与空结果路径（"没有取到歌曲（检查登录状态）"）的口径一致。只认业务码/状态码本身，
  // 文案嗅探仍走下方 definitive 守卫（网络层 502 不会因文案误判）
  if (Number(code) === 301 || Number(err.status) === 301) return true
  // 权威状态码优先于文案嗅探：NCM 的 status 就是 body.code（util/request.js：status = body.code || res.status，
  // 网络层失败固定 502），服务端已给出 3xx~5xx 定性时，body/文案里恰好含"不存在/找不到/404"也不得降级成 404——
  // 否则 500/502 故障会被报成"资源不存在"，客户端当缺资源处理（此前正是这样误判）。
  // 只认 ≥300 的数值状态：0/''/undefined/null 一律视为"没有状态"，继续走文案嗅探
  const definitive = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 300 && n < 600 }
  if (definitive(err.status) || definitive(err.statusCode) || definitive(code)) return false
  // 无状态码可依时（本模块自己抛的普通 Error，如 `找不到榜单: xxx`）才按文案归类
  const text = `${err.message || ''} ${typeof err.body === 'string' ? err.body : err.body ? JSON.stringify(err.body) : ''}`
  return /找不到|不存在|\b404\b/.test(text)
}

function httpStatus(err) {
  return isNotFoundErr(err) ? 404 : 500
}

module.exports = { isNotFoundErr, httpStatus }
