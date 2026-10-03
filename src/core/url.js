/**
 * 播放链接底层原语：单次按 level 请求直链
 * 无重试、无降级循环——取不到就 throw，降级策略由 service 层实现
 * （注意：网易云服务端本身可能返回与请求不同的档位——这是接口行为，
 *   返回值里的 level/ext 一律按实际命中的档位算，不按请求值算）
 */
const cookie = require('./cookie')
const quality = require('./quality')
const { song_url_v1 } = require('NeteaseCloudMusicApi')

/** @returns { id, url, br, size, level, type, ext, md5 } */
async function resolve(id, { br, level } = {}) {
  // level !== undefined 而非 truthy：显式空串 level 是"非法参数"（toLevel 会报可用值），
  // 不能被 || 吞成 br/缺省静默通过——非法参数要在第一站现形
  const lv = quality.toLevel(level !== undefined && level !== null ? level : br)
  const { body } = await song_url_v1({ id, level: lv, cookie: cookie.get() })
  const data = body.data && body.data[0]
  if (!data || !data.url) {
    // noUrl 标记"服务端确认该档位没有资源"（非 VIP 曲目/灰性歌曲等）——这是唯一允许降级阶梯
    // 继续的失败形态；网络层错误是普通 Error/NCM 对象，不带此标记，service 层不得据此降音质
    const err = new Error(`无可用链接 (id=${id}, level=${lv})`)
    err.noUrl = true
    throw err
  }
  return {
    id: Number(id),
    url: data.url,
    br: data.br,
    size: data.size,
    level: data.level,
    type: data.type,
    ext: quality.extOf(data.level, data.type),
    md5: data.md5 || '',
  }
}

module.exports = { resolve }
