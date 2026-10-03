/**
 * 单测公共基座：进程级前置桩（memfs 内存文件系统 / execFile·spawnSync 桩 / 下载根重定向）
 * 与用例收集器。用例本体在同目录 unit.*.js，执行顺序由 test/unit.test.js 入口的数组决定。
 */
/**
 * 底层纯函数单测（无网络，毫秒级）：node test/unit.test.js
 * 默认文件系统=内存（memfs）：全程零真实磁盘写入（高频迭代不磨损 SSD）；
 * 需要验证真实文件系统行为时跑 node test/unit.test.js --io（写真实临时目录，退出即清）。
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

// 临时目录唯一出处：每个用例自建自清（用例末尾 rmSync），互不串目录。
// 全部登记进 TMP_DIRS，进程退出时兜底再清一遍——用例半途失败、手动中断、Windows 下
// 杀软/遗留句柄让单次 rmSync 抛 EBUSY/EPERM（历史残留 148MB 的教训），都不许留垃圾：
// 测试对磁盘的占用收敛为"运行期间存在、退出即归零"
const TMP_DIRS = []
const tmpDir = (prefix) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  TMP_DIRS.push(d)
  return d
}
function rmRf(p) {
  for (let i = 0; i < 3; i++) {
    try { fs.rmSync(p, { recursive: true, force: true }); return } catch { /* 占用重试 */ }
  }
}
process.on('exit', () => { for (const d of TMP_DIRS) rmRf(d) })

// ==== 进程级前置：必须发生在首次 require('../server') 之前 ====
// 1) 下载根目录指向 os.tmpdir：server.js 在模块加载时把 DOWNLOAD_DIR 读成模块常量，
//    晚了就改不动——此后建批次目录 / /api/open-folder / /api/status 回执全部落在临时目录，
//    用例绝不碰真实 downloads\（本文件所有 rm 也只作用于该临时树）
process.env.DOWNLOAD_DIR = tmpDir('ncm-test-dl-')
const TEST_DOWNLOAD_DIR = process.env.DOWNLOAD_DIR
// 2) 拦截 execFile：server.js 加载时解构 child_process.execFile（/api/open-folder 用它弹资源管理器），
//    必须在其加载前替换为记录桩——即使节流逻辑失灵也绝不会真的弹出 explorer 窗口
const childProcess = require('child_process')
const execFileOriginal = childProcess.execFile
function execFileStub(...args) { execFileStub.calls.push(args) }
execFileStub.calls = []
childProcess.execFile = execFileStub

// 2b) adb 保险丝：core/adb.js 在加载时解构 spawnSync，任何"漏打桩"的 adb 原语都会真的去调
//     真实 adb.exe。决策 61 记录过这个事故真实发生过一次（先 require 后打桩，用例静默跑了真 adb
//     并往真实手机写了测试文件）。这里在加载 core 之前把 spawnSync 换成"遇到 adb 就抛"的桩：
//     漏桩的用例会立刻报出清晰的"adb 原语未打桩"，而不是悄悄操作用户真机。
//     非 adb 的 spawnSync 调用不受影响（dialog 走 execFile，本来就不经过这里）
const spawnSyncOriginal = childProcess.spawnSync
function spawnSyncGuard(cmd, args, opts) {
  const s = String(cmd || '')
  if (/adb(\.exe)?$/i.test(s)) {
    const e = new Error(`测试中禁止调用真实 adb（${s} ${(args || []).join(' ')}）——请在用例内给 core.adb 的对应原语打桩`)
    e.noAdb = true
    throw e
  }
  return spawnSyncOriginal(cmd, args, opts)
}
childProcess.spawnSync = spawnSyncGuard

// 2c) 内存文件系统：默认把整个 fs 派发到 memfs——写入全部进内存，读内存里没有的文件
//     自动回退真实磁盘（unionfs 串联，memfs 优先）。这样 161 条用例与断言原样不动，
//     变化的只是它们脚下这层"盘"：日常高频测试零真实磁盘写入，不磨损 SSD。
//     patchFs 原地替换核心 fs 模块对象，必须发生在任何 src 模块加载之前（与 execFile
//     桩同理——模块加载时捕获的 fs 引用也要拿到补丁后的对象）。
//     加 --io 参数跳过本补丁：真实落盘全流程验证（结束照样清场）。
if (!process.argv.includes('--io')) {
  const { vol } = require('memfs')
  const { ufs } = require('unionfs')
  const { patchFs } = require('fs-monkey')
  patchFs(fs, ufs.use(vol).use(fs))
}

const core = require('../src/core')
const svc = require('../src/service')
// 3) 下载位置配置指向临时目录：本机若存在真实 destinations.json 且激活了自定义/手机目的地，
//    建任务用例会被带进 phone/local 分支（真实 adb / 真实磁盘）——进程级隔离，守住"纯本地桩"
svc.dest._useFile(path.join(TEST_DOWNLOAD_DIR, 'destinations.json'))
// 4) 运行日志同样指向临时文件：测试触发的 adb 状态翻转/建任务失败等日志不得混进生产 logs/service.log
//    （此前只有 logger 自身的用例临时改指，其余用例全程写真实文件，测试残留混在排查记录里）
svc.logger._useFile(path.join(TEST_DOWNLOAD_DIR, 'service.log'))

const results = []
const failures = []
let currentTest = '(未开始)'
async function t(name, fn) {
  currentTest = name
  try {
    await fn()
    results.push(true)
    console.log(`  [PASS] ${name}`)
  } catch (e) {
    results.push(false)
    // 失败详情同时落盘：控制台经过 PowerShell/管道时中文与符号会被编码破坏，
    // 只留一行 message 时 100+ 个平铺用例里定位不到是哪一个、也不知道断在哪一行
    const detail = {
      name,
      message: (e && e.message) || String(e),
      stack: (e && e.stack) ? String(e.stack).split('\n').slice(0, 6).join('\n') : '',
      actual: e && typeof e.actual !== 'undefined' ? String(e.actual) : undefined,
      expected: e && typeof e.expected !== 'undefined' ? String(e.expected) : undefined,
    }
    failures.push(detail)
    try {
      fs.appendFileSync(path.join(TEST_DOWNLOAD_DIR, 'failures.json'), JSON.stringify(detail) + '\n', 'utf8')
    } catch { /* 诊断落盘失败不影响测试判定 */ }
    console.error(`  [FAIL] ${name}: ${detail.message}`)
  }
  currentTest = '(已完成)'
}

// 兜底：任何逃出 t() 的迟到 Promise 拒绝（stub 恢复后才冒泡的异步尾巴）原来会让整个进程
// 带裸栈崩掉、无归因、无汇总。归因到当前用例名并记账，套件继续跑完
process.on('unhandledRejection', (r) => {
  const msg = (r && r.message) || String(r)
  failures.push({ name: currentTest, message: '未处理的 Promise 拒绝: ' + msg, stack: (r && r.stack) || '' })
  console.error(`  [FAIL] ${currentTest}: 未处理的 Promise 拒绝: ${msg}`)
})

/**
 * 一次性桩掉手机管线的全部 adb IO 原语（除了调用方自己指定的 pushBuffer）。
 * phone.downloadMany 每首都要 readText（设备端索引）、listFiles/execOut（目录现状），
 * 少桩一个就会撞上 adb 保险丝（真 adb 被换成了"遇 adb 即抛"的桩），
 * 症状是断言看到的是保险丝错误而不是被测逻辑的真实结果——很难排查。
 */
function stubPhoneIo(overrides) {
  const names = ['readText', 'listFiles', 'listDirs', 'execOut', 'shell', 'mkdirP', 'rm', 'dirExists', 'pushBuffer']
  const orig = {}
  for (const n of names) orig[n] = core.adb[n]
  const defaults = { readText: () => '', listFiles: () => [], listDirs: () => [], execOut: () => '', shell: () => {}, mkdirP: () => {}, rm: () => {}, dirExists: () => false, pushBuffer: () => {} }
  const applied = { ...defaults, ...(overrides || {}) }
  for (const n of names) if (applied[n] !== undefined) core.adb[n] = applied[n]
  return {
    applied,
    restore() { for (const n of names) core.adb[n] = orig[n] },
  }
}

/** 造一个假的音频 fetch 响应（两条管线的取流最终都落到全局 fetch / core.download） */
function fakeAudioFetch(bytes) {
  const buf = bytes || Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x00' + 'x'.repeat(64))
  return async () => ({
    ok: true,
    status: 200,
    headers: { get: (h) => (h === 'content-length' ? String(buf.length) : null) },
    body: {
      getReader: () => {
        let sent = false
        return {
          read: async () => (sent ? { done: true } : (sent = true, { done: false, value: buf })),
          cancel: async () => {},
        }
      },
    },
  })
}

/**
 * 把手机管线彻底隔离：桩 resolveWithFallback + 全部 adb IO + 标签函数，然后重载 phone.js。
 * 两个必须重载的陷阱（决策 61 的同类）：
 *  - phone.js 在 require 时就解构了 resolveWithFallback，事后改 exports 对它无效
 *  - adb 保险丝换过 child_process.spawnSync 之后，新旧 core/adb 可能是不同对象，
 *    桩必须打在**重载后实际拿到的那个**上
 * 少桩一个 adb 原语就会撞保险丝（症状是断言看到保险丝错误而非被测逻辑的真实结果，极难排查）。
 */
function withStubbedPhone(spec) {
  const rkey = require.resolve('../src/service/resolve')
  const pkey = require.resolve('../src/service/phone')
  const origResolve = require(rkey)
  const savedAdb = {}
  const savedTag = {}
  const origStatus = svc.adb.status
  const adbNames = ['readText', 'listFiles', 'listDirs', 'execOut', 'shell', 'mkdirP', 'rm', 'dirExists', 'pushBuffer']
  // statusAfter：让"重试等待设备恢复"那几轮探到离线（否则用例要空等 graceMs × rounds）
  const statusSeq = []
  const cleanup = () => {
    for (const [n, v] of Object.entries(savedAdb)) core.adb[n] = v
    for (const [n, v] of Object.entries(savedTag)) core.tag[n] = v
    svc.adb.status = origStatus
    delete require.cache[pkey]
    require.cache[rkey].exports = origResolve
    require(pkey) // 让后续用例拿回真模块
  }
  try {
    require.cache[rkey].exports = { ...origResolve, resolveWithFallback: spec.resolveWithFallback }
    const defaults = { readText: () => '', listFiles: () => [], listDirs: () => [], execOut: () => '', shell: () => {}, mkdirP: () => {}, rm: () => {}, dirExists: () => false, pushBuffer: () => {} }
    const applied = { ...defaults, ...(spec.adb || {}) }
    for (const n of adbNames) { savedAdb[n] = core.adb[n]; core.adb[n] = applied[n] }
    for (const [n, fn] of Object.entries(spec.tag || {})) { savedTag[n] = core.tag[n]; core.tag[n] = fn }
    if (spec.status || spec.statusAfter) {
      svc.adb.status = () => {
        if (spec.statusAfter && statusSeq.length >= (spec.statusAfterAt || 1)) return spec.statusAfter
        statusSeq.push(1)
        return spec.status || { state: 'ready', message: 'x' }
      }
    }
    delete require.cache[pkey]
    return { phone: require(pkey), restore: cleanup }
  } catch (e) {
    cleanup()
    throw e
  }
}

/** 轮询等待条件成立（队列类测试用） */
async function until(cond, timeoutMs = 3000) {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('等待条件超时')
    await new Promise((r) => setTimeout(r, 10))
  }
}

/**
 * 手动放行的门闩：任务函数返回 gate.wait（pending Promise），等断言条件确认成立后再 gate.open()。
 * 用于替代"跑 60ms 任务 / 等 10ms 再取消"这类定时器竞速——事件循环一卡（GC、杀软扫描、CI 抖动）
 * 就会越过时间窗，排队任务先跑起来导致用例偶发翻车；门闩把时序钉死，零等待且完全确定。
 */
function makeGate() {
  let release
  const wait = new Promise((r) => { release = r })
  return { wait, open: () => release() }
}

// ---- 入口调度：banner + 计时（由入口调用） ----
let suiteStart = 0
function begin() {
  console.log('== 单元测试（纯函数，无网络） ==')
  suiteStart = Date.now()
}

// ---- 终局：失败详情、临时目录清场、汇总与退出码（由入口调用） ----
function finish() {
    // 失败详情先落盘再清临时目录（否则 failures.json 跟着临时目录一起被删掉）
    if (failures.length) {
      try {
        const summary = JSON.stringify(failures, null, 1)
        fs.writeFileSync(path.join(TEST_DOWNLOAD_DIR, 'failures-summary.json'), summary, 'utf8')
        // TEST_FAILURES 指定时另存一份到稳定路径：临时目录会被清掉，排障时需要留住现场
        if (process.env.TEST_FAILURES) fs.writeFileSync(process.env.TEST_FAILURES, summary, 'utf8')
        console.error(`\n== 失败详情（${failures.length} 条） ==`)
        failures.forEach((f, i) => console.error(`  ${i + 1}. ${f.name}\n     ${f.message}${f.stack ? '\n     ' + f.stack.split('\n')[0] : ''}`))
      } catch { /* 落盘失败也要把名字打出来 */ }
    }

    // 清理本进程创建的全部临时目录（只删 os.tmpdir 下的树，绝不碰真实 downloads\）。
    // rmRf 自带占用重试；即便本行被异常路径跳过，进程 exit 钩子还会幂等地兜底清一遍
    for (const d of TMP_DIRS) rmRf(d)

    // 还原被替换的 execFile 桩，避免宿主进程复用时带上测试桩
    childProcess.execFile = execFileOriginal

    const fails = results.filter((ok) => !ok).length
    // 汇总用同步写：exit 前的 console.log 走异步缓冲，紧跟 process.exit 会把行截断在缓冲区里
    const out = (s) => { try { fs.writeSync(1, s + '\n') } catch { /* 重定向目标关闭则无事 */ } }
    out(``)
    out(`== 单元测试: ${results.length - fails}/${results.length} 通过 ==`)
    out(`== 耗时 ${Date.now() - suiteStart}ms（纯本地 stub + 127.0.0.1 回环，无外网） ==`)
    process.exit(fails ? 1 : 0)
}

module.exports = {
  t, assert, fs, os, path, core, svc, tmpDir, rmRf, until, makeGate,
  stubPhoneIo, fakeAudioFetch, withStubbedPhone, execFileStub,
  childProcess, TEST_DOWNLOAD_DIR, begin, finish,
}
