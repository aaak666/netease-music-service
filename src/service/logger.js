/**
 * 轻量运行日志：控制台 + logs/service.log 双写
 * 任务卡片日志是内存态（重启即没，见 HANDOFF 决策 17 的报告动机），设备断连/重连/重试
 * 这类瞬时事件需要一份事后可查的落盘记录——排查"为什么这批只下了一半"全靠它。
 * 占用封顶：超 2MB 轮转为 service.log.old（只留一代，目录最多 ~4MB）；任何落盘失败静默
 * （日志缺了不值得影响业务），绝不向调用方抛错。
 */
const fs = require('fs')
const path = require('path')

const LOG_DIR = path.join(__dirname, '..', '..', 'logs')
const LOG_FILE = path.join(LOG_DIR, 'service.log')
const ROTATE_BYTES = 2 * 1024 * 1024

// 测试注入用：把落盘指向临时文件，避免测试读写/删除真实 logs/service.log（运行时勿动）
let activeLogFile = LOG_FILE
// 落盘状态缓存：目录只建一次（append 抛错时复位，下一行自动重建）；轮转检查用字节计数代替
// 每行 statSync（-1 = 未初始化，首行 statSync 一次拿到现存量，之后纯内存累加）
let dirEnsured = false
let bytesWritten = -1

function _useFile(p) {
  activeLogFile = p || LOG_FILE
  dirEnsured = false
  bytesWritten = -1
}

function ts() {
  const d = new Date()
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

function write(level, tag, msg) {
  // 消息压成单行：多行消息（adb stderr 原文、JSON body）落盘后只有首行有时间戳，
  // 破坏"一行一事件"的可 grep 假设；非字符串 msg 兜底 String，防 "[object Object]"
  const line = `${ts()} [${level}] ${tag} ${String(msg == null ? '' : msg).replace(/\r?\n/g, '；')}`
  try {
    if (level === 'error') console.error(line)
    else console.log(line)
  } catch { /* 控制台句柄损坏（GUI 启动/管道断裂）不能把业务打崩 */ }
  try {
    if (bytesWritten < 0) {
      try { bytesWritten = fs.statSync(activeLogFile).size } catch { bytesWritten = 0 } // 首次尚无文件
    }
    if (!dirEnsured) {
      fs.mkdirSync(path.dirname(activeLogFile), { recursive: true })
      dirEnsured = true
    }
    if (bytesWritten > ROTATE_BYTES) {
      const rotated = `${ts()} [info] logger 日志已轮转（上一份存为 ${path.basename(activeLogFile)}.old）`
      try {
        fs.renameSync(activeLogFile, activeLogFile + '.old')
        bytesWritten = 0
        fs.appendFileSync(activeLogFile, rotated + '\n')
        bytesWritten = Buffer.byteLength(rotated) + 1
      } catch (e) {
        // 轮转失败（.old 被查看器/杀软锁定等）绝不能无痕——封顶保证从此失效，控制台必须能看见原因。
        // 缓存尺寸要复位成"未知"（-1）而不是 0：本进程记的还是"轮转前那个大文件"的大小，
        // 若置 0 则下一行又判定未超限、再攒 2MB 才转，中途被别的进程转走就会失控增长；
        // 置 -1 则下一行重新 statSync 真实大小。
        // 多进程（server 与 stop.js 都写同一个日志文件）下轮转会互相掀掉对方刚写的文件，
        // 表现为 service.log.old 频繁消失、日志历史莫名变短——每次转完重新量尺寸即可避免
        bytesWritten = -1
        console.error(`[logger] 日志轮转失败（${path.basename(activeLogFile)}.old 被占用？），日志将超过 ${ROTATE_BYTES / 1024 / 1024}MB 继续增长: ${e && e.message}`)
      }
    }
    fs.appendFileSync(activeLogFile, line + '\n')
    bytesWritten += Buffer.byteLength(line) + 1
  } catch {
    // 落盘失败静默（日志缺了不值得影响业务），但两个状态都要复位：
    // dirEnsured 让下一行重建目录；bytesWritten 必须一起清零——目录被删/文件被移走时
    // 缓存的字节数是对着"幻影大小"继续累加的，2MB 封顶从此失效（文件可无限增长）
    dirEnsured = false
    bytesWritten = -1
  }
}

module.exports = {
  log: (tag, msg) => write('info', tag, msg),
  error: (tag, msg) => write('error', tag, msg),
  _useFile,
}
