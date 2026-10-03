/**
 * 扫码登录 CLI（核心逻辑在 src/service/login.js，可编程调用）
 * 打开看图器等桌面交互属 CLI 关切：service 层不起外部进程
 */
const { execFile } = require('child_process')
const path = require('path')
const { login } = require('./src/service')
const { errMsg } = require('./src/core/error')

login.qrLogin({
  qrPath: path.join(__dirname, 'qr.png'),
  open: process.platform === 'win32',
  // execFile + 参数数组，不用 exec：exec 会把命令交给 cmd.exe 再解析一遍，
  // 项目路径里出现 " & ^ %VAR% 就会破掉命令甚至被当成注入点（qrPath 虽是常量拼接，
  // 但整条命令经过 shell 这一层本身就是不必要的风险）
  onOpen: (qrPath) => execFile('cmd', ['/c', 'start', '', qrPath], (e) => {
    if (e) console.error('打开二维码图片失败: ' + errMsg(e))
  }),
  onStatus: (s) => {
    if (s === 'waiting') console.log('等待扫码...（用手机网易云音乐 App 扫描弹出的二维码）')
    if (s === 'scanned') console.log('已扫码，请在手机上确认登录...')
    if (s === 'ok') console.log('登录成功！cookie 已保存到 cookie.txt')
  },
}).then(() => process.exit(0)).catch((e) => {
  // NCM 库失败时 reject 的是普通对象而非 Error，直接取 e.message 会打印 undefined
  console.error(errMsg(e))
  process.exit(1)
})
