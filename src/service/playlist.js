/**
 * 歌单服务：歌单详情 → 曲目详情 的组合
 */
const core = require('../core')

/**
 * 返回 { id, name, count, songs[] }
 * @param limit 只取前 limit 首的详情（>=1 的整数才生效，0/未传/非法 = 全部）——
 *   拿到 trackIds 就先截断再取详情：想下 20 首不必先把几千首的详情全拉回来，
 *   批量详情的请求批次数由截断后的数量决定（core.song.getDetail 每 500 首一批的分页逻辑不变）
 */
async function get(pid, { limit } = {}) {
  const detail = await core.playlist.fetchDetail(pid)
  const ids = Number.isInteger(limit) && limit >= 1 ? detail.trackIds.slice(0, limit) : detail.trackIds
  const songs = await core.song.getDetail(ids)
  return { id: detail.id, name: detail.name, count: detail.count, songs }
}

module.exports = { get }
