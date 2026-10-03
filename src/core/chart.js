/**
 * 榜单底层原语：单次 toplist 请求 + 纯映射
 * 缓存/中文名匹配/组合取曲在 service 层
 */
const cookie = require('./cookie')
const { toplist } = require('NeteaseCloudMusicApi')

/** 全部官方榜单：[{ id, name, updateTime, cover, description }] */
async function fetchToplist() {
  const { body } = await toplist({ cookie: cookie.get() })
  return (body.list || []).map((l) => ({
    id: l.id,
    name: l.name,
    updateTime: l.updateFrequency || '',
    cover: l.coverImgUrl || '',
    description: l.description || '',
  }))
}

module.exports = { fetchToplist }
