/**
 * 入口参数口径（service 层，server 与 job 共用一份，避免两处判定漂移）
 * 纯函数：只做"传了就必须合法"的判型，不含 IO 与 HTTP 语义
 */
const core = require('../core')

// br 参数缺省值（显式判断，避免 br=0/空串被静默吞掉）；JSON body 里的显式 null 同样视为
// "没传"——同一语义必须同一结果（旧写法 br:null 走左支静默变成 320k，与缺省无损不一致）
function brOf(params) {
  return ('br' in params && params.br !== null && params.br !== undefined) ? params.br : 2000
}

// 入口音质校验：非法档位（如旧客户端传 128）直接拒绝，避免建任务后逐首失败
function brError(params) {
  try {
    core.quality.toLevel(brOf(params))
    return null
  } catch (e) {
    return e.message
  }
}

// "缺省关"开关解析：只有显式 true/1（含 JSON 布尔 true）才开，其余一律关——
// 未传 / 空串 / 'false' / '0' / 任意其他值都算关，与 README、HANDOFF 的"缺省关"文案一致。
//（旧写法 /^(false|0)$/ 取反是"缺省开"：空串走 !false = true，注释与代码口径相反）
function flagOn(v) {
  return /^(true|1)$/i.test(String(v == null ? '' : v))
}

// id 缺口统一判空：query/body 传来的 id 可能是 undefined/空串/全空格，String 化后 trim 再判
function missingId(v) {
  return v == null || String(v).trim() === ''
}

// recommend/download 的数量参数校验：显式传了就必须是 >0 的有限数（"0"/空/负/NaN/abc 一律非法，
// 不静默回退成 30/100 让用户误以为生效）；没传则由各路由的缺省值接管
function badCount(v) {
  if (v == null || v === '') return false // 没传：不算错
  const n = Number(v)
  return !Number.isFinite(n) || n <= 0
}

module.exports = { brOf, brError, flagOn, missingId, badCount }
