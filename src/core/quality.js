/**
 * 音质核心模块：br 值 ↔ 网易云原生 level 映射与降级阶梯
 *
 * 产品只开放两档（其余档位不接受）：
 *   exhigh(320k MP3) → lossless(FLAC)
 * 网易原生还有 standard/higher/hires/jyeffect/sky/jymaster，
 * 但对外一律拒绝，仅 extOf 保留对响应档位的扩展名映射（服务端可能回吐降级/升级档位）。
 */
const ORDER = ['exhigh', 'lossless']

const BR_TO_LEVEL = Object.assign(Object.create(null), {
  320: 'exhigh',
  2000: 'lossless',
})

/** 兼容 Meting 习惯的 br 参数与原生 level，缺省 exhigh(320k)；显式空串视为非法（防 ?br= 被静默吞掉） */
function toLevel(brOrLevel) {
  if (brOrLevel == null) return 'exhigh'
  const key = String(brOrLevel).toLowerCase().trim()
  if (!key) throw new Error(`未知音质参数: ${brOrLevel}，可用: ${[...ORDER].join('/')} 或 br 值 320/2000`)
  if (ORDER.includes(key)) return key
  // BR_TO_LEVEL 以 null 原型创建：普通对象会沿原型链查到 'constructor'/'toString' 等
  // 继承属性（truthy 的函数对象），垃圾参数会被当合法 level 透传给网易接口
  if (BR_TO_LEVEL[key]) return BR_TO_LEVEL[key]
  if (BR_TO_LEVEL[Number(key)]) return BR_TO_LEVEL[Number(key)]
  throw new Error(`未知音质参数: ${brOrLevel}，可用: ${[...ORDER].join('/')} 或 br 值 320/2000`)
}

/** 降级阶梯：从目标等级开始往下（含目标本身），用于请求失败时回退 */
function ladderFrom(level) {
  const idx = ORDER.indexOf(level)
  if (idx < 0) throw new Error(`未知音质等级: ${level}`)
  return ORDER.slice(0, idx + 1).reverse()
}

/** level → 常见文件扩展名（encodeType 只认 mp3/flac 白名单：异常值会产出 scanDir 不认领的
 *  扩展名 → 增量对账每次当缺失重下、永不收敛；异常回退按档位判断） */
function extOf(level, encodeType) {
  if (encodeType) {
    const t = String(encodeType).toLowerCase().trim()
    if (t === 'mp3' || t === 'flac') return t
  }
  return ['lossless', 'hires', 'jyeffect', 'sky', 'jymaster'].includes(level) ? 'flac' : 'mp3'
}

module.exports = { ORDER, BR_TO_LEVEL, toLevel, ladderFrom, extOf }
