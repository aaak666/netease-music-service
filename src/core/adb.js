/**
 * ADB 底层原语：定位 adb、设备状态、设备端文件操作
 * 只含原子能力（单次外部交互）：策略（状态判定、可写探测、目的地配置）在 src/service
 *
 * 关键实现约束（实测结论，勿改）：
 *  - 写文件走 base64 管道（adb shell "base64 -d > path"）：Windows adb.exe 以文本模式处理 stdin，
 *    二进制直灌会被插 CR 污染；base64 全为可打印字符，文本转换对其无效，字节级无损
 *  - 列目录用 find 而非 ls：exec-out 无 PTY 时 toybox ls 会把空格转义成 "\ "，文件名对不上
 *  - 输出一律经 exec-out（无 PTY、无 \r），行尾仍统一 strip \r 兜底
 */
const { execFileSync, spawnSync } = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')

const PUSH_TIMEOUT = 10 * 60 * 1000 // 单文件写入上限，与音乐本体下载超时同量级
const CMD_TIMEOUT = 20 * 1000       // 普通 shell 命令（find/mv 等）的等待上限
const MD5_TIMEOUT = 60 * 1000       // md5sum 单独放大：几十 MB 音频在慢 USB 上 20s 可能算不完，
                                    // 文件其实已完整落盘却被误判失败（20s 是秒级命令的口径，不适用全文件哈希）

/** adb 可执行文件定位：环境变量 ADB → %USERPROFILE%\Tools\platform-tools → PATH（'adb'） */
function adbPath() {
  if (process.env.ADB && fs.existsSync(process.env.ADB) && fs.statSync(process.env.ADB).isFile()) {
    return process.env.ADB
  }
  const bundled = path.join(os.homedir(), 'Tools', 'platform-tools', 'adb.exe')
  if (fs.existsSync(bundled)) return bundled
  return 'adb' // 交给 PATH 解析；不存在时 spawn 报 ENOENT，由调用方归为"未安装"
}

function run(args, { timeoutMs = CMD_TIMEOUT, input } = {}) {
  // spawnSync 而非 execFileSync：input 经 stdin 管道直灌（execFileSync 也支持，但 spawnSync
  // 对大 input 的行为与 phone-fill 实测一致，不再换实现引入变量）
  const r = spawnSync(adbPath(), args, { input, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 })
  if (r.error && r.error.code === 'ENOENT') throw tagNoAdb()
  if (r.error) {
    // spawnSync 层失败（ETIMEDOUT/EPIPE 等）：USB 半死时 adb 挂到超时才被收割，这类"传输停滞"
    // 是断连的常见形态——打 deviceSuspect 标记，由上层容错（service/phone）决定走恢复宽限重推。
    // pushBuffer 的 md5sum 校验（execOut）也走这里：md5 停滞到超时不打标记的话会绕过断连容错。
    // 例外 ENOBUFS：那是"输出超过 maxBuffer"（find 列了太多条目），不是传输停滞——打上标记会
    // 让上层白等两轮宽限、最后报"手机已断开连接"，与真实病因完全无关，还杀掉一个健康的批次
    if (r.error.code !== 'ENOBUFS') r.error.deviceSuspect = true
    throw r.error
  }
  if (r.status !== 0) {
    const errText = ((r.stderr && r.stderr.toString()) || (r.stdout && r.stdout.toString()) || '').trim()
    // stderr/stdout 全空 = adb 进程异常死亡（传输中断的另一种常见形态），同样疑似断连；
    // 有输出的（如设备端明确报错）保持普通错误终态
    if (!errText) {
      const e = new Error(`adb 异常退出（exit ${r.status}，无任何输出）——疑似传输停滞/断连`)
      e.deviceSuspect = true
      throw e
    }
    throw new Error(errText)
  }
  return r.stdout
}

/** 设备端 shell（转义由调用方负责——用 shq 包路径） */
function shell(cmd, opts = {}) {
  return run(['shell', cmd], opts)
}

/** 无 PTY 的设备端输出（机器可读：find 清单 / cat / md5sum） */
function execOut(cmd, opts = {}) {
  return run(['exec-out', cmd], opts)
}

/** 设备端 sh 双引号转义（含 $ ` " \ 即可，! 在非交互 shell 无历史展开） */
function shq(p) {
  return `"${String(p).replace(/([\\"$`])/g, '\\$1')}"`
}

/**
 * 已连接设备列表：[{ serial, state, model }]
 * state 直接用 adb 原语：device（已授权可用）/ unauthorized / offline / no permissions 等
 */
function devices() {
  const out = run(['devices', '-l']).toString('utf8')
  const list = []
  for (const line of out.split(/\r?\n/)) {
    if (!line || /^(List of devices|\*|\s*$)/.test(line)) continue
    const cols = line.trim().split(/\s+/)
    if (cols.length < 2) continue
    const model = (line.match(/model:([^\s]+)/) || [])[1] || ''
    list.push({ serial: cols[0], state: cols[1], model })
  }
  return list
}

/** 设备目录下的文件名清单（不含子目录、不含路径前缀；目录不存在抛错） */
function listFiles(dir) {
  const out = execOut(`find ${shq(dir)} -maxdepth 1 -type f`).toString('utf8')
  const prefix = dir.replace(/\/+$/, '') + '/'
  return out.split('\n')
    .map((s) => s.replace(/\r$/, ''))
    .filter(Boolean)
    .map((line) => (line.startsWith(prefix) ? line.slice(prefix.length) : line))
}

/** 设备目录下的子目录名清单（不含父目录本身；目录不存在抛错） */
function listDirs(dir) {
  const out = execOut(`find ${shq(dir)} -maxdepth 1 -type d`).toString('utf8')
  const prefix = dir.replace(/\/+$/, '') + '/'
  return out.split('\n')
    .map((s) => s.replace(/\r$/, ''))
    .filter(Boolean)
    .map((line) => (line.startsWith(prefix) ? line.slice(prefix.length) : line))
    .filter((name) => name)
}

function dirExists(dir) {
  // test -d 的退出码即结论；目录不存在时 test 静默失败（无 stderr 噪音）
  try { run(['shell', `test -d ${shq(dir)}`]); return true } catch (e) {
    // adb 缺失是环境故障，不能伪装成"目录不存在"（调用方会据此静默跳过索引回填）
    if (e && e.noAdb) throw e
    return false
  }
}

function mkdirP(dir) {
  shell(`mkdir -p ${shq(dir)}`)
}

function rm(remotePath) {
  shell(`rm -f ${shq(remotePath)}`)
}

/** 读远端文本文件（UTF-8）；不存在抛错（调用方按需 catch 视为"无文件"） */
function readText(remotePath, opts = {}) {
  return execOut(`cat ${shq(remotePath)}`, opts).toString('utf8')
}

/**
 * 内存 buffer 直写设备文件（字节级无损）：base64 过管道 → 设备端解码落盘 → 远端 md5 比对
 * 校验不符删除半成品后抛错——手机目的地没有任何本地临时文件，可靠性全押在这道校验上
 */
function pushBuffer(buf, remotePath, { timeoutMs = PUSH_TIMEOUT } = {}) {
  const r = spawnSync(adbPath(), ['shell', `base64 -d > ${shq(remotePath)}`], {
    // Buffer 已是 Buffer 时不复制：64MB 音频在 原buf+拷贝+base64串 三份并存时峰值 ~200MB，
    // 白白多一份等生命周期的拷贝
    input: (Buffer.isBuffer(buf) ? buf : Buffer.from(buf)).toString('base64'),
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
  })
  // base64 -d 是直接重定向到最终路径：超时/写失败时设备端已留下截断半成品，
  // 而它会被下次 scanDir 当完整歌曲认领并永久跳过（增量口径按文件名存在判"已有"）——
  // 所以任何一条失败路径都必须先删半成品再抛错，与 md5 不符的分支同一待遇
  const fail = (e) => {
    try { rm(remotePath) } catch { /* 半成品清不掉就留着，用户可手动删 */ }
    throw e
  }
  if (r.error && r.error.code === 'ENOENT') {
    fail(tagNoAdb())
  }
  if (r.error) {
    // spawnSync 层失败（ETIMEDOUT/EPIPE 等）：USB 半死时 adb 进程挂到超时才被收割，
    // 这类"传输停滞"是断连的常见形态——打 deviceSuspect 标记，由上层容错（service/phone）
    // 决定走恢复宽限重推；core 层不做策略。ENOBUFS（输出超 maxBuffer）不是传输问题，不打标记
    if (r.error.code !== 'ENOBUFS') r.error.deviceSuspect = true
    fail(r.error)
  }
  if (r.status !== 0) {
    const errText = ((r.stderr && r.stderr.toString()) || (r.stdout && r.stdout.toString()) || '').trim()
    const e = new Error(`设备端写入失败: ${errText || `exit ${r.status}`}`)
    // stderr/stdout 全空 = adb 进程异常死亡（传输中断的另一种常见形态），同样疑似断连；
    // 有 stderr 的（如设备端"磁盘已满"）是明确业务报错，保持终态不重试
    if (!errText) e.deviceSuspect = true
    fail(e)
  }
  // md5sum 阶段失败（含 spawnSync 层超时）同样先删半成品再抛错：USB 在写入尾部断开时设备端
  // base64 -d 收到 EOF 提前退出，留下的截断文件会被下次 scanDir 按文件名认领成"完整歌曲"永久跳过。
  // 执行失败（非校验不符）也删是刻意的：文件完整性未知时留下它，下次增量会按名字认领一个
  // 可能残缺的文件当完整歌（永久坏档）；删掉重下只是浪费一次带宽。设备停滞型失败已带
  // deviceSuspect 标记，上层走宽限重推（从内存 buffer 重推，不重新下载），这里删不删都无碍
  let out
  try {
    out = execOut(`md5sum ${shq(remotePath)}`, { timeoutMs: MD5_TIMEOUT }).toString().trim().split(/\s+/)[0]
  } catch (e) {
    fail(e)
  }
  if (out !== crypto.createHash('md5').update(buf).digest('hex')) {
    fail(new Error('远端 md5 校验不符（传输损坏），半成品已删除'))
  }
  return remotePath
}

function tagNoAdb() {
  const e = new Error('未找到 adb 可执行文件')
  e.noAdb = true
  return e
}

module.exports = { adbPath, run, shell, execOut, shq, devices, listFiles, listDirs, dirExists, mkdirP, rm, readText, pushBuffer }
