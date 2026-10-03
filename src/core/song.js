/**
 * 歌曲核心模块：单曲/批量详情，归一化为统一结构
 * 归一化结构：{ id, name, artist, album, picId, picUrl, duration }
 */
const cookie = require('./cookie')
const { song_detail } = require('NeteaseCloudMusicApi')

function normalize(s) {
  return {
    id: s.id,
    name: s.name,
    artist: (s.ar || s.artists || []).map((a) => a.name).join('/'),
    album: (s.al || s.album || {}).name || '',
    picId: (s.al || s.album || {}).pic_str || (s.al || s.album || {}).pic || String(s.id),
    picUrl: (s.al || s.album || {}).picUrl || '',
    duration: s.dt || s.duration || 0,
  }
}

/** 只保留纯数字 id（网易云歌曲 id 均为数字串）；数字自动转字串，null/空/非数字一律丢弃 */
function cleanIds(ids) {
  const raw = Array.isArray(ids) ? ids : String(ids ?? '').split(',')
  return raw.map((x) => String(x ?? '').trim()).filter((x) => /^\d+$/.test(x))
}

/** 单批详情（≤500 个 id，超出会报错；分块请用 getDetail） */
async function fetchDetail(ids) {
  const clean = cleanIds(ids)
  if (!clean.length) return [] // 空/全脏 id 不发空请求（网易侧 ids='' 会 400）
  const chunk = clean.join(',')
  const { body } = await song_detail({ ids: chunk, cookie: cookie.get() })
  return (body.songs || []).map(normalize)
}

/** 批量详情：id 支持逗号分隔或数组，按网易云单次 500 上限自动分页（分页适配，非业务编排） */
async function getDetail(ids) {
  const list = cleanIds(ids)
  if (!list.length) return [] // 空数组 / 全空字串 / 全脏 id 直接早退，不发请求
  const out = []
  for (let i = 0; i < list.length; i += 500) {
    out.push(...(await fetchDetail(list.slice(i, i + 500))))
  }
  return out
}

/** 单曲，找不到返回 null */
async function getOne(id) {
  const list = await getDetail([id])
  return list[0] || null
}

module.exports = { fetchDetail, getDetail, getOne, normalize }
