/**
 * 歌单底层原语：单次请求 + 纯映射，不含跨模块组装
 * （歌单详情→曲目详情的组装在 service 层）
 */
const cookie = require('./cookie')
const { playlist_detail } = require('NeteaseCloudMusicApi')

/** 歌单详情原语：返回 { id, name, count, coverUrl, trackIds }；歌单不存在（playlist 为 null）抛错而非返回空壳 */
async function fetchDetail(pid) {
  const { body } = await playlist_detail({ id: pid, cookie: cookie.get() })
  if (!body.playlist) {
    // 静默返回"空歌单"会让上层把"歌单不存在/无权限"当成"0 首歌"照常建任务，用户完全看不出原因
    const e = new Error(`歌单不存在或无权访问 (id=${pid})`)
    e.notFound = true
    throw e
  }
  const pl = body.playlist
  return {
    id: pl.id || Number(pid),
    name: pl.name || '',
    count: (pl.trackIds || []).length,
    coverUrl: pl.coverImgUrl || '',
    trackIds: (pl.trackIds || []).map((t) => t.id),
  }
}

/** 只取歌单元信息，不拉曲目 */
async function getMeta(pid) {
  const { id, name, count, coverUrl } = await fetchDetail(pid)
  return { id, name, count, coverUrl }
}

module.exports = { fetchDetail, getMeta }
