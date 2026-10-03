/**
 * 推荐底层原语：每类推荐只取"单次请求"，无循环累计
 * （无限流电台的循环拉批/去重在 service 层）
 */
const cookie = require('./cookie')
const song = require('./song')
const {
  recommend_songs,
  personal_fm,
  personal_fm_mode,
  playmode_intelligence_list,
  simi_song,
} = require('NeteaseCloudMusicApi')

/** 心动模式接口返回的嵌套结构归一化（纯映射）；未登录/风控时 data 常是非数组对象（如 {code:301}），当空处理 */
function unwrap(list) {
  return (Array.isArray(list) ? list : [])
    .map((x) => x.songInfo || x)
    .filter(Boolean)
    .map(song.normalize)
    .filter((s) => s.id)
}

/** 每日推荐：单次请求（约30首，每天 0 点更新） */
async function fetchDaily() {
  const { body } = await recommend_songs({ cookie: cookie.get() })
  const daily = body.data && body.data.dailySongs
  return (Array.isArray(daily) ? daily : []).map(song.normalize)
}

/** 电台单页：私人FM(FAMILIAR 雷达 / EXPLORE 漫游)，实测单批仅 2~3 首 */
async function fetchFmPage({ mode, submode } = {}) {
  if (mode) {
    const { body } = await personal_fm_mode({ mode, submode, limit: 30, cookie: cookie.get() })
    return unwrap(body.data)
  }
  const { body } = await personal_fm({ cookie: cookie.get() })
  return unwrap(body.data)
}

/** 心动模式：基于某歌单里的某首歌，单次大批量（实测可取 150 首） */
async function fetchHeartMode(pid, id, { count = 100 } = {}) {
  const { body } = await playmode_intelligence_list({ pid, id, count, cookie: cookie.get() })
  return unwrap(body.data)
}

/** 相似歌曲单页：实测单批仅 5 首 */
async function fetchSimiPage(id) {
  const { body } = await simi_song({ id, cookie: cookie.get() })
  return (Array.isArray(body.songs) ? body.songs : []).map(song.normalize)
}

module.exports = { unwrap, fetchDaily, fetchFmPage, fetchHeartMode, fetchSimiPage }
