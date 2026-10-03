/**
 * 服务实例管理（service 层）：防双开识别与停旧实例
 * 独立成模块的原因：server.js 是 HTTP 门面，"杀掉旧进程"是进程编排，不该长在路由文件里；
 * stop.js 也直接用这份实现（server.js 再导出仅为兼容旧引用）
 */
const { execSync } = require('child_process')
const logger = require('./logger')

/** 找出正在监听指定端口的进程 PID（Windows netstat；找不到返回 null） */
function findListenerPid(port) {
  try {
    // maxBuffer 必须放大：execSync 默认 1MB，而 netstat -ano 每条 socket 约 60~70 字节，
    // 约 1.5 万条连接就撑爆。溢出抛 ENOBUFS 被下面的 catch 吞掉 → 返回 null →
    // stopOldService 判定"没有旧实例"→ 端口仍被占 → 用户看到"端口被其他程序占用，
    // 请用 netstat 定位"的误导提示（实际就是本服务的旧实例）
    const out = execSync('netstat -ano', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    })
    for (const line of out.split(/\r?\n/)) {
      if (!/LISTENING/i.test(line)) continue
      const cols = line.trim().split(/\s+/)
      if (cols.length >= 5 && cols[1].endsWith(':' + port)) return Number(cols[cols.length - 1])
    }
  } catch { /* netstat 不可用则跳过 */ }
  return null
}

/** 探测端口上跑的是不是本服务（走 /api/ping 专用端点——根路径会被静态首页遮蔽，不能用来识别） */
async function isOurs(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(1500) })
    return r.ok && (await r.text()).includes('netease-music-service')
  } catch { return false }
}

/**
 * 启动前停掉旧实例，防止两个服务并存
 * 只杀"确认是本服务"的进程；端口被别的程序占用时不抢，留给 EADDRINUSE 报错
 */
async function stopOldService(port) {
  if (!(await isOurs(port))) return false
  const pid = findListenerPid(port)
  // 非法 PID/自身进程不杀（自身判断防 stop.js 把自己误杀；<=0/NaN 防 netstat 解析异常殃及无辜）
  if (!pid || !Number.isFinite(pid) || pid <= 0 || pid === process.pid) return false
  // 二次确认仍是本服务：isOurs 与 findPid 之间端口可能易主（旧服务刚退、新应用刚占），
  // 杀前再探一次，防 PID 复用/端口易主后误杀别人的进程
  if (!(await isOurs(port))) return false
  if (findListenerPid(port) !== pid) return false
  try { process.kill(pid) } catch { return false }
  logger.log('instance', `已停止旧服务实例（PID ${pid}，端口 ${port}）`)
  // 轮询等端口真正释放。注意每次 findListenerPid 都要跑一次 netstat（同步 exec），
  // 所以这里的真实预算远大于 30×100ms——正因如此不能"等完就报成功"：
  // 此前无条件 return true，旧进程没退干净时调用方照样打印"已停止"，紧接着 EADDRINUSE
  for (let i = 0; i < 30 && findListenerPid(port); i++) {
    await new Promise((r) => setTimeout(r, 100))
  }
  if (findListenerPid(port)) {
    logger.error('instance', `旧服务实例（PID ${pid}）已收到终止信号但端口 ${port} 仍被占用，可能未退干净`)
    return false
  }
  return true
}

module.exports = { findListenerPid, isOurs, stopOldService }
