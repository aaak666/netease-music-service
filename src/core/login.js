/**
 * 登录底层原语：二维码登录拆成三个单步操作，无循环、无副作用弹窗
 * 轮询策略与"自动打开图片"的交互在 service 层 / CLI
 */
const fs = require('fs')
const { login_qr_key, login_qr_create, login_qr_check } = require('NeteaseCloudMusicApi')

/** 生成登录 key（unikey）；库返回缺 data 时给可读报错而非 TypeError */
async function createQrKey() {
  const r = await login_qr_key({})
  if (!(r.body && r.body.data && r.body.data.unikey)) throw new Error('获取登录 key 失败（接口返回异常）')
  return r.body.data.unikey
}

/** 用 key 生成二维码图片文件，返回文件路径 */
async function createQrImage(key, qrPath) {
  const r = await login_qr_create({ key, qrimg: true })
  const qrimg = r.body && r.body.data && r.body.data.qrimg
  // data URI 形如 data:image/png;base64,xxx：没有逗号说明库返回形态变了，盲 split 会拿到 undefined
  if (typeof qrimg !== 'string' || !qrimg.includes(',')) throw new Error('二维码图片生成失败（接口返回异常）')
  fs.mkdirSync(require('path').dirname(qrPath), { recursive: true })
  fs.writeFileSync(qrPath, Buffer.from(qrimg.split(',')[1], 'base64'))
  return qrPath
}

/** 单次检查扫码状态：800 过期 / 801 等待 / 802 已扫 / 803 成功（带 cookie） */
async function checkQr(key) {
  const r = await login_qr_check({ key })
  const code = r.body.code
  return { code, cookie: code === 803 ? r.body.cookie : null }
}

module.exports = { createQrKey, createQrImage, checkQr }
