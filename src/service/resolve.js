/**
 * 直链解析服务：带音质降级阶梯的解析（策略层）
 * 底层 core.url.resolve 是单次请求，这里决定"取不到时怎么回退"
 */
const core = require('../core')

/**
 * @param {string|number} id 歌曲ID
 * @param {object} opts
 *   - br / level: 音质参数（同 core）
 *   - autoDowngrade: 目标音质完全取不到时沿阶梯降级（默认 true）
 *
 * 降级只认 core.url 抛出的 noUrl 错误（服务端确认该档位确实无资源）；
 * 网络抖动/接口报错一律原样上抛，交给调用方的重试——否则一次瞬时失败会让
 * "选无损"静默落成 320k（文件不报错、日志显示完成，用户花钱拿到低音质）
 */
async function resolveWithFallback(id, { br, level, autoDowngrade = true } = {}) {
  // level 只认显式 undefined/null 之外的值：显式空串是非法参数，不能被 || 吞成 br
  //（与 core/url.js 同口径）；level 未传时才回退 br
  const target = core.quality.toLevel(level !== undefined && level !== null ? level : br)
  const ladder = autoDowngrade ? core.quality.ladderFrom(target) : [target]
  let lastErr = null
  for (const lv of ladder) {
    try {
      return await core.url.resolve(id, { level: lv })
    } catch (err) {
      if (!err || !err.noUrl) throw err
      lastErr = err
    }
  }
  throw lastErr || new Error(`解析失败 (id=${id})`)
}

module.exports = { resolveWithFallback }
