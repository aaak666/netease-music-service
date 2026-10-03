/**
 * 停止服务：找到监听指定端口的本服务进程并结束它
 * 只停"确认是本服务"的进程（探测 /api/ping），端口被别的程序占用则不动，防止误杀
 * 用法: node stop.js [port]
 */
const svc = require('./src/service')
const PORT = process.env.PORT || 3000
const { findListenerPid, isOurs, stopOldService } = svc.instance

// 端口参数必须显式校验：原写法 Number(argv[2]) || PORT 会把 "abc"/"0"/空 都悄悄变成缺省 3000，
// 于是"我要停 4000"打成"停 3000"——停错了实例，而用户以为停掉了目标
const raw = process.argv[2]
let port = Number(PORT)
if (raw !== undefined) {
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    console.error(`端口参数非法: ${JSON.stringify(raw)}（应为 1~65535 的整数）`)
    process.exit(2)
  }
  port = n
}

async function main() {
  const pid = findListenerPid(port)
  if (!pid) {
    console.log(`服务未在运行（端口 ${port} 空闲）`)
    return
  }
  // 先分清"不是本服务"与"是本服务但杀不掉"：stopOldService 对三种拒绝原因都返回 false，
  // 无脑报"端口被其他程序占用"会在 kill 失败（如旧实例以管理员身份启动，EPERM）时
  // 把用户引到完全错误的方向——去找那个并不存在的"其他程序"
  const ours = await isOurs(port)
  if (!ours) {
    console.error(`端口 ${port} 被其他程序占用（PID ${pid}），不是本服务，未做任何操作。`)
    process.exitCode = 1
    return
  }
  const stopped = await stopOldService(port)
  if (!stopped) {
    console.error(`已向本服务进程（PID ${pid}）发送终止信号，但端口 ${port} 仍未释放：`)
    console.error('  · 旧实例可能未退干净（稍等几秒重试）')
    console.error('  · 或它以管理员身份运行，当前权限不足——请用管理员身份打开命令行再试')
    process.exitCode = 1
    return
  }
  console.log(`已停止 netease-music-service（端口 ${port}）`)
}

main().catch((e) => { console.error(e.message || e); process.exitCode = 1 })