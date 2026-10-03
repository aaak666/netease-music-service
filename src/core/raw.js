/**
 * 通用透传原语：按模块名调用任意 NeteaseCloudMusicApi 接口，自动注入 cookie
 * 上层想用未封装的接口（如 album、top_artist）时无需再改 core
 *
 *   await raw('album', { id: 123 })        // 返回完整结果 { status, body, ... }
 *   await raw('song_url_v1', { id, level: 'lossless' })
 */
const cookie = require('./cookie')
const NCM = require('NeteaseCloudMusicApi')

async function raw(moduleName, params = {}) {
  const fn = NCM[moduleName]
  if (typeof fn !== 'function') {
    throw new Error(`未知接口模块: ${moduleName}，可选: ${Object.keys(NCM).filter((k) => /[a-z]/.test(k[0])).slice(0, 20).join(', ')}...`)
  }
  return fn({ ...params, cookie: params.cookie || cookie.get() })
}

// 直接导出函数本体（调用形态 core.raw('album', {...})），与其他模块的命名空间导出不同——
// 在 core/index.js 登记处已注明该差异；本模块没有第二个导出，包一层命名空间是空转
module.exports = raw
