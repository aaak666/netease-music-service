/**
 * 榜单服务：清单缓存(TTL)、中文名匹配、榜单→曲目组合
 */
const core = require('../core')

const CACHE_TTL = 10 * 60 * 1000 // 榜单清单 10 分钟缓存
let cache = null

async function charts(refresh = false) {
  if (cache && !refresh && Date.now() - cache.at < CACHE_TTL) return cache.list
  const list = await core.chart.fetchToplist()
  cache = { at: Date.now(), list }
  return list
}

// 测试钩子：清单缓存是模块级 10 分钟 TTL，单测里塞的假榜单会漏给后面所有用例，
// 让"取不到真榜单"这类断言变成假绿。清空只需把缓存置空，不必等 TTL
function _resetCache() { cache = null }

/** 按中文名精确匹配榜单，找不到返回 null */
async function findByName(name) {
  const list = await charts()
  return list.find((l) => l.name === name) || null
}

/**
 * 榜单曲目（支持 ID 或中文名）
 * limit 直接透传给 playlist.get：拿到 trackIds 就先截断再取详情（与歌单下载同口径）——
 * 大榜上万首时"先全量取详情再 slice"会白拉几十个批量详情请求、慢网下直接撞路由预算
 * @returns { id, name, updateTime, count, songs[] }（count 恒为榜单总曲数，不受 limit 影响）
 */
async function get(idOrName, { limit } = {}) {
  let chart
  if (typeof idOrName === 'string' && !/^\d+$/.test(idOrName)) {
    chart = await findByName(idOrName)
    if (!chart) throw new Error(`找不到榜单: ${idOrName}（可用 charts() 查看全部榜单名）`)
  } else {
    const all = await charts()
    // 榜单清单里没有该 id 时回退为直取歌单：name 留空，让下行的 `chart.name || pl.name`
    // 透出歌单真名（此前填 id 字串恒为真值，会把真名 shadow 掉，返回名变成一串数字）
    chart = all.find((l) => l.id === Number(idOrName)) || { id: Number(idOrName), name: '', updateTime: '' }
  }
  const pl = await require('./playlist').get(chart.id, limit ? { limit } : {})
  return {
    id: chart.id,
    name: chart.name || pl.name,
    updateTime: chart.updateTime || '',
    count: pl.count,
    songs: pl.songs,
  }
}

module.exports = { charts, findByName, get, _resetCache }
