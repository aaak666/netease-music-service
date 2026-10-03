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

async function main() {
  console.log('== 单元测试（纯函数，无网络） ==')
  // 无外网断言：本文件所有网络边界均已 stub 或只打 127.0.0.1 本地回环，
  // 外网源 song_url_v1(core.url.resolve)/song_detail(core.song.getDetail/getOne)/lyric.get/
  // streamTo/fetchBuffer/fetchFmPage/fetchSimiPage/fetchDetail/fetchToplist/raw 在各用例内替换、finally 恢复；
  // 全局 fetch 仅用于本地 serverMod.app.listen(0) 回环门面校验，从不打网易外网。suiteStart 计时证明毫秒级。
  const suiteStart = Date.now()

  await t('quality: br→level 映射（仅 320/2000 两档）', () => {
    assert.strictEqual(core.quality.toLevel('2000'), 'lossless')
    assert.strictEqual(core.quality.toLevel('320'), 'exhigh')
    assert.strictEqual(core.quality.toLevel('lossless'), 'lossless')
    assert.strictEqual(core.quality.toLevel(undefined), 'exhigh')
    assert.throws(() => core.quality.toLevel(''))      // 显式空串不静默降级
    assert.throws(() => core.quality.toLevel('9999'))
    assert.throws(() => core.quality.toLevel('128'))   // 档位已移除
    assert.throws(() => core.quality.toLevel('192'))   // 档位已移除
    assert.throws(() => core.quality.toLevel('hires')) // 档位已移除
    assert.throws(() => core.quality.toLevel('jymaster')) // 档位已移除
  })

  await t('quality: 降级阶梯仅在两档内回退', () => {
    assert.deepStrictEqual(core.quality.ladderFrom('lossless'), ['lossless', 'exhigh'])
    assert.deepStrictEqual(core.quality.ladderFrom('exhigh'), ['exhigh'])
    assert.throws(() => core.quality.ladderFrom('hires'))
  })

  await t('quality: extOf 只认 mp3/flac 白名单，异常 encodeType 按档位兜底', () => {
    assert.strictEqual(core.quality.extOf('lossless', 'flac'), 'flac')
    assert.strictEqual(core.quality.extOf('exhigh', 'MP3'), 'mp3')
    // 服务端异常 encodeType 不得透传成文件扩展名：scanDir 只认 mp3|flac|lrc，
    // 认领不了的文件会被增量对账当缺失每次重下、永不收敛
    assert.strictEqual(core.quality.extOf('lossless', 'ogg'), 'flac')
    assert.strictEqual(core.quality.extOf('exhigh', 'm4a'), 'mp3')
    assert.strictEqual(core.quality.extOf('lossless'), 'flac')
    assert.strictEqual(core.quality.extOf('exhigh'), 'mp3')
  })

  await t('params: br 显式 null 视为未传（缺省 2000），空串仍非法', () => {
    const { brOf, brError } = require('../src/service/params')
    assert.strictEqual(brOf({}), 2000)
    assert.strictEqual(brOf({ br: null }), 2000, 'JSON body 的 br:null 不得静默降为 320（与缺省语义一致）')
    assert.strictEqual(brOf({ br: undefined }), 2000)
    assert.strictEqual(brOf({ br: 0 }), 0, '显式 0 仍原样透传（由 toLevel 报非法，入口 400）')
    assert.strictEqual(brOf({ br: 320 }), 320)
    assert.ok(brError({ br: '' }), '显式空串仍须报非法（防 ?br= 被静默吞掉）')
  })

  await t('error: 参数类/结构类错误判终态不重试', () => {
    assert.strictEqual(core.error.isTransient(new Error('未知音质参数: 128，可用: exhigh/lossless 或 br 值 320/2000')), false)
    assert.strictEqual(core.error.isTransient(new Error('未知音质等级: hires')), false)
    assert.strictEqual(core.error.isTransient(new Error('FLAC 结构异常（块链解析失败），拒绝重建标签')), false)
  })

  await t('cookie: MUSIC_U=（键在值空）不算已登录', () => {
    const orig = process.env.NCM_COOKIE
    try {
      process.env.NCM_COOKIE = 'MUSIC_U='
      assert.strictEqual(core.cookie.has(), false, '空值 cookie 不得骗过 has()（否则界面显示已登录、请求全裸奔）')
      process.env.NCM_COOKIE = 'MUSIC_U=abc123'
      assert.strictEqual(core.cookie.has(), true)
      assert.strictEqual(core.cookie.get(), 'MUSIC_U=abc123')
    } finally {
      if (orig === undefined) delete process.env.NCM_COOKIE
      else process.env.NCM_COOKIE = orig
    }
  })

  await t('tag: undefined 标签不写 "undefined" 字面量；FLAC 结构异常判终态', () => {
    const audio = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(32, 1)])
    const tagged = core.tag.embedMp3Buf(audio, {})
    assert.strictEqual(tagged.indexOf(Buffer.from('undefined', 'utf16le')), -1, '文本帧不得写入 "undefined" 字面量')
    // 截断 FLAC 块头：旧代码抛裸 RangeError（文案不可读）且被判瞬时白烧一次重试
    const trunc = Buffer.concat([Buffer.from('fLaC', 'ascii'), Buffer.from('xxx', 'ascii')])
    let caught = null
    try { core.tag.embedFlacBuf(trunc, { title: 'a' }) } catch (e) { caught = e }
    assert.ok(caught && /FLAC 结构异常/.test(caught.message), `应转成可读的结构异常，实际: ${caught && caught.message}`)
    assert.strictEqual(core.error.isTransient(caught), false, '结构异常必须判终态')
  })

  await t('download: 文件名清洗', () => {
    assert.strictEqual(core.download.sanitize('a/b\\c:d*e?"f<>|g'), 'a_b_c_d_e__f___g')
    assert.ok(core.download.sanitize('  x  '.repeat(50)).length <= 120)
    assert.strictEqual(core.download.sanitize('a\u0000b\u0007c'), 'a_b_c') // 控制字符也清洗
  })

  await t('download: 文件名按码点截断，不切出孤立代理字符', () => {
    // 截断按码点而非 UTF-16 码元：若按码元切，119 个字符 + 一个 emoji 会在第 120 个码元处
    // 把代理对劈开，末尾变成孤立代理字符 —— Windows 拒绝该文件名（ENOENT），
    // 而报错发生在写盘阶段，看不出跟清洗有关
    const cut = core.download.sanitize('a'.repeat(119) + '\u{1F3B5}')
    const points = [...cut]
    assert.strictEqual(points.length, 120, `应保留 120 个码点，实际 ${points.length}`)
    assert.strictEqual(points[points.length - 1], '\u{1F3B5}',
      `emoji 应完整保留，实际末位码点 U+${points[points.length - 1].codePointAt(0).toString(16)}`)
    // 反证：确认旧的按码元写法确实会切坏（说明这条断言不是空跑）
    const naive = ('a'.repeat(119) + '\u{1F3B5}').slice(0, 120)
    assert.ok(/[\uD800-\uDFFF]/.test(naive[naive.length - 1]), '前提失效：按码元截断本例未切坏代理对')
  })

  await t('download: 魔数校验（合法分支）', () => {
    const flac = Buffer.concat([Buffer.from('fLaC'), Buffer.alloc(12)])
    const id3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(13)])
    const mp3Frame = Buffer.from([0xff, 0xfb, ...Buffer.alloc(14)])
    assert.ok(core.download.verifyMagic(flac, 'flac'))
    assert.ok(core.download.verifyMagic(id3, 'mp3'))
    assert.ok(core.download.verifyMagic(mp3Frame, 'mp3'))
  })

  await t('download: 魔数校验（非法分支）', () => {
    const html = Buffer.from('<!DOCTYPE html><html>...')
    assert.ok(!core.download.verifyMagic(html, 'flac'))
    assert.ok(!core.download.verifyMagic(html, 'mp3'))
  })

  await t('retry: 成功即返回，不重试', async () => {
    let calls = 0
    const r = await core.retry.withRetry(() => { calls++; return 'ok' }, { backoffMs: 1 })
    assert.strictEqual(r, 'ok')
    assert.strictEqual(calls, 1)
  })

  await t('retry: 失败后按次数重试', async () => {
    let calls = 0
    await assert.rejects(
      () => core.retry.withRetry(() => { calls++; throw new Error('boom') }, { retries: 2, backoffMs: 1 })
    )
    assert.strictEqual(calls, 3) // 首次 + 2 次重试
  })

  await t('retry: 第 N 次成功即停', async () => {
    let calls = 0
    const r = await core.retry.withRetry(() => {
      calls++
      if (calls < 3) throw new Error('not yet')
      return 'done'
    }, { retries: 3, backoffMs: 1 })
    assert.strictEqual(r, 'done')
    assert.strictEqual(calls, 3)
  })

  await t('meting: 格式组装', () => {
    const item = svc.meting.toMetingItem({ id: 1, name: 'x', artist: 'a/b' }, 'http://x/meting')
    assert.strictEqual(item.url, 'http://x/meting?type=url&id=1')
    assert.strictEqual(item.pic, 'http://x/meting?type=pic&id=1')
    assert.strictEqual(item.lrc, 'http://x/meting?type=lrc&id=1')
    assert.strictEqual(item.artist, 'a/b')
  })

  await t('raw: 未知模块报错', async () => {
    await assert.rejects(() => core.raw('no_such_module'))
  })

  await t('tag: MP3 内嵌封面 + 反向校验闭环', () => {
    const fs = require('fs')
    const path = require('path')
    const os = require('os')
    const dir = tmpDir('tagtest-')
    const mp3 = path.join(dir, 'a.mp3')
    // 构造最小 MPEG 帧（0xFF 0xFB 帧头 + 假数据）
    fs.writeFileSync(mp3, Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(400, 0x55)]))
    // 构造最小 PNG：魔数 + IHDR(w=3,h=2)
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR'),
      Buffer.from([0, 0, 0, 3, 0, 0, 0, 2, 8, 6, 0, 0, 0]), Buffer.alloc(4),
    ])
    const cover = path.join(dir, 'c.png')
    fs.writeFileSync(cover, png)
    core.tag.embedCover(mp3, { title: '测试<歌>名', artist: '歌手', album: '专辑', coverPath: cover, mime: 'image/png' })
    const v = core.tag.verifyTags(mp3)
    assert.ok(v.ok, 'verify 失败: ' + v.error)
    assert.ok(v.apic)
    // 再嵌一次：旧标签应被替换而非叠加，文件不膨胀
    const size1 = fs.statSync(mp3).size
    core.tag.embedCover(mp3, { title: '测试<歌>名', artist: '歌手', album: '专辑', coverPath: cover, mime: 'image/png' })
    const size2 = fs.statSync(mp3).size
    assert.strictEqual(size1, size2, '重复内嵌导致标签叠加')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  await t('tag: FLAC 内嵌封面 + 反向校验闭环 + 音频帧保留', () => {
    const fs = require('fs')
    const path = require('path')
    const os = require('os')
    const dir = tmpDir('tagtest-')
    const flac = path.join(dir, 'a.flac')
    // 构造最小 FLAC：fLaC + STREAMINFO(38B) + PADDING(last) + 音频帧
    const audioFrames = Buffer.concat([Buffer.from([0xff, 0xf8]), Buffer.alloc(200, 0xaa)])
    fs.writeFileSync(flac, Buffer.concat([
      Buffer.from('fLaC'),
      Buffer.from([0x00]), Buffer.from([0, 0, 38]), Buffer.alloc(38),
      Buffer.from([0x81]), Buffer.from([0, 0, 4]), Buffer.alloc(4),
      audioFrames,
    ]))
    const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100)])
    const cover = path.join(dir, 'c.jpg')
    fs.writeFileSync(cover, jpg)
    core.tag.embedCover(flac, { title: '歌', artist: '人', album: '片', coverPath: cover, mime: 'image/jpeg' })
    const v = core.tag.verifyTags(flac)
    assert.ok(v.ok, 'verify 失败: ' + v.error)
    assert.strictEqual(v.mime, 'image/jpeg')
    // 内嵌后音频帧必须原样保留在文件尾部
    const after = fs.readFileSync(flac)
    assert.ok(after.subarray(after.length - audioFrames.length).equals(audioFrames), '音频帧丢失！')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  await t('tag: FLAC 内嵌不留旧 VORBIS_COMMENT（规范只允许一个）+ 首块校验', () => {
    const fs = require('fs')
    const path = require('path')
    const os = require('os')
    const dir = tmpDir('vorbis-')
    try {
      const u24 = (n) => Buffer.from([(n >> 16) & 255, (n >> 8) & 255, n & 255])
      const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
      const audioFrames = Buffer.concat([Buffer.from([0xff, 0xf8]), Buffer.alloc(200, 0xaa)])
      const vorbis = (pairs) => {
        const vendor = Buffer.from('test', 'ascii')
        const cs = pairs.map((p) => Buffer.from(p[0] + '=' + p[1], 'utf8'))
        const parts = [u32le(vendor.length), vendor, u32le(cs.length)]
        for (const c of cs) { parts.push(u32le(c.length)); parts.push(c) }
        return Buffer.concat(parts)
      }
      // 造一个带旧 VORBIS_COMMENT 的 FLAC
      const blocks = [
        { type: 0, data: Buffer.alloc(34) },
        { type: 4, data: vorbis([['ARTIST', 'OldArtist']]) },
        { type: 1, data: Buffer.alloc(32) },
      ]
      const parts = [Buffer.from('fLaC', 'ascii')]
      blocks.forEach((b, i) => {
        parts.push(Buffer.from([(i === blocks.length - 1 ? 0x80 : 0) | b.type]), u24(b.data.length), b.data)
      })
      parts.push(audioFrames)
      const f = path.join(dir, 'a.flac')
      fs.writeFileSync(f, Buffer.concat(parts))
      core.tag.embedCover(f, { title: '新歌名', artist: '新歌手', album: '新专辑' })
      const buf = fs.readFileSync(f)
      let pos = 4, types = []
      while (pos < buf.length) {
        const head = buf[pos], type = head & 0x7f, len = buf.readUIntBE(pos + 1, 3)
        types.push(type)
        if (head & 0x80) break
        pos += 4 + len
      }
      assert.strictEqual(types.filter((t) => t === 4).length, 1, `应只剩 1 个 VORBIS_COMMENT，实际块链 ${types.join(',')}`)
      assert.strictEqual(types[0], 0, 'STREAMINFO 必须仍在首位')
      const v = core.tag.verifyTags(f)
      assert.ok(v.ok, 'verify 失败: ' + v.error)
      // 音频帧仍须原样保留在尾部
      assert.ok(buf.subarray(buf.length - audioFrames.length).equals(audioFrames), '音频帧丢失！')
      // 首块不是 STREAMINFO 的畸形输入必须报错，而不是"修好"成更坏的产物
      const bad = path.join(dir, 'bad.flac')
      const badBlocks = [{ type: 1, data: Buffer.alloc(8) }, { type: 0, data: Buffer.alloc(34) }]
      const bp = [Buffer.from('fLaC', 'ascii')]
      badBlocks.forEach((b, i) => {
        bp.push(Buffer.from([(i === badBlocks.length - 1 ? 0x80 : 0) | b.type]), u24(b.data.length), b.data)
      })
      bp.push(audioFrames)
      fs.writeFileSync(bad, Buffer.concat(bp))
      assert.throws(() => core.tag.embedCover(bad, { title: 'x', artist: 'y', album: '' }), /STREAMINFO/,
        '首块非 STREAMINFO 应抛错')
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  await t('tag: MP3 源文件带 ID3v2.4 footer 时内嵌不污染音频', () => {
    const fs = require('fs')
    const path = require('path')
    const os = require('os')
    const dir = tmpDir('footer-')
    try {
      const body = Buffer.from('TITLE=Old', 'utf8')
      const ss = (n) => Buffer.from([(n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127])
      const audioFrames = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(400, 0x55)])
      const f = path.join(dir, 'v24.mp3')
      // flags 0x10 = footer 存在；ID3v2.4 的 size 字段不含尾部 10 字节 footer
      fs.writeFileSync(f, Buffer.concat([
        Buffer.concat([Buffer.from('ID3', 'ascii'), Buffer.from([4, 0, 0x10]), ss(body.length)]),
        body,
        Buffer.concat([Buffer.from('3DI', 'ascii'), Buffer.from([4, 0, 0x10]), ss(body.length)]),
        audioFrames,
      ]))
      core.tag.embedCover(f, { title: 'T', artist: 'A', album: 'B' })
      const buf = fs.readFileSync(f)
      const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f)
      const end = 10 + size
      assert.notStrictEqual(buf.subarray(end, end + 3).toString('latin1'), '3DI',
        'footer 必须被跳过；留在音频开头会让播放器找不到帧同步 → 整首无声')
      assert.strictEqual(buf[end], 0xff, '标签后必须紧跟 MPEG 帧同步')
      assert.ok(buf.subarray(end).equals(audioFrames), '音频数据须原样保留')
      const v = core.tag.verifyTags(f)
      assert.ok(v.ok, 'verify 失败: ' + v.error)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  await t('tag: 损坏产物被校验器识破', () => {
    const fs = require('fs')
    const path = require('path')
    const os = require('os')
    const dir = tmpDir('tagtest-')
    const bad = path.join(dir, 'bad.mp3')
    fs.writeFileSync(bad, Buffer.from('ID3\x03\x00\x00\x00\x00\x10\x00garbage'))
    const v = core.tag.verifyTags(bad)
    assert.strictEqual(v.ok, false)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  await t('tag: 无封面时仅写文本标签（MP3+FLAC）', () => {
    const fs = require('fs')
    const path = require('path')
    const os = require('os')
    const dir = tmpDir('tagtest-')
    const mp3 = path.join(dir, 't.mp3')
    fs.writeFileSync(mp3, Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(400, 0x55)]))
    core.tag.embedCover(mp3, { title: '无封歌', artist: '某人', album: '' })
    const v1 = core.tag.verifyTags(mp3)
    assert.ok(v1.ok, 'mp3 verify: ' + v1.error)
    assert.strictEqual(v1.apic, false, '不应有封面帧')
    const flac = path.join(dir, 't.flac')
    fs.writeFileSync(flac, Buffer.concat([
      Buffer.from('fLaC'),
      Buffer.from([0x00]), Buffer.from([0, 0, 38]), Buffer.alloc(38),
      Buffer.from([0x81]), Buffer.from([0, 0, 4]), Buffer.alloc(4),
      Buffer.from([0xff, 0xf8]), Buffer.alloc(200, 0xaa),
    ]))
    core.tag.embedCover(flac, { title: '无封歌', artist: '某人', album: '' })
    const v2 = core.tag.verifyTags(flac)
    assert.ok(v2.ok, 'flac verify: ' + v2.error)
    assert.strictEqual(v2.mime, null, '不应有 PICTURE 块')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  await t('retry: 超时参数生效', async () => {
    await assert.rejects(
      () => core.retry.withRetry(() => new Promise((r) => setTimeout(r, 200)), { retries: 0, timeoutMs: 50 }),
      /请求超时/
    )
  })

  await t('lyric: 翻译行按时间戳紧跟原文', () => {
    const lrc = '[ti:测试]\n[00:05.00]你好世界\n[00:10.50]没有翻译\n[00:20.00]再见'
    const tlyric = '[00:05.00]hello world\n[00:20.00]goodbye'
    assert.strictEqual(
      core.lyric.mergeTranslation(lrc, tlyric),
      '[ti:测试]\n[00:05.00]你好世界\n[00:05.00]hello world\n[00:10.50]没有翻译\n[00:20.00]再见\n[00:20.00]goodbye',
    )
  })

  await t('lyric: 无翻译原样返回 / 空歌词返回空', () => {
    assert.strictEqual(core.lyric.mergeTranslation('[00:01.00]a', ''), '[00:01.00]a')
    assert.strictEqual(core.lyric.mergeTranslation('', '[00:01.00]x'), '')
    assert.strictEqual(core.lyric.mergeTranslation('[00:01.00]a', '[99:99.99]对不上时间戳'), '[00:01.00]a')
  })

  await t('lyric: 时间戳精度归一（.5 与 .50 同一时刻）', () => {
    assert.strictEqual(core.lyric.mergeTranslation('[00:05.50]歌', '[00:05.5]译'), '[00:05.50]歌\n[00:05.50]译')
  })

  await t('lyric: 重复时间戳每处都补翻译', () => {
    assert.strictEqual(
      core.lyric.mergeTranslation('[00:01.00]副歌\n[00:03.00]间奏\n[00:01.00]副歌', '[00:01.00]chorus'),
      '[00:01.00]副歌\n[00:01.00]chorus\n[00:03.00]间奏\n[00:01.00]副歌\n[00:01.00]chorus',
    )
  })

  await t('queue: 串行执行 + FIFO 顺序 + 最大并发 1', async () => {
    const q = svc.queue.createSerialQueue()
    const order = []
    let concurrent = 0
    let maxConcurrent = 0
    const task = (name, ms) => () => new Promise((resolve) => {
      concurrent++
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      order.push(name)
      setTimeout(() => { concurrent--; resolve() }, ms)
    })
    q.push(task('a', 30))
    q.push(task('b', 5))
    q.push(task('c', 1))
    await until(() => q.pending === 0 && !q.active)
    assert.deepStrictEqual(order, ['a', 'b', 'c'])
    assert.strictEqual(maxConcurrent, 1, `出现并发: ${maxConcurrent}`)
  })

  await t('queue: 任务抛错不阻塞后续', async () => {
    const q = svc.queue.createSerialQueue()
    const seen = []
    q.push(() => { throw new Error('boom') })
    q.push(() => { seen.push('after') })
    await until(() => q.pending === 0 && !q.active)
    assert.deepStrictEqual(seen, ['after'])
  })

  await t('queue: 运行中追加的任务排到队尾', async () => {
    const q = svc.queue.createSerialQueue()
    const order = []
    let firstStarted = false
    // first 由门闩持有：追加 third 的时机由"first 确认在运行"这个条件保证，
    // 不再 sleep 10ms 赌 first(40ms) 还没跑完的时间窗
    const gate = makeGate()
    q.push(() => { firstStarted = true; order.push('first'); return gate.wait })
    q.push(() => { order.push('second') })
    await until(() => firstStarted)
    q.push(() => { order.push('third') })
    assert.deepStrictEqual(order, ['first'], 'first 未放行时后续任务不得并行执行（追加的 third 应在队尾等待）')
    gate.open()
    await until(() => q.pending === 0 && !q.active)
    assert.deepStrictEqual(order, ['first', 'second', 'third'])
  })

  await t('tag: 封面以 Buffer 传入（下载路径，不落临时文件）', () => {
    const fs = require('fs')
    const path = require('path')
    const os = require('os')
    const dir = tmpDir('tagbuf-')
    const mp3 = path.join(dir, 'a.mp3')
    fs.writeFileSync(mp3, Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(400, 0x55)]))
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR'),
      Buffer.from([0, 0, 0, 3, 0, 0, 0, 2, 8, 6, 0, 0, 0]), Buffer.alloc(4),
    ])
    const embedded = core.tag.embedCover(mp3, { title: '歌', artist: '人', album: '片', cover: png, mime: 'image/png' })
    assert.strictEqual(embedded, true)
    const v = core.tag.verifyTags(mp3)
    assert.ok(v.ok && v.apic, `校验失败: ${v.error}`)
    // 目录里除音频外不应有任何其他文件（封面全程在内存）
    assert.deepStrictEqual(fs.readdirSync(dir), ['a.mp3'])
    fs.rmSync(dir, { recursive: true, force: true })
  })

  await t('storage: 启动清扫只删半成品（*.part/*.tagtmp，其余一律保留防误删）', () => {
    const fs = require('fs')
    const path = require('path')
    const os = require('os')
    const dir = tmpDir('sweep-')
    for (const f of ['a.mp3', 'a.lrc', 'b.flac', 'a.mp3.part', 'x.tagtmp', 'c-cover.jpg', 'd.txt', svc.storage.MARKER, svc.storage.REPORT_NAME]) {
      fs.writeFileSync(path.join(dir, f), 'x')
    }
    const removed = svc.storage.sweepDownloads(dir)
    assert.strictEqual(removed, 2, `应删 2 个（part/tagtmp），实际 ${removed}`)
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), [svc.storage.MARKER, svc.storage.REPORT_NAME, 'a.lrc', 'a.mp3', 'b.flac', 'c-cover.jpg', 'd.txt'].sort())
    fs.rmSync(dir, { recursive: true, force: true })
  })

  await t('storage: 批次目录命名（名字/时间戳 + 重名加序号 + 保留名清洗）', () => {
    const fs = require('fs')
    const path = require('path')
    const os = require('os')
    const base = tmpDir('batch-')
    const d1 = svc.storage.createBatchDir(base, '我/的歌单', 'playlist')
    assert.strictEqual(path.basename(d1), '我_的歌单')
    assert.ok(fs.existsSync(d1))
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(d1, svc.storage.MARKER), 'utf8')).type, 'playlist')
    const d2 = svc.storage.createBatchDir(base, '我/的歌单', 'playlist')
    assert.strictEqual(path.basename(d2), '我_的歌单 (2)')
    const d3 = svc.storage.createBatchDir(base, '')
    assert.ok(/^\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}$/.test(path.basename(d3)), '时间戳命名异常: ' + path.basename(d3))
    assert.strictEqual(svc.storage.batchStem('con'), '_con')      // Windows 保留名
    assert.strictEqual(svc.storage.batchStem('LPT4'), '_LPT4')
    fs.rmSync(base, { recursive: true, force: true })
  })

  await t('server: 启动清扫递归进入批次子目录（只删 part/tagtmp）', () => {
    const fs = require('fs')
    const path = require('path')
    const os = require('os')
    const dir = tmpDir('sweep2-')
    const sub = path.join(dir, '歌单A')
    fs.mkdirSync(sub)
    fs.writeFileSync(path.join(sub, 'a.mp3'), 'x')
    fs.writeFileSync(path.join(sub, 'a.mp3.part'), 'x')
    fs.writeFileSync(path.join(sub, 'b.tagtmp'), 'x')
    fs.writeFileSync(path.join(sub, 'cover.jpg'), 'x')
    fs.writeFileSync(path.join(sub, '备注.txt'), 'x')
    fs.writeFileSync(path.join(dir, 'top.part'), 'x')
    const removed = svc.storage.sweepDownloads(dir)
    assert.strictEqual(removed, 3, `应删 3 个（子目录 part/tagtmp + 顶层 part），实际 ${removed}`)
    assert.deepStrictEqual(fs.readdirSync(sub).sort(), ['a.mp3', 'cover.jpg', '备注.txt'].sort())
    fs.rmSync(dir, { recursive: true, force: true })
  })

  await t('incremental: scanDir 只索引音频与 lrc（按扩展名分桶，目录缺失返回空索引）', () => {
    const fs = require('fs')
    const path = require('path')
    const os = require('os')
    const dir = tmpDir('inc-')
    for (const f of ['a.mp3', 'a.lrc', 'a.flac', 'b.flac', 'c.txt', 'd.mp3.part']) fs.writeFileSync(path.join(dir, f), 'x')
    const idx = svc.incremental.scanDir(dir)
    assert.deepStrictEqual([...idx.audio.keys()].sort(), ['a', 'b'])
    assert.deepStrictEqual([...idx.audio.get('a')].sort(), ['flac', 'mp3'], '同基础名两种音质共存')
    assert.deepStrictEqual([...idx.audio.get('b')], ['flac'])
    assert.deepStrictEqual([...idx.lrc].sort(), ['a'])
    const missing = svc.incremental.scanDir(path.join(dir, '不存在'))
    assert.strictEqual(missing.audio.size + missing.lrc.size, 0)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  await t('incremental: 三分类（缺音频→下载 / 缺歌词→补 / 齐全→跳过）', () => {
    const { plan } = svc.incremental
    const index = { audio: new Map([['a', new Set(['mp3'])], ['b', new Set(['mp3'])]]), lrc: new Set(['a']) }
    const songs = [{ id: 1, name: 'a' }, { id: 2, name: 'b' }, { id: 3, name: 'c' }]
    const p = plan(songs, index)
    assert.deepStrictEqual(p.download.map((s) => s.id), [3])
    assert.deepStrictEqual(p.fill.map((s) => s.id), [2])
    assert.deepStrictEqual(p.skipped.map((s) => s.id), [1])
    // 全新目录：全部走下载
    const empty = plan(songs, { audio: new Map(), lrc: new Set() })
    assert.strictEqual(empty.download.length, 3)
    // 歌名清洗与下载命名一致（非法字符同规则）
    const odd = plan([{ id: 4, name: 'a/b:c' }], { audio: new Map([['a_b_c', new Set(['mp3'])]]), lrc: new Set() })
    assert.deepStrictEqual(odd.fill.map((s) => s.id), [4])
  })

  await t('storage: findBatchDir 复用同名目录 / 来源标记防跨来源认领 / 旧目录向后兼容', () => {
    const fs = require('fs')
    const path = require('path')
    const os = require('os')
    const base = tmpDir('find-')
    assert.strictEqual(svc.storage.findBatchDir(base, '我的喜欢'), null)
    const made = svc.storage.createBatchDir(base, '我的喜欢', 'playlist')
    assert.strictEqual(svc.storage.findBatchDir(base, '我的喜欢', 'playlist'), made)
    assert.strictEqual(svc.storage.findBatchDir(base, ''), null) // 无名字不匹配时间戳目录
    fs.rmSync(base, { recursive: true, force: true })
    // 榜单批次目录（type=chart）不被歌单增量认领；无标记旧目录向后兼容
    const base2 = tmpDir('find2-')
    const chartDir = svc.storage.createBatchDir(base2, '同名榜单', 'chart')
    assert.strictEqual(svc.storage.findBatchDir(base2, '同名榜单', 'playlist'), null)
    const legacy = path.join(base2, '旧歌单')
    fs.mkdirSync(legacy)
    assert.strictEqual(svc.storage.findBatchDir(base2, '旧歌单', 'playlist'), legacy)
    fs.rmSync(base2, { recursive: true, force: true })
  })

  await t('storage: 同名不同 id 的歌单互不认领（重名歌单共用目录会让歌被误跳过）', () => {
    const fs = require('fs')
    const path = require('path')
    const os = require('os')
    const base = tmpDir('same-')
    try {
      // 两个不同歌单同名（网易云"我喜欢的音乐"这类重名极常见）
      const dirA = svc.storage.createBatchDir(base, '我喜欢的音乐', 'playlist', '111')
      fs.writeFileSync(path.join(dirA, '晴天.flac'), 'x')
      fs.writeFileSync(path.join(dirA, '晴天.lrc'), 'x')
      // B(id=222) 不得复用 A 的目录，否则 B 的「晴天」会被 A 的同名文件误判为已存在
      assert.strictEqual(svc.storage.findBatchDir(base, '我喜欢的音乐', 'playlist', '222'), null)
      const dirB = svc.storage.createBatchDir(base, '我喜欢的音乐', 'playlist', '222')
      assert.notStrictEqual(dirB, dirA, '同名不同歌单必须各建各的目录')
      const planB = svc.incremental.plan(
        [{ id: 3, name: '晴天', artist: '周杰伦' }],
        svc.incremental.scanDir(dirB),
      )
      assert.deepStrictEqual(planB.download.map((s) => s.id), [3], 'B 的歌必须下载，不能被 A 的产物误跳过')
      assert.deepStrictEqual(planB.skipped, [], 'B 不该有任何跳过')
      // A 自己再次识别仍应命中原目录（增量复用不被破坏）
      assert.strictEqual(svc.storage.findBatchDir(base, '我喜欢的音乐', 'playlist', '111'), dirA)
      // 带 id 优先命中带 id 的目录；旧的无 id 目录仍能被认领（历史数据不丢）
      const base2 = tmpDir('legacy-')
      const legacy = svc.storage.createBatchDir(base2, '老歌单', 'playlist')
      assert.strictEqual(svc.storage.findBatchDir(base2, '老歌单', 'playlist', '999'), legacy,
        '标记里没有 ownerId 的旧目录应继续被认领，避免历史下载被重下一遍')
      fs.rmSync(base2, { recursive: true, force: true })
    } finally { fs.rmSync(base, { recursive: true, force: true }) }
  })

  await t('incremental: fillLyric 补词/无词/失败（stub core.lyric）', async () => {
    const fs = require('fs')
    const path = require('path')
    const os = require('os')
    const dir = tmpDir('fill-')
    const orig = core.lyric.get
    core.lyric.get = async (id) => {
      if (id === 1) return { lrc: '[00:01.00]词', tlyric: '' }
      if (id === 2) return { lrc: '', tlyric: '' }
      throw new Error('超时')
    }
    try {
      const r1 = await svc.incremental.fillLyric({ id: 1, name: '有词歌' }, dir)
      assert.ok(r1.ok && r1.lrcFile, '有词应写入')
      assert.ok(fs.existsSync(r1.lrcFile))
      const r2 = await svc.incremental.fillLyric({ id: 2, name: '无词歌' }, dir)
      assert.ok(r2.ok && r2.noLyric, '无词应标记 noLyric')
      const r3 = await svc.incremental.fillLyric({ id: 3, name: '坏歌' }, dir)
      assert.ok(!r3.ok && r3.error, '失败应返回 error 不抛出')
    } finally {
      core.lyric.get = orig
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  await t('incremental: run 执行计划 + summarize 汇总（注入 downloadMany）', async () => {
    const path = require('path')
    const os = require('os')
    const fs = require('fs')
    const dir = tmpDir('run-')
    const plan = { download: [{ id: 1, name: '新歌' }], fill: [{ id: 2, name: '缺词' }, { id: 4, name: '无词' }], skipped: [{ id: 3, name: '旧歌' }] }
    const fakeMany = async (list, o) => {
      assert.strictEqual(o.dir, dir)
      return list.map((s) => {
        const r = { ok: true, filepath: path.join(dir, `${s.name}.mp3`) }
        if (o.onFile) o.onFile(r, s)
        return r
      })
    }
    const orig = core.lyric.get
    core.lyric.get = async (id) => (String(id) === '2'
      ? { lrc: '[00:01.00]词', tlyric: '' }
      : { lrc: '', tlyric: '' }) // 补词走真实 fillLyric，stub 网络层（id 4 站内无词）
    try {
      const seen = []
      const { results, fillResults } = await svc.incremental.run(plan, { dir, downloadMany: fakeMany }, {
        onFile: (r) => seen.push(r),
      })
      assert.strictEqual(results.length, 1)
      assert.strictEqual(fillResults.length, 2)
      assert.ok(fillResults[0].ok && fillResults[0].lrcFile, '补词应真实写盘')
      assert.ok(fs.existsSync(path.join(dir, '缺词.lrc')))
      assert.ok(fillResults[1].ok && fillResults[1].noLyric, '无词应标记 noLyric')
      assert.strictEqual(seen.length, 3, '下载与补词都应触发 onFile')
      const sum = svc.incremental.summarize({ total: 4, results, fillResults, skipped: plan.skipped.length })
      assert.deepStrictEqual(
        { total: sum.total, ok: sum.ok, skipped: sum.skipped, filled: sum.filled, noLyric: sum.noLyric, failed: sum.failed.length },
        { total: 4, ok: 1, skipped: 1, filled: 1, noLyric: 1, failed: 0 },
      )
      assert.deepStrictEqual(sum.files, [path.join(dir, '新歌.mp3')])
    } finally {
      core.lyric.get = orig
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  await t('error: errMsg 归一文案（JSON/短文案原样、超长截断带原文长度、无 body 走 message）', () => {
    const { errMsg } = core.error
    assert.strictEqual(errMsg({ status: 301, body: { code: 301, msg: '需要登录' } }), '{"code":301,"msg":"需要登录"}')
    assert.strictEqual(errMsg({ status: 404, body: '接口不存在' }), '接口不存在')
    assert.strictEqual(errMsg(new Error('无可用链接 (id=1)')), '无可用链接 (id=1)') // 无 body → message 分支
    const html = '<!DOCTYPE html>' + 'x'.repeat(50000) + '</html>' // 代理/劫持返回的整页 HTML 错误
    const out = errMsg({ status: 502, body: html })
    assert.strictEqual(out, html.slice(0, 300) + `…（响应过长已截断，原文 ${html.length} 字符）`)
    assert.ok(out.length < 400, `截断后应远小于原文，实际 ${out.length}`)
  })

  await t('retry: withTimeout 透传/判负/晚到 rejection 不逃逸 + withRetry 成功无野定时器', async () => {
    assert.strictEqual(await core.retry.withTimeout(Promise.resolve('ok'), 1000), 'ok')
    await assert.rejects(() => core.retry.withTimeout(Promise.reject(new Error('底层挂了')), 1000), /底层挂了/)
    await assert.rejects(() => core.retry.withTimeout(new Promise(() => {}), 50), /请求超时\(50ms\)/)
    // 超时判负后底层晚到的 rejection：race 已订阅，不得变成未处理异常
    let unhandled = 0
    const onUnhandled = () => { unhandled++ }
    process.on('unhandledRejection', onUnhandled)
    try {
      await assert.rejects(
        () => core.retry.withTimeout(new Promise((_, rej) => setTimeout(() => rej(new Error('晚到')), 30)), 10),
        /请求超时\(10ms\)/,
      )
      await new Promise((r) => setTimeout(r, 60)) // 等晚到 rejection 走完微任务检查点
      assert.strictEqual(unhandled, 0, `出现 ${unhandled} 个未处理 rejection`)
    } finally {
      process.removeListener('unhandledRejection', onUnhandled)
    }
    // withRetry 成功路径：超时定时器必须当帧清掉，不得留野定时器占用事件循环
    const countTimers = () => process.getActiveResourcesInfo().filter((x) => x === 'Timeout').length
    const before = countTimers()
    const r = await core.retry.withRetry(() => Promise.resolve('ok'), { retries: 0, timeoutMs: 3000 })
    assert.strictEqual(r, 'ok')
    assert.ok(countTimers() <= before, `成功后多出 ${countTimers() - before} 个未清理定时器`)
  })

  await t('playlist: get 按 limit 截断再取详情（stub core 边界，count 不受截断影响）', async () => {
    const origFetch = core.playlist.fetchDetail
    const origGetDetail = core.song.getDetail
    const trackIds = Array.from({ length: 1000 }, (_, i) => i + 1)
    let gotIds = null
    core.playlist.fetchDetail = async () => ({ id: 1, name: '千首大歌单', count: trackIds.length, coverUrl: '', trackIds })
    core.song.getDetail = async (ids) => {
      gotIds = ids
      return ids.map((id) => ({ id, name: '歌' + id, artist: 'a', album: 'al', duration: 0 }))
    }
    try {
      const limited = await svc.playlist.get('1', { limit: 20 })
      assert.strictEqual(gotIds.length, 20, `limit=20 应只对 20 个 id 取详情，实际 ${gotIds.length}`)
      assert.strictEqual(limited.songs.length, 20)
      assert.strictEqual(limited.count, 1000, 'count 应仍是歌单总曲数，不受截断影响')
      const full = await svc.playlist.get('1')
      assert.strictEqual(gotIds.length, 1000, '无 limit 应取全量')
      assert.strictEqual(full.songs.length, 1000)
      await svc.playlist.get('1', { limit: 0 })
      assert.strictEqual(gotIds.length, 1000, 'limit=0 视为全部（与 server 切片口径一致）')
    } finally {
      core.playlist.fetchDetail = origFetch
      core.song.getDetail = origGetDetail
    }
  })

  await t('incremental: plan 歌词开关（lyrics:false 并入 skipped、口径闭合；缺省与 true 行为不变）', () => {
    const index = { audio: new Map([['缺词歌', new Set(['mp3'])], ['齐全歌', new Set(['mp3'])]]), lrc: new Set(['齐全歌']) }
    const songs = [{ id: 1, name: '缺词歌' }, { id: 2, name: '齐全歌' }, { id: 3, name: '新歌' }]
    const on = svc.incremental.plan(songs, index)
    assert.deepStrictEqual(on.download.map((s) => s.id), [3])
    assert.deepStrictEqual(on.fill.map((s) => s.id), [1])
    assert.deepStrictEqual(on.skipped.map((s) => s.id), [2])
    assert.deepStrictEqual(svc.incremental.plan(songs, index, { lyrics: true }), on, 'lyrics:true 应与缺省逐字一致')
    const off = svc.incremental.plan(songs, index, { lyrics: false })
    assert.deepStrictEqual(off.fill, [], '关补词后 fill 应清空')
    assert.deepStrictEqual(off.skipped.map((s) => s.id).sort(), [1, 2], '缺词歌应并入 skipped')
    assert.strictEqual(off.download.length + off.fill.length + off.skipped.length, songs.length, '每首歌恰好归一类（日志行数 = 歌数）')
    const sum = svc.incremental.summarize({
      total: songs.length,
      results: off.download.map((s) => ({ ok: true, filepath: 'x/' + s.name + '.mp3' })),
      fillResults: [],
      skipped: off.skipped.length,
    })
    assert.strictEqual(sum.ok + sum.skipped + sum.failed.length, songs.length, '汇总口径必须闭合: ' + JSON.stringify(sum))
  })

  await t('incremental: summarize 把 existed（同音质已存在、未真下）与新下载分开计数', () => {
    // 音质补下模式命中 skipIfExists 时结果带 existed:true，但文件根本没下。
    // 混进 ok 会让批次报告写"新下载 N"虚高，且 files 里混着旧文件
    const sum = svc.incremental.summarize({
      total: 4,
      results: [
        { ok: true, filepath: 'x/新1.flac' },
        { ok: true, filepath: 'x/已有.flac', existed: true },
        { ok: true, filepath: 'x/已有2.flac', existed: true },
        { ok: false, id: 9, name: '坏歌', error: '超时' },
      ],
      fillResults: [], skipped: 0,
    })
    assert.strictEqual(sum.ok, 1, '新下载只算真正落盘的')
    assert.strictEqual(sum.existed, 2, 'existed 单独计数')
    assert.deepStrictEqual(sum.files, ['x/新1.flac'], 'files 不该混 existed 的旧文件')
    assert.strictEqual(sum.failed.length, 1)
    // 口径闭合：ok + existed + skipped + failed == total
    assert.strictEqual(sum.ok + sum.existed + sum.skipped + sum.failed.length, sum.total)
    // 报告文案：existed 为 0 时不占篇幅，非 0 时写进摘要行
    const fs = require('fs'), path = require('path'), os = require('os')
    const dir = tmpDir('rep-')
    try {
      svc.storage.writeBatchReport(dir, { label: '歌单: 测试', br: 2000, summary: sum })
      const txt = fs.readFileSync(path.join(dir, svc.storage.REPORT_NAME), 'utf8')
      assert.ok(txt.includes('新下载 1'), '应报 1 个新下载')
      assert.ok(txt.includes('同音质已存在 2'), '应单列 existed')
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  await t('download: assignBaseNames 同批同名组全组加歌手后缀（产品拍板：两首都加）', () => {
    const { assignBaseNames } = svc.download
    const songs = [
      { id: 1, name: '晴天', artist: '周杰伦' },
      { id: 2, name: '晴天', artist: '孙燕姿' },
      { id: 3, name: '七里香', artist: '周杰伦' },
    ]
    const m = assignBaseNames(songs)
    assert.strictEqual(m.get(songs[0]), '晴天 - 周杰伦', '同名组第一首也要加歌手')
    assert.strictEqual(m.get(songs[1]), '晴天 - 孙燕姿')
    assert.strictEqual(m.get(songs[2]), '七里香', '独名歌保持纯歌名')
  })

  await t('download: assignBaseNames 拒绝重复对象引用（Map 无法区分两次出现）', () => {
    const { assignBaseNames } = svc.download
    const s = { id: 1, name: '晴天', artist: '周杰伦' }
    // 同一个对象出现两次时 Map 只能存一份，第二处会静默覆盖第一处的文件名 → 两首歌写进同一文件
    assert.throws(() => assignBaseNames([s, s]), /重复对象引用/,
      '必须显式报错，不能悄悄让两首歌共用一个文件名')
    // 不同对象（现实中 getDetail 的常态）不受影响
    const a = { id: 1, name: '晴天', artist: '周杰伦' }
    const b = { id: 2, name: '晴天', artist: '周杰伦' }
    const m = assignBaseNames([a, b])
    assert.notStrictEqual(m.get(a), m.get(b), '不同对象必须拿到不同文件名')
  })

  await t('download: assignBaseNames 避开已有文件 + 认领旧产物 + 同名同歌手加序号', () => {
    const { assignBaseNames } = svc.download
    // 磁盘已有同名产物（旧版纯歌名）：认领原名，不重命名、不覆盖（名称匹配口径：视为已存在）
    const s1 = { id: 1, name: '晴天', artist: '孙燕姿' }
    assert.strictEqual(assignBaseNames([s1], new Set(['晴天'])).get(s1), '晴天')
    // 磁盘已有"歌名 - 歌手"产物（新版命名）：同样认领
    const s2 = { id: 2, name: '晴天', artist: '周杰伦' }
    assert.strictEqual(assignBaseNames([s2], new Set(['晴天 - 周杰伦'])).get(s2), '晴天 - 周杰伦')
    // 纯名被占用但歌没被认领过（同批另有同名歌认领了它）：剩下的拿歌手后缀，绝不与磁盘重名
    const s3 = { id: 3, name: '晴天', artist: '孙燕姿' }
    const s3a = { id: 30, name: '晴天', artist: '周杰伦' }
    const m3 = assignBaseNames([s3a, s3], new Set(['晴天']))
    assert.strictEqual(m3.get(s3a), '晴天', '第一首认领磁盘旧名')
    assert.strictEqual(m3.get(s3), '晴天 - 孙燕姿', '第二首拿歌手后缀')
    // 同名同歌手（歌单重复收录的极端情况）：加序号区分
    const s4 = { id: 4, name: '晴天', artist: '周杰伦' }
    const s5 = { id: 5, name: '晴天', artist: '周杰伦' }
    const m4 = assignBaseNames([s4, s5])
    assert.deepStrictEqual([m4.get(s4), m4.get(s5)], ['晴天 - 周杰伦', '晴天 - 周杰伦 (2)'])
  })

  await t('incremental: plan 同名新歌不再误跳过（认领 + 新名分配同一份）', () => {
    const { plan } = svc.incremental
    const songs = [
      { id: 1, name: '晴天', artist: '周杰伦' }, // 磁盘已有纯歌名旧产物 → 认领，跳过
      { id: 2, name: '晴天', artist: '孙燕姿' }, // 同名不同歌手的新歌 → 下载，命名带歌手
    ]
    const p = plan(songs, { audio: new Map([['晴天', new Set(['flac'])]]), lrc: new Set(['晴天']) })
    assert.deepStrictEqual(p.skipped.map((s) => s.id), [1], '磁盘旧产物对应的第一首跳过')
    assert.deepStrictEqual(p.download.map((s) => s.id), [2], '同名新歌不得被误判为已存在')
    assert.strictEqual(p.bases.get(songs[0]), '晴天')
    assert.strictEqual(p.bases.get(songs[1]), '晴天 - 孙燕姿')
  })

  await t('incremental: plan 音质补下（qualityExt：缺目标音质→补下，旧音质保留，已有歌词不重写）', () => {
    const { plan } = svc.incremental
    const index = { audio: new Map([['a', new Set(['mp3'])], ['b', new Set(['mp3', 'flac'])], ['c', new Set(['mp3'])]]), lrc: new Set(['a', 'b']) }
    const songs = [
      { id: 1, name: 'a' }, // 已有 mp3+歌词，要无损 → 补下，歌词已有不重写
      { id: 2, name: 'b' }, // mp3/flac 双全，要无损 → 原样跳过
      { id: 3, name: 'c' }, // 已有 mp3 无歌词，要无损 → 补下且要写词
      { id: 4, name: 'd' }, // 无任何音频 → 正常下载（与音质补下无关）
    ]
    const p = plan(songs, index, { qualityExt: 'flac' })
    assert.deepStrictEqual(p.download.map((s) => s.id), [1, 3, 4], '缺目标音质的补下 + 缺音频的正常下载')
    assert.deepStrictEqual(p.skipped.map((s) => s.id), [2], '目标音质已在的不动')
    assert.strictEqual(p.lyricsFor.has(songs[0]), false, '已有歌词不得重写')
    assert.strictEqual(p.lyricsFor.has(songs[2]), true, '缺歌词的补下时顺带写词')
    assert.strictEqual(p.lyricsFor.has(songs[3]), true)
    // 不勾选补下（qualityExt 缺省）：任何音质在即视为已存在（原口径回归）
    const off = plan(songs, index)
    assert.deepStrictEqual(off.download.map((s) => s.id), [4])
    assert.deepStrictEqual(off.fill.map((s) => s.id), [3], '缺歌词仍走补词')
    assert.deepStrictEqual(off.skipped.map((s) => s.id), [1, 2])
    // 反向：先下的无损，补 320k 同理
    const p2 = plan([{ id: 9, name: 'b' }], index, { qualityExt: 'mp3' })
    assert.deepStrictEqual(p2.download, [], 'b 的 mp3 已在，不补')
    const p3 = plan([{ id: 10, name: 'a' }], index, { qualityExt: 'flac' })
    assert.strictEqual(p3.download.length, 1)
  })

  await t('incremental: run 透传 bases/lyricsFor/skipIfExists（歌词只对缺词的下载歌开启）', async () => {
    const s1 = { id: 1, name: '有词歌' }
    const s2 = { id: 2, name: '缺词歌' }
    const plan = {
      download: [s1, s2], fill: [], skipped: [],
      bases: new Map([[s1, '有词歌'], [s2, '缺词歌']]),
      lyricsFor: new Set([s2]),
    }
    let seen = null
    const fakeMany = async (list, o) => { seen = o; return list.map((s) => ({ ok: true, filepath: 'x/' + s.name + '.mp3' })) }
    await svc.incremental.run(plan, { dir: 'd', lyrics: true, skipIfExists: true, downloadMany: fakeMany }, {})
    assert.strictEqual(seen.bases, plan.bases, '命名分配必须原样透传')
    assert.strictEqual(seen.lyricsFor.has(s1), false, '已有歌词的歌不得写词')
    assert.strictEqual(seen.lyricsFor.has(s2), true)
    assert.strictEqual(seen.skipIfExists, true, '音质补下的防覆盖标志透传')
    // 调用方没开歌词时 lyricsFor 整体失效（与原"下载写词需显式开启"口径一致）
    await svc.incremental.run(plan, { dir: 'd', lyrics: false, downloadMany: fakeMany }, {})
    assert.strictEqual(seen.lyricsFor.size, 0)
  })

  await t('storage: writeBatchReport 落盘"下载结果.txt"且被清扫白名单放行', () => {
    const fs = require('fs')
    const path = require('path')
    const os = require('os')
    const dir = tmpDir('report-')
    fs.writeFileSync(path.join(dir, 'a.mp3'), 'x')
    const ok = svc.storage.writeBatchReport(dir, {
      label: '歌单: 测试',
      br: 2000,
      summary: { total: 3, ok: 1, skipped: 1, skippedNames: ['旧歌'], filled: 1, failed: [{ name: '坏歌', error: '无可用链接' }], files: [] },
    })
    assert.ok(ok)
    const report = fs.readFileSync(path.join(dir, svc.storage.REPORT_NAME), 'utf8')
    assert.ok(report.includes('歌单: 测试'), '含批次名')
    assert.ok(report.includes('新下载 1') && report.includes('补歌词 1') && report.includes('跳过 1') && report.includes('失败 1'), '含四项计数')
    assert.ok(report.includes('坏歌 — 无可用链接'), '含失败明细')
    assert.ok(report.includes('旧歌'), '含跳过明细')
    // 清扫只删半成品，报告/音频/用户备注保留
    fs.writeFileSync(path.join(dir, 'junk.part'), 'x')
    fs.writeFileSync(path.join(dir, 'junk.tagtmp'), 'x')
    fs.writeFileSync(path.join(dir, '备注.txt'), 'x')
    assert.strictEqual(svc.storage.sweepDownloads(dir), 2)
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['a.mp3', svc.storage.REPORT_NAME, '备注.txt'].sort())
    fs.rmSync(dir, { recursive: true, force: true })
  })

  await t('resolve: 降级只认 noUrl（网络错误上抛，不静默降音质）', async () => {
    const orig = core.url.resolve
    const calls = []
    core.url.resolve = async (id, { level }) => {
      calls.push(level)
      if (level === 'lossless') throw new Error('连接重置') // 网络层错误：不带 noUrl
      return { id: Number(id), url: 'http://x/a.mp3', br: 320, size: 1, level: 'exhigh', type: 'mp3', ext: 'mp3' }
    }
    try {
      await assert.rejects(() => svc.resolve.resolveWithFallback(1, { br: 2000 }), /连接重置/)
      assert.deepStrictEqual(calls, ['lossless'], '网络错误不得落阶梯（否则选无损静默变 320k）')
      calls.length = 0
      core.url.resolve = async (id, { level }) => {
        calls.push(level)
        if (level === 'lossless') { const e = new Error('无可用链接 (id=1, level=lossless)'); e.noUrl = true; throw e }
        return { id: Number(id), url: 'http://x/a.mp3', br: 320, size: 1, level: 'exhigh', type: 'mp3', ext: 'mp3' }
      }
      const r = await svc.resolve.resolveWithFallback(1, { br: 2000 })
      assert.strictEqual(r.level, 'exhigh')
      assert.deepStrictEqual(calls, ['lossless', 'exhigh'], '服务端确认无资源时才落阶梯')
    } finally { core.url.resolve = orig }
  })

  await t('chart: get limit 透传（先截断 trackIds 再取详情，count 恒为总曲数）', async () => {
    const origTop = core.chart.fetchToplist
    const origDetail = core.playlist.fetchDetail
    const origGetDetail = core.song.getDetail
    const trackIds = Array.from({ length: 1000 }, (_, i) => i + 1)
    let gotIds = null
    core.chart.fetchToplist = async () => [{ id: 999, name: '测试榜', updateTime: '' }]
    core.playlist.fetchDetail = async () => ({ id: 999, name: '测试榜', count: trackIds.length, coverUrl: '', trackIds })
    core.song.getDetail = async (ids) => { gotIds = ids; return ids.map((id) => ({ id, name: '歌' + id, artist: 'a', album: 'al', duration: 0 })) }
    try {
      const c = await svc.chart.get('测试榜', { limit: 20 })
      assert.strictEqual(gotIds.length, 20, `limit=20 应只取 20 个详情，实际 ${gotIds.length}`)
      assert.strictEqual(c.songs.length, 20)
      assert.strictEqual(c.count, 1000, 'count 应是榜单总曲数，不受 limit 影响')
      const full = await svc.chart.get('测试榜')
      assert.strictEqual(gotIds.length, 1000, '无 limit 应取全量')
      assert.strictEqual(full.count, 1000)
    } finally {
      core.chart.fetchToplist = origTop
      core.playlist.fetchDetail = origDetail
      core.song.getDetail = origGetDetail
    }
  })

  await t('download: 批次封面按 picUrl 去重 / 失败即清 .part / existed 早退仍补缺词', async () => {
    const fs = require('fs')
    const path = require('path')
    const os = require('os')
    const dir = tmpDir('dl-')
    const origResolve = core.url.resolve
    const origStream = core.download.streamTo
    const origFetch = core.download.fetchBuffer
    const origLyric = core.lyric.get
    let fetches = 0
    core.url.resolve = async (id) => ({ id: Number(id), url: 'http://x/a.mp3', br: 320, size: 404, level: 'exhigh', type: 'mp3', ext: 'mp3' })
    core.download.streamTo = async (url, filepath) => {
      fs.writeFileSync(filepath, Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(400, 0x55)]))
      return { size: 404, total: 404 }
    }
    core.download.fetchBuffer = async () => { fetches++; return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(50)]) }
    const songs = [
      { id: 1, name: '甲', artist: 'a', picUrl: 'http://pic/1', duration: 0 },
      { id: 2, name: '乙', artist: 'b', picUrl: 'http://pic/1', duration: 0 }, // 同专辑 → 同 picUrl
    ]
    try {
      const rs = await svc.download.downloadMany(songs, { dir, br: 320, cover: true })
      assert.strictEqual(rs.length, 2)
      assert.ok(rs.every((r) => r.ok && r.embedded), `下载/内嵌失败: ${JSON.stringify(rs.map((r) => r.error || r.embedError))}`)
      assert.strictEqual(fetches, 1, `同 picUrl 应只拉一次封面，实际 ${fetches}`)
      // 流式下载两次都失败 → .part 必须被清掉，不等到下次启动清扫
      core.download.streamTo = async (url, filepath) => { fs.writeFileSync(filepath, Buffer.alloc(10)); throw new Error('断流') }
      await assert.rejects(() => svc.download.download({ id: 3, name: '坏', artist: '', picUrl: '' }, { dir, br: 320, cover: false }))
      assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.part')), [], '.part 残留')
      // skipIfExists 早退：目标已在 → 不重下，但缺的歌词仍要补上（防歌词缺口永久化）
      fs.writeFileSync(path.join(dir, '丙.mp3'), Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(400, 0x55)]))
      let lyricCalls = 0
      core.lyric.get = async () => { lyricCalls++; return { lrc: '[00:01.00]词', tlyric: '' } }
      const r = await svc.download.download({ id: 4, name: '丙', artist: '', picUrl: '' }, { dir, br: 320, cover: false, skipIfExists: true, lyrics: true })
      assert.strictEqual(r.existed, true, '已存在应标记 existed')
      assert.ok(r.lrcFile && fs.existsSync(r.lrcFile), 'existed 早退也应补缺词')
      assert.strictEqual(lyricCalls, 1)
    } finally {
      core.url.resolve = origResolve
      core.download.streamTo = origStream
      core.download.fetchBuffer = origFetch
      core.lyric.get = origLyric
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  await t('queue: queued 取消跳过执行（push 返回 handle.cancel）', async () => {
    const q = svc.queue.createSerialQueue()
    const order = []
    let blockerStarted = false
    // 门闩替代"blocker 跑 60ms、等 10ms 就 cancel"的定时器竞速：事件循环一卡，
    // 10ms 等待可能整个越过 blocker → 被取消的任务先执行 → 用例偶发翻车
    const gate = makeGate()
    const blocker = q.push(() => { blockerStarted = true; order.push('blocker'); return gate.wait })
    assert.ok(blocker && typeof blocker.cancel === 'function' && blocker.signal, 'push 应返回 {id,cancel,signal}')
    const h2 = q.push(() => { order.push('cancelled-should-not-run') })
    const h3 = q.push(() => { order.push('third') })
    // 等 blocker 确认已在执行（条件成立）才取消，再放行——不赌任何时间窗
    await until(() => blockerStarted)
    h2.cancel()
    assert.strictEqual(h2.cancelled, true, 'cancel 后句柄应标记 cancelled')
    assert.deepStrictEqual(order, ['blocker'], '放行前不得有排队任务被执行')
    gate.open()
    await until(() => q.pending === 0 && !q.active)
    assert.deepStrictEqual(order, ['blocker', 'third'], `被取消的任务不应执行，实际 ${order.join(',')}`)
  })

  await t('queue: cancel(id) 按 id 取消排队任务 + FIFO 保持', async () => {
    const q = svc.queue.createSerialQueue()
    const order = []
    let firstStarted = false
    const gate = makeGate() // 同上：first 由门闩持有，取消动作不再与 50ms 定时器赛跑
    q.push(() => { firstStarted = true; order.push('first'); return gate.wait })
    const h2 = q.push(() => { order.push('second') })
    q.push(() => { order.push('third') })
    await until(() => firstStarted)
    assert.strictEqual(q.cancel(h2.id), 'queued')
    assert.strictEqual(q.cancel(999999), null, '未知 id 应返回 null')
    assert.deepStrictEqual(order, ['first'], '放行前不得有排队任务被执行')
    gate.open()
    await until(() => q.pending === 0 && !q.active)
    assert.deepStrictEqual(order, ['first', 'third'])
  })

  await t('queue: running 协作式取消（signal abort 后下一个边界停）', async () => {
    const q = svc.queue.createSerialQueue()
    let secondRan = false
    const h1 = q.push(async (signal) => {
      for (let i = 0; i < 10; i++) {
        if (signal.aborted) { const e = new Error('任务已取消'); e.name = 'AbortError'; throw e }
        await new Promise((r) => setTimeout(r, 10))
        if (i === 1) h1.cancel() // 模拟 running 取消：abort 当前任务的 signal
      }
    })
    q.push(() => { secondRan = true })
    await until(() => q.pending === 0 && !q.active)
    assert.strictEqual(secondRan, true, 'running 取消不应阻塞后续排队任务')
  })

  await t('download: downloadMany 在每首边界感知 signal（已 abort 直接抛，不起网络）', async () => {
    const c = new AbortController()
    c.abort()
    await assert.rejects(
      () => svc.download.downloadMany([{ id: 1, name: '歌' }], { dir: 'x', signal: c.signal }),
      (e) => e.name === 'AbortError' || /取消|abort/i.test(e.message),
    )
  })

  await t('tag: verifyAudioHead 写盘前内存校验（ID3/帧同步/fLaC 通过，坏头/空抛错）', () => {
    const { verifyAudioHead } = core.tag
    assert.strictEqual(verifyAudioHead(Buffer.concat([Buffer.from('ID3'), Buffer.alloc(10)])), true)
    assert.strictEqual(verifyAudioHead(Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x11])), true)
    assert.strictEqual(verifyAudioHead(Buffer.concat([Buffer.from('fLaC'), Buffer.alloc(10)])), true)
    const html = Buffer.from('<!DO')
    assert.throws(() => verifyAudioHead(html), /头校验/)
    assert.throws(() => verifyAudioHead(Buffer.alloc(0)), /为空或过短/)
    assert.throws(() => verifyAudioHead(Buffer.from([0x00, 0x01, 0x02, 0x03])), /头校验/)
    assert.throws(() => verifyAudioHead(null), /为空或过短/)
  })

  await t('recommend: fm 循环拉批/dedupe/dryRounds 语义不变（stub + noDelay）', async () => {
    const orig = core.recommend.fetchFmPage
    try {
      // 累计到 total：每批 2 首新歌，total=5 需 3 批（6 首截断为 5）
      let calls = 0
      core.recommend.fetchFmPage = async () => {
        calls++
        return [{ id: calls * 10 + 1 }, { id: calls * 10 + 2 }]
      }
      const r1 = await svc.recommend.fm({ total: 5, noDelay: true })
      assert.strictEqual(r1.songs.length, 5, `应凑够 5 首，实际 ${r1.songs.length}`)
      assert.strictEqual(r1.batches, 3, `应拉 3 批，实际 ${r1.batches}`)
      assert.strictEqual(new Set(r1.songs.map((s) => s.id)).size, 5, '去重后不应有重复 id')
      // dryRounds：首批后无新歌，连续 3 批干转后停（共 4 批）
      core.recommend.fetchFmPage = async () => [{ id: 1 }]
      const r2 = await svc.recommend.fm({ total: 30, noDelay: true })
      assert.strictEqual(r2.songs.length, 1)
      assert.strictEqual(r2.batches, 4, `1 首新 + 3 轮干转应停在 4 批，实际 ${r2.batches}`)
      // maxBatches 截断
      calls = 0
      core.recommend.fetchFmPage = async () => { calls++; return [{ id: 1000 + calls }] }
      const r3 = await svc.recommend.fm({ total: 100, maxBatches: 5, noDelay: true })
      assert.strictEqual(r3.batches, 5)
      assert.strictEqual(r3.songs.length, 5)
    } finally {
      core.recommend.fetchFmPage = orig
    }
  })

  await t('recommend: simi 广度扩展/dedupe/exhausted 语义不变（stub + noDelay）', async () => {
    const orig = core.recommend.fetchSimiPage
    try {
      const pages = {
        1: [{ id: 2 }, { id: 3 }],
        2: [{ id: 4 }],
        3: [],
        4: [],
      }
      core.recommend.fetchSimiPage = async (id) => pages[String(id)] || []
      // total 足够大：走完队列，空页 + 空队列 → exhausted
      const r1 = await svc.recommend.simi(1, { total: 10, noDelay: true })
      assert.deepStrictEqual(r1.songs.map((s) => s.id).sort((a, b) => a - b), [2, 3, 4])
      assert.strictEqual(r1.batches, 4, `应拉 4 批（种子 1→2→3→4），实际 ${r1.batches}`)
      assert.strictEqual(r1.exhausted, true, '队列耗尽且末页为空应标记 exhausted')
      // total 截断：凑够即停，不再扩展
      const r2 = await svc.recommend.simi(1, { total: 2, noDelay: true })
      assert.strictEqual(r2.songs.length, 2)
      assert.strictEqual(r2.batches, 1, `首批即凑够 2 首应只拉 1 批，实际 ${r2.batches}`)
      assert.strictEqual(r2.exhausted, false)
      // 去重：重复 id 不重复入队、不多算 batches 之外的新歌
      core.recommend.fetchSimiPage = async () => [{ id: 9 }, { id: 9 }]
      const r3 = await svc.recommend.simi(8, { total: 10, maxBatches: 10, noDelay: true })
      assert.deepStrictEqual(r3.songs.map((s) => s.id), [9])
    } finally {
      core.recommend.fetchSimiPage = orig
    }
  })

  await t('error: isTransient 瞬时/终态分级（无 body 网络错重试，noUrl/400/404/校验失败不重试）', () => {
    const { isTransient } = core.error
    assert.strictEqual(typeof isTransient, 'function')
    // 瞬时：值得重试
    assert.strictEqual(isTransient(new Error('fetch failed')), true, 'fetch 失败应重试')
    assert.strictEqual(isTransient(new Error('请求超时(3000ms)')), true, '超时应重试')
    assert.strictEqual(isTransient(new Error('下载失败: HTTP 500')), true, '5xx 应重试')
    assert.strictEqual(isTransient(new Error('下载失败: HTTP 429')), true, '429 应重试')
    assert.strictEqual(isTransient(new Error('下载截断（断流）: 期望 1000B，实际 100B')), true, '断流应重试')
    assert.strictEqual(isTransient({ status: 503, body: { code: 503, msg: 'busy' } }), true, 'NCM 5xx 应重试')
    assert.strictEqual(isTransient({ status: 200, body: { code: 500, msg: 'err' } }), true, 'NCM body 5xx 应重试')
    // 终态：重试无用
    const noUrl = new Error('无可用链接 (id=1, level=lossless)')
    noUrl.noUrl = true
    assert.strictEqual(isTransient(noUrl), false, 'noUrl 不应重试')
    assert.strictEqual(isTransient(new Error('下载失败: HTTP 404')), false, '404 不应重试')
    assert.strictEqual(isTransient(new Error('下载失败: HTTP 400')), false, '400 不应重试')
    assert.strictEqual(isTransient(new Error('文件校验失败（非 mp3 内容）: /tmp/x.part')), false, '校验失败不应重试')
    assert.strictEqual(isTransient({ status: 404, body: '接口不存在' }), false, 'NCM 404 不应重试')
    assert.strictEqual(isTransient({ status: 400, body: { code: 400, msg: 'bad' } }), false, 'NCM 400 不应重试')
  })

  await t('retry: shouldRetry 回调控制重试（默认全重试保持兼容）', async () => {
    let calls = 0
    await assert.rejects(
      () => core.retry.withRetry(() => { calls++; throw new Error('boom') }, { retries: 2, backoffMs: 1, shouldRetry: () => false }),
    )
    assert.strictEqual(calls, 1, 'shouldRetry=false 应只试 1 次')
    calls = 0
    await assert.rejects(
      () => core.retry.withRetry(() => { calls++; throw new Error('boom') }, { retries: 2, backoffMs: 1, shouldRetry: () => true }),
    )
    assert.strictEqual(calls, 3, 'shouldRetry=true 应试足 3 次')
    // 按错误分流：noUrl 终态不重试，网络错误重试
    calls = 0
    const noUrl = new Error('无可用链接')
    noUrl.noUrl = true
    await assert.rejects(
      () => core.retry.withRetry(() => { calls++; throw noUrl }, { retries: 1, backoffMs: 1, shouldRetry: (e) => core.error.isTransient(e) }),
    )
    assert.strictEqual(calls, 1, 'noUrl 经 isTransient 应只试 1 次')
    calls = 0
    await assert.rejects(
      () => core.retry.withRetry(() => { calls++; throw new Error('fetch failed') }, { retries: 1, backoffMs: 1, shouldRetry: (e) => core.error.isTransient(e) }),
    )
    assert.strictEqual(calls, 2, '瞬时错误经 isTransient 应重试')
    // 404 经 isTransient 不重试
    calls = 0
    await assert.rejects(
      () => core.retry.withRetry(() => { calls++; throw new Error('下载失败: HTTP 404') }, { retries: 1, backoffMs: 1, shouldRetry: (e) => core.error.isTransient(e) }),
    )
    assert.strictEqual(calls, 1, '404 经 isTransient 不应重试')
  })

  await t('download: 截断抛错（total/期望双口径，message 含期望/实际，近似值宽松）', async () => {
    const fs = require('fs')
    const path = require('path')
    const os = require('os')
    const dir = tmpDir('trunc-')
    const origResolve = core.url.resolve
    const origStream = core.download.streamTo
    try {
      core.url.resolve = async (id) => ({ id: Number(id), url: 'http://x/a.mp3', br: 320, size: 10000, level: 'exhigh', type: 'mp3', ext: 'mp3' })
      // 口径1：total>0 且 received!=total → 截断（stub 只写 100B 却声明 1000B）
      core.download.streamTo = async (url, filepath) => {
        fs.writeFileSync(filepath, Buffer.alloc(100))
        return { size: 100, total: 1000 }
      }
      await assert.rejects(
        () => svc.download.download({ id: 11, name: '截断歌', artist: 'a', picUrl: '' }, { dir, br: 320, cover: false }),
        /期望.*实际|截断/,
        'total 与 received 不一致应抛截断错',
      )
      assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.part')), [], '.part 应被清理')
      // 口径2：total 自洽但与 resolved.size 差距过大（404B vs 期望 10000B）→ 大小异常
      core.download.streamTo = async (url, filepath) => {
        fs.writeFileSync(filepath, Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(400, 0x55)]))
        return { size: 404, total: 404 }
      }
      await assert.rejects(
        () => svc.download.download({ id: 12, name: '大小异常歌', artist: 'a', picUrl: '' }, { dir, br: 320, cover: false }),
        /期望.*实际/,
        '与 resolved.size 差距过大应抛错且注明期望/实际',
      )
      // 宽松：近似值小差距放行（期望 410B vs 实际 404B，差 6B <1KB）
      core.url.resolve = async (id) => ({ id: Number(id), url: 'http://x/a.mp3', br: 320, size: 410, level: 'exhigh', type: 'mp3', ext: 'mp3' })
      const r = await svc.download.download({ id: 13, name: '近似歌', artist: 'a', picUrl: '' }, { dir, br: 320, cover: false })
      assert.ok(r.filepath && fs.existsSync(r.filepath), '近似值小差距应放行落盘')
    } finally {
      core.url.resolve = origResolve
      core.download.streamTo = origStream
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  await t('download: resolve 阶段 noUrl 直接不重试（不重跑阶梯）', async () => {
    const fs = require('fs')
    const path = require('path')
    const os = require('os')
    const dir = tmpDir('nourl-')
    const origResolve = core.url.resolve
    try {
      const calls = []
      core.url.resolve = async (id, { level }) => {
        calls.push(level)
        const e = new Error(`无可用链接 (id=${id}, level=${level})`)
        e.noUrl = true
        throw e
      }
      // exhigh 档阶梯只有 1 档：外层 withRetry 若重试会调 2 次，正确应只调 1 次
      await assert.rejects(
        () => svc.download.download({ id: 999, name: '无源歌', artist: 'a', picUrl: '' }, { dir, br: 320, cover: false }),
        /无可用链接/,
      )
      assert.strictEqual(calls.length, 1, `noUrl 不应重试，实际调用 ${calls.length} 次: ${calls.join(',')}`)
      // lossless 档阶梯 2 档各 1 次：正确共 2 次，若外层重试会翻倍成 4 次
      calls.length = 0
      await assert.rejects(
        () => svc.download.download({ id: 999, name: '无源歌', artist: 'a', picUrl: '' }, { dir, br: 2000, cover: false }),
        /无可用链接/,
      )
      assert.strictEqual(calls.length, 2, `lossless 阶梯 2 次后应停，实际 ${calls.length} 次: ${calls.join(',')}`)
    } finally {
      core.url.resolve = origResolve
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  await t('download: assignBaseNames 认领后同名组仍全组加后缀 + taken不污染 + 无artist不空名', () => {
    const { assignBaseNames } = svc.download
    // 同名同歌手：磁盘已有"歌名 - 歌手"及序号时，第一首认领，第二首应跳序号拿 (3) 而非退回纯歌名
    const s1 = { id: 1, name: '晴天', artist: '周杰伦' }
    const s2 = { id: 2, name: '晴天', artist: '周杰伦' }
    const m1 = assignBaseNames([s1, s2], new Set(['晴天 - 周杰伦', '晴天 - 周杰伦 (2)']))
    assert.strictEqual(m1.get(s1), '晴天 - 周杰伦')
    assert.strictEqual(m1.get(s2), '晴天 - 周杰伦 (3)', '序号必须跳过已占用的 (2)')
    // 同名不同歌手：第一首认领磁盘旧名后，第二首仍须带自己歌手后缀，不得退回纯歌名
    const a1 = { id: 3, name: '晴天', artist: 'A' }
    const a2 = { id: 4, name: '晴天', artist: 'B' }
    const m2 = assignBaseNames([a1, a2], new Set(['晴天 - A']))
    assert.strictEqual(m2.get(a1), '晴天 - A')
    assert.strictEqual(m2.get(a2), '晴天 - B')
    // 传入的 taken 不得被污染（跨批复用同一 Set 时序号必须稳定）
    const taken = new Set(['x'])
    assignBaseNames([{ id: 5, name: 'y', artist: 'A' }, { id: 6, name: 'y', artist: 'A' }], taken)
    assert.deepStrictEqual([...taken], ['x'], 'assign 不得写回调用方的 Set')
    // 无 artist 同名组：fallback 不产空名（纯名 + 序号）
    const n1 = { id: 7, name: '晴天' }
    const n2 = { id: 8, name: '晴天' }
    const m3 = assignBaseNames([n1, n2])
    assert.ok(m3.get(n1) && m3.get(n2), '无 artist 不得产空名')
    assert.deepStrictEqual([m3.get(n1), m3.get(n2)], ['晴天', '晴天 (2)'])
  })

  await t('storage: scanDir 大小写混排 + 空基础名忽略 + symlink不索引', () => {
    const fs = require('fs')
    const path = require('path')
    const os = require('os')
    const dir = tmpDir('scan-case-')
    try {
      for (const f of ['a.MP3', 'a.FLAC', 'b.Flac', 'c.LRC', 'd.lRc', '.mp3']) fs.writeFileSync(path.join(dir, f), 'x')
      const idx = svc.storage.scanDir(dir)
      assert.deepStrictEqual([...idx.audio.get('a')].sort(), ['flac', 'mp3'], '大小写扩展名应归一并共存')
      assert.deepStrictEqual([...idx.audio.get('b')], ['flac'])
      assert.deepStrictEqual([...idx.lrc].sort(), ['c', 'd'], 'LRC 大小写应识别')
      assert.ok(!idx.audio.has(''), '空基础名（.mp3）不得索引')
      // symlink 文件不跟随、不索引（只用 os.tmpdir，不碰 downloads/）
      try {
        fs.symlinkSync(path.join(dir, 'a.MP3'), path.join(dir, 'link.mp3'))
        const idx2 = svc.storage.scanDir(dir)
        assert.ok(!idx2.audio.has('link'), 'symlink 不得被索引')
      } catch { /* Windows 无权限时跳过该断言 */ }
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  await t('incremental: plan lyrics:false + qualityExt 同传时口径仍闭合', () => {
    const index = { audio: new Map([['a', new Set(['mp3'])], ['b', new Set(['mp3'])]]), lrc: new Set(['a']) }
    const songs = [{ id: 1, name: 'a' }, { id: 2, name: 'b' }, { id: 3, name: 'c' }]
    const p = svc.incremental.plan(songs, index, { lyrics: false, qualityExt: 'flac' })
    assert.deepStrictEqual(p.fill, [], '关补词后 fill 清空')
    assert.strictEqual(p.download.length + p.fill.length + p.skipped.length, songs.length, '每首恰好归一类')
    // 本例三首全缺 flac → 全走补下，skipped 为空但仍闭合
    assert.deepStrictEqual(p.download.map((s) => s.id), [1, 2, 3])
    // 已有目标音质 + 缺词 + 关补词 → 并入 skipped（与单开关语义一致）
    const idx2 = { audio: new Map([['a', new Set(['mp3', 'flac'])]]), lrc: new Set() }
    const q = svc.incremental.plan([{ id: 9, name: 'a' }], idx2, { lyrics: false, qualityExt: 'flac' })
    assert.deepStrictEqual(q.fill, [])
    assert.deepStrictEqual(q.skipped.map((s) => s.id), [9])
  })

  await t('incremental: run 空计划零调用（download/fill 双空不调 downloadMany）', async () => {
    let calls = 0
    const fake = async () => { calls++; return [] }
    const r = await svc.incremental.run(
      { download: [], fill: [], skipped: [], bases: new Map(), lyricsFor: new Set() },
      { dir: 'd', downloadMany: fake }, {},
    )
    assert.deepStrictEqual(r, { results: [], fillResults: [] })
    assert.strictEqual(calls, 0, '空计划不得调用 downloadMany')
  })

  await t('storage: writeBatchReport 老数据兼容（existed/failed 缺失不崩）', () => {
    const fs = require('fs')
    const path = require('path')
    const os = require('os')
    const dir = tmpDir('rep-old-')
    try {
      // existed 缺失：视为 0，不占篇幅但报告照写
      assert.ok(svc.storage.writeBatchReport(dir, {
        label: '旧数据', br: 320, summary: { total: 1, ok: 1, filled: 0, skipped: 0, failed: [] },
      }))
      let txt = fs.readFileSync(path.join(dir, svc.storage.REPORT_NAME), 'utf8')
      assert.ok(!txt.includes('同音质已存在'), 'existed 缺失/0 时不占篇幅')
      // failed 缺失：视为空数组，报告照写而非返回 false
      assert.ok(svc.storage.writeBatchReport(dir, {
        label: '旧数据', br: 320, summary: { total: 1, ok: 1, filled: 0, skipped: 0 },
      }))
      txt = fs.readFileSync(path.join(dir, svc.storage.REPORT_NAME), 'utf8')
      assert.ok(txt.includes('失败 0'))
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  await t('storage: sweep 跳过 symlink/junction（lstat 兜底，不越界删）', () => {
    const fs = require('fs')
    const path = require('path')
    const os = require('os')
    const base = tmpDir('sweep-link-')
    const outside = tmpDir('sweep-out-')
    try {
      fs.writeFileSync(path.join(outside, 'evil.part'), 'x')
      fs.writeFileSync(path.join(base, 'top.part'), 'x')
      let linked = false
      try {
        fs.symlinkSync(outside, path.join(base, 'linkdir'), 'junction')
        linked = true
      } catch { /* 无权限时只验顶层删除 */ }
      const removed = svc.storage.sweepDownloads(base)
      assert.strictEqual(removed, 1, `只删顶层 part，实际 ${removed}`)
      assert.ok(fs.existsSync(path.join(outside, 'evil.part')), '联接外文件不得越界删除')
      if (linked) assert.ok(fs.existsSync(path.join(base, 'linkdir')), '联接本身保留')
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  await t('download: coverCache LRU（超40淘汰最旧，尾部仍去重）', async () => {
    const fs = require('fs')
    const path = require('path')
    const os = require('os')
    const dir = tmpDir('lru-')
    const origResolve = core.url.resolve
    const origStream = core.download.streamTo
    const origFetch = core.download.fetchBuffer
    const calls = new Map()
    core.url.resolve = async (id) => ({ id: Number(id), url: 'http://x/a.mp3', br: 320, size: 404, level: 'exhigh', type: 'mp3', ext: 'mp3' })
    core.download.streamTo = async (url, filepath) => {
      fs.writeFileSync(filepath, Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(400, 0x55)]))
      return { size: 404, total: 404 }
    }
    core.download.fetchBuffer = async (url) => {
      calls.set(url, (calls.get(url) || 0) + 1)
      return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(50)])
    }
    try {
      // 41 张不同封面 + 第 42 首复用第 1 张：LRU(40) 下第 1 张早被挤掉，应拉第 2 次（共 42 次）；
      // 旧逻辑（前 40 常驻、后来永不缓存）下第 1 张仍在缓存，只拉 41 次
      const songs = Array.from({ length: 41 }, (_, i) => ({ id: 100 + i, name: '歌' + (100 + i), artist: 'a', picUrl: 'http://pic/' + (100 + i) }))
      songs.push({ id: 999, name: '复用首张', artist: 'a', picUrl: 'http://pic/100' })
      const rs = await svc.download.downloadMany(songs, { dir, br: 320, cover: true })
      assert.ok(rs.every((r) => r.ok), '批量应全成功: ' + JSON.stringify(rs.map((r) => r.error)))
      assert.strictEqual(calls.size, 41, `去重后应有 41 个不同封面 URL，实际 ${calls.size}`)
      const total = [...calls.values()].reduce((a, b) => a + b, 0)
      assert.strictEqual(total, 42, `首张被淘汰后复用应重拉，总拉取 42 次，实际 ${total}`)
    } finally {
      core.url.resolve = origResolve
      core.download.streamTo = origStream
      core.download.fetchBuffer = origFetch
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  await t('download: 同坏封面只拉一次（失败也批次级缓存，防大批次每首重试）', async () => {
    const fs = require('fs')
    const path = require('path')
    const os = require('os')
    const dir = tmpDir('badcover-')
    const origResolve = core.url.resolve
    const origStream = core.download.streamTo
    const origFetch = core.download.fetchBuffer
    let fetches = 0
    core.url.resolve = async (id) => ({ id: Number(id), url: 'http://x/a.mp3', br: 320, size: 404, level: 'exhigh', type: 'mp3', ext: 'mp3' })
    core.download.streamTo = async (url, filepath) => {
      fs.writeFileSync(filepath, Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(400, 0x55)]))
      return { size: 404, total: 404 }
    }
    // 魔数不对的非图片：fetchCover 应抛错，但批次内同 picUrl 只拉一次（旧逻辑删缓存会拉 3 次）
    core.download.fetchBuffer = async () => { fetches++; return Buffer.from('not an image') }
    try {
      const songs = [
        { id: 1, name: '甲', artist: 'a', picUrl: 'http://pic/bad' },
        { id: 2, name: '乙', artist: 'b', picUrl: 'http://pic/bad' },
        { id: 3, name: '丙', artist: 'c', picUrl: 'http://pic/bad' },
      ]
      const rs = await svc.download.downloadMany(songs, { dir, br: 320, cover: true })
      assert.ok(rs.every((r) => r.ok), '坏封面不得影响音频: ' + JSON.stringify(rs.map((r) => r.error)))
      assert.strictEqual(fetches, 1, `同坏封面应只拉 1 次，实际 ${fetches}`)
    } finally {
      core.url.resolve = origResolve
      core.download.streamTo = origStream
      core.download.fetchBuffer = origFetch
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  await t('download: 纯ID批量只扫一次盘（sharedTaken复用，命名仍按真实歌名）', async () => {
    const fs = require('fs')
    const path = require('path')
    const os = require('os')
    const dir = tmpDir('pureids-')
    const origGetOne = core.song.getOne
    const origResolve = core.url.resolve
    const origStream = core.download.streamTo
    const origScan = svc.storage.scanDir
    let scans = 0
    svc.storage.scanDir = (...a) => { scans++; return origScan(...a) }
    core.song.getOne = async (id) => ({ id: Number(id), name: '纯ID歌' + id, artist: '歌手' + id, album: '', duration: 0 })
    core.url.resolve = async (id) => ({ id: Number(id), url: 'http://x/a.mp3', br: 320, size: 404, level: 'exhigh', type: 'mp3', ext: 'mp3' })
    core.download.streamTo = async (url, filepath) => {
      fs.writeFileSync(filepath, Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(400, 0x55)]))
      return { size: 404, total: 404 }
    }
    try {
      const rs = await svc.download.downloadMany([101, 102, 103], { dir, br: 320, cover: false })
      assert.strictEqual(rs.length, 3)
      assert.ok(rs.every((r) => r.ok), '纯 ID 批量应全成功: ' + JSON.stringify(rs.map((r) => r.error)))
      assert.strictEqual(scans, 1, `3 个纯 ID 应只扫 1 次盘，实际 ${scans} 次`)
      // 命名必须按解析后的真实歌名，而非占位 String(id)
      for (const id of [101, 102, 103]) {
        assert.ok(fs.existsSync(path.join(dir, `纯ID歌${id}.mp3`)), `应按真实歌名落盘，缺 纯ID歌${id}.mp3`)
      }
    } finally {
      core.song.getOne = origGetOne
      core.url.resolve = origResolve
      core.download.streamTo = origStream
      svc.storage.scanDir = origScan
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  await t('download: 批量已分配 base 不再逐首扫盘（base|| 短路，修每首一次 readdir）', async () => {
    const fs = require('fs')
    const path = require('path')
    const os = require('os')
    const dir = tmpDir('noscans-')
    const origResolve = core.url.resolve
    const origStream = core.download.streamTo
    const origScan = svc.storage.scanDir
    let scans = 0
    svc.storage.scanDir = (...a) => { scans++; return origScan(...a) }
    core.url.resolve = async (id) => ({ id: Number(id), url: 'http://x/a.mp3', br: 320, size: 404, level: 'exhigh', type: 'mp3', ext: 'mp3' })
    core.download.streamTo = async (url, filepath) => {
      fs.writeFileSync(filepath, Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(400, 0x55)]))
      return { size: 404, total: 404 }
    }
    try {
      // 对象批量路径：base 已由批次预分配，download() 内根本用不到 taken ——
      // 若把 takenBases(dir) 先算成变量再判空，短路失效，每首都会白扫一次全目录
      const songs = [
        { id: 1, name: '甲', artist: 'a', picUrl: '' },
        { id: 2, name: '乙', artist: 'b', picUrl: '' },
        { id: 3, name: '丙', artist: 'c', picUrl: '' },
      ]
      const rs = await svc.download.downloadMany(songs, { dir, br: 320, cover: false })
      assert.ok(rs.every((r) => r.ok), '批量应全成功: ' + JSON.stringify(rs.map((r) => r.error)))
      assert.strictEqual(scans, 1, `base 已预分配时只应由 downloadMany 扫 1 次盘，实际 ${scans} 次`)
      assert.ok(fs.existsSync(path.join(dir, '甲.mp3')), '应按分配名落盘')
    } finally {
      core.url.resolve = origResolve
      core.download.streamTo = origStream
      svc.storage.scanDir = origScan
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  await t('download: onFile/onProgress抛错不中断整批', async () => {
    const fs = require('fs')
    const path = require('path')
    const os = require('os')
    const dir = tmpDir('cb-')
    const origResolve = core.url.resolve
    const origStream = core.download.streamTo
    const origFetch = core.download.fetchBuffer
    core.url.resolve = async (id) => ({ id: Number(id), url: 'http://x/a.mp3', br: 320, size: 404, level: 'exhigh', type: 'mp3', ext: 'mp3' })
    core.download.streamTo = async (url, filepath, { onProgress } = {}) => {
      if (onProgress) onProgress({ received: 1, total: 2, percent: 50 })
      fs.writeFileSync(filepath, Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(400, 0x55)]))
      return { size: 404, total: 404 }
    }
    core.download.fetchBuffer = async () => Buffer.concat([Buffer.from([0x89, 0x50]), Buffer.alloc(50)])
    try {
      const songs = [
        { id: 1, name: '甲', artist: 'a', picUrl: '' },
        { id: 2, name: '乙', artist: 'b', picUrl: '' },
        { id: 3, name: '丙', artist: 'c', picUrl: '' },
      ]
      let fileCalls = 0
      const rs = await svc.download.downloadMany(songs, {
        dir, br: 320, cover: false,
        onProgress: () => { throw new Error('progress boom') },
        onFile: () => { fileCalls++; throw new Error('file boom') },
      })
      assert.strictEqual(rs.length, 3, '回调抛错也不得丢结果')
      assert.ok(rs.every((r) => r.ok), '回调抛错不得记为下载失败: ' + JSON.stringify(rs))
      assert.strictEqual(fileCalls, 3, '每首都应调 onFile（抛错也被吞后继续下一首）')
      // 失败路径的 onFile 抛错同样不得中断整批
      core.url.resolve = async (id) => {
        if (Number(id) === 2) { const e = new Error('无可用链接 (id=2)'); e.noUrl = true; throw e }
        return { id: Number(id), url: 'http://x/a.mp3', br: 320, size: 404, level: 'exhigh', type: 'mp3', ext: 'mp3' }
      }
      const rs2 = await svc.download.downloadMany(songs, {
        dir, br: 320, cover: false,
        onFile: () => { throw new Error('fail-path boom') },
      })
      assert.strictEqual(rs2.length, 3)
      assert.deepStrictEqual(rs2.map((r) => r.ok), [true, false, true], '中间失败不影响其余')
    } finally {
      core.url.resolve = origResolve
      core.download.streamTo = origStream
      core.download.fetchBuffer = origFetch
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  await t('server: _test 404映射（找不到类归404，其余500）', () => {
    const serverMod = require('../server')
    const { isNotFoundErr, httpStatus } = serverMod._test
    assert.strictEqual(httpStatus({ status: 404, body: '接口不存在' }), 404)
    assert.strictEqual(httpStatus({ body: { code: 404, msg: '无' } }), 404)
    assert.strictEqual(httpStatus(new Error('找不到榜单: xxx')), 404)
    assert.strictEqual(httpStatus(new Error('任务不存在')), 404)
    assert.strictEqual(httpStatus(new Error('fetch failed')), 500)
    assert.strictEqual(httpStatus({ status: 500, body: { code: 500 } }), 500)
    // 权威状态码优先：明确 500 的故障不得因为 body 文案里出现"不存在"就降级成 404（多轮叠加时的误判）
    assert.strictEqual(httpStatus({ status: 500, body: { code: 500, msg: '服务暂不可用，榜单不存在' } }), 500,
      '明确 500 不得因文案含"不存在"误判 404')
    assert.strictEqual(httpStatus({ status: 502, body: { code: 502, msg: '接口不存在' } }), 500,
      'NCM 传输失败(502) 不得因文案误判 404')
    // 业务码 404 仍是 404（状态码缺失也不受影响）
    assert.strictEqual(httpStatus({ body: { code: 404, msg: '歌单不存在' } }), 404)
    // NCM 业务码 301 = 未登录：与"没取到歌"同类归 404（客户端可自愈——重新扫码），不再落 500
    assert.strictEqual(httpStatus({ body: { code: 301, msg: '需要登录' } }), 404)
    // 底层显式打的 notFound 旗标优先于一切嗅探（改文案不得让 404 静默变 500）
    assert.strictEqual(httpStatus({ status: 500, notFound: true }), 404)
    // 无状态码的普通 Error 继续按文案归类
    assert.strictEqual(httpStatus(new Error('歌单不存在')), 404)
    assert.strictEqual(isNotFoundErr(null), false)
  })

  await t('server: _test 参数校验 helper（missingId/badCount）', () => {
    const { missingId, badCount } = require('../server')._test
    assert.strictEqual(missingId(undefined), true)
    assert.strictEqual(missingId(''), true)
    assert.strictEqual(missingId('   '), true)
    assert.strictEqual(missingId('123'), false)
    assert.strictEqual(missingId(0), false) // 数字 0 是合法 id 字串"0"，不判空
    assert.strictEqual(badCount(undefined), false, '没传不算错，由缺省值接管')
    assert.strictEqual(badCount(''), false)
    assert.strictEqual(badCount('20'), false)
    assert.strictEqual(badCount('0'), true)
    assert.strictEqual(badCount('-5'), true)
    assert.strictEqual(badCount('abc'), true)
    assert.strictEqual(badCount('NaN'), true)
  })

  await t('server: _test flagOn 口径（缺省关：仅显式 true/1 打开）', () => {
    const { flagOn } = require('../server')._test
    // 关：未传 / 空 / false / 0 / 任意其他值 —— 与 README、HANDOFF 的"缺省关"文案一致
    for (const off of [undefined, null, '', 'false', 'FALSE', '0', false, 0, 'no', 'undefined', []]) {
      assert.strictEqual(flagOn(off), false, `${JSON.stringify(off)} 应判为关`)
    }
    // 开：只有显式 true/1（含 JSON 布尔 true——网页 checkbox 就是 `fillQuality: $('optRefill').checked` 这样传的）
    for (const on of [true, 1, 'true', 'TRUE', '1']) {
      assert.strictEqual(flagOn(on), true, `${JSON.stringify(on)} 应判为开`)
    }
    // 回归锚点：旧写法 `!/^(false|0)$/.test(String(v || ''))` 会把 undefined 判成开（实为缺省开），
    // 与 server.js 注释和 README/HANDOFF 的"缺省关"相反 —— 缺省必须是关
    assert.strictEqual(flagOn(undefined), false, '缺省必须是关，不得退回缺省开')
  })

  await t('server: _test 任务出参净化（摘handle/终端瘦身含cancelled）', () => {
    const { toPublicJob, slimJob } = require('../server')._test
    const fake = {
      id: '1', label: 'x', folder: 'f', status: 'done', log: Array.from({ length: 150 }, (_, i) => `行${i}`),
      result: { total: 1, ok: 1, filled: 0, skipped: 0, failed: [], files: ['a.mp3'], skippedNames: ['s'] },
      total: 1, startedAt: Date.now(), handle: { cancel() {}, signal: {} },
    }
    const pub = toPublicJob(fake)
    assert.ok(!('handle' in pub), 'handle 不得透出')
    assert.strictEqual(pub.label, 'x')
    const slim = slimJob(fake)
    assert.ok(!('handle' in slim), '瘦身后也不得透出 handle')
    assert.strictEqual(slim.log.length, 100, '终端日志截到 100')
    assert.strictEqual(slim.logTotal, 150)
    assert.ok(!('files' in slim.result) || slim.result.files === undefined, 'files 应剥离')
    assert.ok(!('skippedNames' in slim.result) || slim.result.skippedNames === undefined, 'skippedNames 应剥离')
    // cancelled 同为终端态，同样瘦身（结论行"已取消"在末尾，不得丢）
    const c = slimJob({ ...fake, status: 'cancelled', log: ['a', '已取消'], result: null })
    assert.deepStrictEqual(c.log, ['a', '已取消'])
    assert.strictEqual(c.logTotal, 2)
    // running/queued 保持全量但同样摘 handle
    const r = slimJob({ ...fake, status: 'running', log: ['a', 'b'] })
    assert.deepStrictEqual(r.log, ['a', 'b'])
    assert.ok(!('handle' in r))
    assert.ok(!('logTotal' in r), '运行态保持原形状，不额外加 logTotal')
  })

  await t('server: HTTP 门面校验（/meting 缺id/未知source 口径，纯本地桩，无外部请求）', async () => {
    const serverMod = require('../server')
    const srv = serverMod.app.listen(0)
    await new Promise((r) => srv.on('listening', r))
    const port = srv.address().port
    const base = `http://127.0.0.1:${port}`
    try {
      // /meting 五种 type 缺 id 一律 400（此前会进底层抛 500）
      for (const type of ['playlist', 'song', 'lrc', 'pic', 'url']) {
        const resp = await fetch(`${base}/meting?type=${type}`)
        assert.strictEqual(resp.status, 400, `${type} 缺 id 应 400，实际 ${resp.status}`)
      }
      // /recommend 未知来源与建任务入口同口径归 400（此前 404）
      const bad = await fetch(`${base}/recommend/nope`)
      assert.strictEqual(bad.status, 400, `未知推荐源应 400，实际 ${bad.status}`)
      // /recommend 各源必填与数量缺口
      assert.strictEqual((await fetch(`${base}/recommend/simi`)).status, 400, 'simi 缺 id 应 400')
      assert.strictEqual((await fetch(`${base}/recommend/heart?pid=1`)).status, 400, 'heart 缺 id 应 400')
      assert.strictEqual((await fetch(`${base}/recommend/fm?total=abc`)).status, 400, 'fm 非法 total 应 400')
      assert.strictEqual((await fetch(`${base}/recommend/simi?id=1&total=0`)).status, 400, 'simi total=0 应 400')
      // /api/download 建任务入口必填缺口（均在落盘前 400，不碰 downloads/）
      const post = (body) => fetch(`${base}/api/download`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      assert.strictEqual((await post({ source: 'playlist' })).status, 400, 'playlist 缺 id 应 400')
      assert.strictEqual((await post({ source: 'song' })).status, 400, 'song 缺 id 应 400')
      assert.strictEqual((await post({ source: 'simi', total: 5 })).status, 400, 'simi 缺 id 应 400')
      assert.strictEqual((await post({ source: 'songs', ids: [] })).status, 400, 'songs 空列表应 400')
      assert.strictEqual((await post({ source: 'songs', ids: ['abc', '  '] })).status, 400, 'songs 全非法 id 应 400')
      assert.strictEqual((await post({ source: 'simi', id: '1', total: 'abc' })).status, 400, 'simi 非法 total 应 400')
      // CORS 预检头：POST JSON 依赖 Allow-Headers，否则浏览器拦掉（此前缺失）
      const opt = await fetch(`${base}/api/download`, { method: 'OPTIONS' })
      assert.strictEqual(opt.status, 204)
      const allowH = opt.headers.get('access-control-allow-headers') || ''
      assert.ok(/content-type/i.test(allowH), `缺 Allow-Headers，实际 ${allowH}`)
    } finally {
      await new Promise((r) => srv.close(r))
    }
  })

  await t('server: /meting 异常映射与 pic 容错（stub svc，无外部请求）', async () => {
    const serverMod = require('../server')
    // 桩只换 svc 门面引用的底层函数，测完原样恢复
    const origGetOne = svc.core.song.getOne
    const origGetDetail = svc.core.song.getDetail
    // 预期 404 会走 server.js /meting catch 的 console.error(type,id,msg)，
    // 属服务端正常错误日志（下游 404 透传），非真实网易请求；单测内静音避免 stderr 红色误导，finally 恢复
    const origErr = console.error
    console.error = () => {}
    const srv = serverMod.app.listen(0)
    await new Promise((r) => srv.on('listening', r))
    const port = srv.address().port
    const base = `http://127.0.0.1:${port}`
    try {
      // 下游 404（如歌曲不存在）应透成 404 而非 500（纯 stub 抛错，不打 song_detail 外网）
      svc.core.song.getDetail = async () => { const e = new Error('接口不存在'); e.status = 404; throw e }
      const nf = await fetch(`${base}/meting?type=song&id=999999999999`)
      assert.strictEqual(nf.status, 404, `下游404应映射404，实际 ${nf.status}`)
      svc.core.song.getDetail = origGetDetail
      // pic 无封面中文案（此前英文 no pic）
      svc.core.song.getOne = async () => ({ id: 1, picUrl: '' })
      const noPic = await fetch(`${base}/meting?type=pic&id=1`)
      assert.strictEqual(noPic.status, 404)
      assert.strictEqual(await noPic.text(), '暂无封面')
      // pic 非法尺寸回退 300（此前拼出 NaNyNaN 坏跳转）
      svc.core.song.getOne = async () => ({ id: 1, picUrl: 'http://ex.com/p.jpg' })
      const badSize = await fetch(`${base}/meting?type=pic&id=1&cover=abc`, { redirect: 'manual' })
      assert.strictEqual(badSize.status, 302)
      assert.ok((badSize.headers.get('location') || '').includes('param=300y300'), '非法尺寸应回退 300: ' + badSize.headers.get('location'))
    } finally {
      svc.core.song.getOne = origGetOne
      svc.core.song.getDetail = origGetDetail
      console.error = origErr
      await new Promise((r) => srv.close(r))
    }
  })

  await t('server: /api/jobs 句柄剥离与 cancelled 瘦身（注假任务，不碰磁盘）', async () => {
    const serverMod = require('../server')
    const { jobs } = serverMod._internals
    // jobs 是进程级共享 Map，而 /api/jobs 按 startedAt 倒序只回前 20 条：若残留着其它用例注入的任务，
    // 本用例的两条可能被顶出截断窗口，断言随残留状态漂移。最稳方案是先存盘清场——
    // 本用例只面对自己注入的两条（截断边界恒定），finally 再原样恢复，不破坏共享状态
    const savedJobs = [...jobs.entries()]
    jobs.clear()
    const mk = (id, status) => ({
      id, label: `假${id}`, folder: `假${id}`, batchKey: '', status, cancelled: status === 'cancelled',
      log: status === 'done' ? Array.from({ length: 150 }, (_, i) => `行${i}`) : ['已取消'],
      result: status === 'done'
        ? { total: 1, ok: 1, existed: 0, skipped: 0, filled: 0, failed: [], files: ['a.mp3'], skippedNames: ['s'] }
        : null,
      error: null, total: 1, startedAt: Date.now() - Number(id), handle: { cancel() {}, signal: {} },
    })
    jobs.set('991', mk('991', 'done'))
    jobs.set('992', mk('992', 'cancelled'))
    const srv = serverMod.app.listen(0)
    await new Promise((r) => srv.on('listening', r))
    const base = `http://127.0.0.1:${srv.address().port}`
    try {
      const one = await (await fetch(`${base}/api/job/991`)).json()
      assert.ok(!('handle' in one), '详情不得透出 handle')
      const list = await (await fetch(`${base}/api/jobs`)).json()
      // 清场后列表应恰好只有本用例注入的两条：这条断言同时证明截断边界（slice(0,20)）不会波及它们
      assert.strictEqual(list.length, 2, `清场后列表应恰为本用例注入的两条，实际 ${list.length}`)
      const d = list.find((j) => j.id === '991')
      const c = list.find((j) => j.id === '992')
      assert.ok(d && !('handle' in d), '列表不得透出 handle')
      assert.strictEqual(d.log.length, 100, 'done 应瘦身到 100')
      assert.strictEqual(d.logTotal, 150)
      assert.ok(d.result && (d.result.files === undefined) && (d.result.skippedNames === undefined), 'files/明细应剥离')
      assert.ok(c, 'cancelled 应出现在列表（同为终端态瘦身，不断流）')
      assert.ok(!('handle' in c))
      assert.ok(c.log.includes('已取消'), 'cancelled 结论行不得被截掉')
    } finally {
      // 清场后原样恢复共享 Map（含本用例两条的删除），不给后续用例留状态
      jobs.clear()
      for (const [k, v] of savedJobs) jobs.set(k, v)
      await new Promise((r) => srv.close(r))
    }
  })

  await t('server: /api/status 探测分级（502/断网未知、301过期，stub cookie/raw）', async () => {
    const serverMod = require('../server')
    const origHas = svc.core.cookie.has
    const origGet = svc.core.cookie.get
    const origRaw = svc.core.raw
    const srv = serverMod.app.listen(0)
    await new Promise((r) => srv.on('listening', r))
    const base = `http://127.0.0.1:${srv.address().port}`
    // 缓存口径：cookieProbe 是 server.js 的模块级状态（let cookieProbe），_test 没有暴露重置入口，
    // 用例也不去改 server.js 加口子——所以这里每一步都换一个互不相干的 cookie 值：值一变缓存立即失效、
    // 本轮就重探，步骤之间不会互相"继承"上一步的结论（这正是本用例不依赖执行顺序/残留状态的关键）
    const as = (cookieVal, rawFn) => {
      svc.core.cookie.has = () => cookieVal != null
      svc.core.cookie.get = () => cookieVal || ''
      svc.core.raw = rawFn
    }
    let probes = 0
    try {
      as(null, async () => { throw new Error('不应被调用') })
      assert.strictEqual((await (await fetch(`${base}/api/status`)).json()).cookie, 'missing')
      as('MUSIC_U=st502', async () => { probes++; const e = new Error('t'); e.body = { code: 502 }; throw e })
      assert.strictEqual((await (await fetch(`${base}/api/status`)).json()).cookie, 'unknown', '502 传输失败应未知而非过期')
      // 缓存确实生效的反向证明：同一 cookie 立刻再请求一次不得重跑探测——
      // 换句话说，不换 cookie 值的话后面的步骤会全部沿用这一步的结论，所以每步必须换值
      assert.strictEqual((await (await fetch(`${base}/api/status`)).json()).cookie, 'unknown', '同 cookie 应沿用缓存结论')
      assert.strictEqual(probes, 1, `同一 cookie 在 5 分钟缓存内只应探测 1 次，实际 ${probes}`)
      as('MUSIC_U=st500', async () => { const e = new Error('t'); e.body = { code: 500 }; throw e })
      assert.strictEqual((await (await fetch(`${base}/api/status`)).json()).cookie, 'unknown', '500 同属传输/服务端错，应未知（此前误标过期）')
      as('MUSIC_U=stnet', async () => { throw new Error('fetch failed') })
      assert.strictEqual((await (await fetch(`${base}/api/status`)).json()).cookie, 'unknown', '无 body 断网应未知（此前首轮会谎称 valid）')
      as('MUSIC_U=st301', async () => { const e = new Error('t'); e.body = { code: 301 }; throw e })
      assert.strictEqual((await (await fetch(`${base}/api/status`)).json()).cookie, 'expired', '301 服务端真实答复应过期')
    } finally {
      svc.core.cookie.has = origHas
      svc.core.cookie.get = origGet
      svc.core.raw = origRaw
      await new Promise((r) => srv.close(r))
    }
  })

  await t('server: open-folder 按目标节流（Map 结构，不弹 explorer 的预置节流断言）', async () => {
    const serverMod = require('../server')
    const { lastOpenByDir } = serverMod._internals
    // 节流键必须是按目标的 Map（此前全局单时间戳会吞掉不同目录的正常点击）
    assert.ok(lastOpenByDir instanceof Map, '应为 Map<target, 时刻> 的按目标节流')
    // 双保险，杜绝真弹窗：DOWNLOAD_DIR 已在文件头指向 os.tmpdir（server.js 加载时读取），
    // 且 child_process.execFile 在 server.js 加载前就被换成了记录桩 —— 即便节流逻辑失灵，
    // explorer 也不会被真的拉起，还能反过来断言"确实没调/确实调了几次"
    const root = TEST_DOWNLOAD_DIR
    const sub = path.join(root, '批次A')
    fs.mkdirSync(sub, { recursive: true })
    execFileStub.calls.length = 0
    const srv = serverMod.app.listen(0)
    await new Promise((r) => srv.on('listening', r))
    const base = `http://127.0.0.1:${srv.address().port}`
    // 每步断言节流前显式写入/删除对应键：节流是 3s 时间窗，若依赖"上一个请求刚写入的时刻"，
    // 事件循环卡顿超过 3s 就会翻回未节流 —— 直接摆好 Map 状态，断言与耗时彻底解耦
    const reqOpen = async (name) => (await fetch(`${base}/api/open-folder${name ? `?name=${encodeURIComponent(name)}` : ''}`)).json()
    try {
      // 1) 根目录已节流：如实回 throttled:true 且 dir 为真实打开路径，不 exec
      lastOpenByDir.set(root, Date.now())
      const r1 = await reqOpen()
      assert.strictEqual(r1.ok, true)
      assert.strictEqual(r1.throttled, true, '节流内应如实回 throttled:true（此前吞掉却报 ok:true 误导）')
      assert.strictEqual(r1.dir, root, 'dir 应回真实下载目录（= 临时 DOWNLOAD_DIR）')
      assert.strictEqual(execFileStub.calls.length, 0, '节流命中不得 exec explorer')
      // 2) 另一个目标不受根目录节流影响（按目标节流的核心语义）：未节流 → exec 一次
      lastOpenByDir.delete(sub)
      const r2 = await reqOpen('批次A')
      assert.strictEqual(r2.throttled, false, '不同目标不该被别人的节流吞掉')
      assert.strictEqual(r2.dir, sub, '应打开批次子目录')
      assert.strictEqual(execFileStub.calls.length, 1, '未节流的目标应 exec 一次')
      assert.strictEqual(execFileStub.calls[0][0], 'explorer')
      assert.deepStrictEqual(execFileStub.calls[0][1], [sub])
      // 3) 同一目标再点：进入节流，Map 按目标各记各的时刻，不再重复 exec
      lastOpenByDir.set(sub, Date.now())
      const r3 = await reqOpen('批次A')
      assert.strictEqual(r3.throttled, true, '同一目标节流期内应回 throttled:true')
      assert.strictEqual(execFileStub.calls.length, 1, '同一目标节流期内不得重复 exec')
      assert.ok(lastOpenByDir.get(sub) > 0, 'Map 应按目标记录时刻')
      // 4) name=.. 穿越被挡回根目录（根目录此时也在节流期内 → 不 exec）
      lastOpenByDir.set(root, Date.now())
      const r4 = await reqOpen('..')
      assert.strictEqual(r4.dir, root, '.. 应被挡在根目录外')
      assert.strictEqual(r4.throttled, true)
      assert.strictEqual(execFileStub.calls.length, 1, '穿越场景同样不得 exec')
    } finally {
      await new Promise((r) => srv.close(r))
      fs.rmSync(sub, { recursive: true, force: true })
    }
  })

  await t('server: fillQuality 缺省关 / 仅显式 true 才补下（真实 plan 取曲与取链接全 stub，零外网）', async () => {
    const serverMod = require('../server')
    const origPlaylistGet = svc.playlist.get
    const origResolve = core.url.resolve
    // 目录名带时间戳：即便上一次异常退出残留了同名批次，也不会被 findBatchDir 认走（用例始终对准自己造的目录）
    const listName = `补质歌单${Date.now()}`
    // 造批次目录：已有 320k 音频 + 歌词（DOWNLOAD_DIR 已在文件头指向 os.tmpdir）
    const dir = svc.storage.createBatchDir(TEST_DOWNLOAD_DIR, listName, 'playlist', '777')
    fs.writeFileSync(path.join(dir, '晴天.mp3'), 'x')
    fs.writeFileSync(path.join(dir, '晴天.lrc'), '[00:01.00]词')
    // 取曲走 stub 歌单；取链接 stub 成 noUrl：补下分支的任务会立刻失败收尾，全程不打外网
    svc.playlist.get = async () => ({
      id: 777, name: listName, count: 1,
      songs: [{ id: 1, name: '晴天', artist: '周杰伦', album: '', duration: 0 }],
    })
    core.url.resolve = async () => { const e = new Error('无可用链接 (id=1)'); e.noUrl = true; throw e }
    const srv = serverMod.app.listen(0)
    await new Promise((r) => srv.on('listening', r))
    const base = `http://127.0.0.1:${srv.address().port}`
    const post = (body) => fetch(`${base}/api/download`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).then((r) => r.json())
    // 同一歌单连发必须等上一个任务收尾，否则命中 batchKey 去重合并 → 回 already:true，拿不到新的 plan
    const waitJob = async (jobId) => {
      const start = Date.now()
      for (;;) {
        const j = await (await fetch(`${base}/api/job/${jobId}`)).json()
        if (j.status !== 'queued' && j.status !== 'running') return j
        if (Date.now() - start > 8000) throw new Error(`任务 ${jobId} 8s 未收尾: ${j.status}`)
        await new Promise((r) => setTimeout(r, 20))
      }
    }
    try {
      // 1) 不传 fillQuality（旧版 GET /download/* 的形态）→ 缺省关：已有 mp3+词即整体跳过。
      //    若缺省被当成开，qualityExt=flac 会让这首歌进补下队列 → skipped=0，此断言随即翻红
      const r1 = await post({ source: 'playlist', id: '777', br: '2000' })
      assert.ok(r1.jobId, `建任务应成功: ${JSON.stringify(r1)}`)
      assert.strictEqual(r1.skipped, 1, `缺省关时"已有音质+歌词"应跳过，实际 skipped=${r1.skipped}（缺省被当成了开）`)
      await waitJob(r1.jobId)
      // 2) 显式 true → 开：缺 flac 走补下，不再跳过
      const r2 = await post({ source: 'playlist', id: '777', br: '2000', fillQuality: true })
      assert.strictEqual(r2.skipped, 0, '显式 true 应打开音质补下（缺目标 flac → 下载而非跳过）')
      await waitJob(r2.jobId)
      // 3) 显式 false → 关
      const r3 = await post({ source: 'playlist', id: '777', br: '2000', fillQuality: 'false' })
      assert.strictEqual(r3.skipped, 1, '显式 false 应关')
      await waitJob(r3.jobId)
    } finally {
      svc.playlist.get = origPlaylistGet
      core.url.resolve = origResolve
      fs.rmSync(dir, { recursive: true, force: true })
      await new Promise((r) => srv.close(r))
    }
  })

  // ============ 歌单增量：按歌曲 id 认领（批次目录 .ncm-index.json） ============

  await t('storage: .ncm-index.json 读写（合并只增不删、坏文件容错、sweep保留、scanDir 不当歌）', () => {
    const fs = require('fs')
    const path = require('path')
    const os = require('os')
    const dir = tmpDir('ncmidx-')
    const file = path.join(dir, svc.storage.INDEX_NAME)
    try {
      // 无文件 → 空 Map（首次认领旧目录：本轮退回名字匹配，跑完回填）
      assert.strictEqual(svc.storage.readIndexFile(dir).size, 0, '无索引文件应返回空 Map')
      // 三种载体都能写；合并 = 已有条目保留 + 同 id 以新值为准（只增不删）
      assert.ok(svc.storage.mergeIndexFile(dir, [['1', '晴天']]), '数组对应写入')
      assert.ok(svc.storage.mergeIndexFile(dir, { 2: '晴天 - 周杰伦' }), '普通对象应可写入')
      assert.ok(svc.storage.mergeIndexFile(dir, new Map([['1', '晴天 (2)']])), 'Map 应可写入')
      assert.deepStrictEqual(svc.storage.readIndexFile(dir),
        new Map([['1', '晴天 (2)'], ['2', '晴天 - 周杰伦']]),
        '同 id 覆盖为新值；不在本批的旧条目（已移出歌单的歌）必须原样保留')
      // 非法条目（非串 base / 空 id）忽略，不污染索引
      svc.storage.mergeIndexFile(dir, [['3', 123], [null, 'x'], ['', 'y'], [4, '']])
      const m = svc.storage.readIndexFile(dir)
      assert.ok(!m.has('3') && !m.has('null') && !m.has('') && !m.has('4'),
        '非法条目不应入索引: ' + JSON.stringify([...m]))
      // 坏文件 → 空 Map 不抛（退回名字匹配），且后续 merge 能就地修复
      fs.writeFileSync(file, '{坏掉的 json', 'utf8')
      assert.strictEqual(svc.storage.readIndexFile(dir).size, 0, '坏索引应返回空 Map 而非抛错')
      assert.ok(svc.storage.mergeIndexFile(dir, [['9', '修复']]), '坏索引后仍可合并写入')
      assert.deepStrictEqual(svc.storage.readIndexFile(dir), new Map([['9', '修复']]))
      // sweep 只删 .part/.tagtmp：索引与音乐文件一律保留
      fs.writeFileSync(path.join(dir, 'a.mp3.part'), 'x')
      fs.writeFileSync(path.join(dir, 'b.tagtmp'), 'y')
      fs.writeFileSync(path.join(dir, 'c.mp3'), 'z')
      assert.strictEqual(svc.storage.sweepDownloads(dir), 2, '应删掉 2 个半成品')
      assert.ok(fs.existsSync(file), '.ncm-index.json 必须被 sweepDownloads 保留')
      assert.ok(fs.existsSync(path.join(dir, 'c.mp3')), '音乐文件必须保留')
      // scanDir 只认 mp3/flac/lrc：索引 json 不会被当成一首歌（taken 不混入 .ncm-index.json）
      const idx = svc.storage.scanDir(dir)
      assert.deepStrictEqual([...idx.audio.keys()], ['c'], '索引 json 不得进 audio')
      assert.strictEqual(idx.lrc.size, 0, '索引 json 不得进 lrc')
      // 目录不存在 / 传非法目录：读空、写 false，都不抛
      assert.strictEqual(svc.storage.readIndexFile(path.join(dir, '不存在')).size, 0)
      assert.strictEqual(svc.storage.mergeIndexFile('', [['1', 'x']]), false)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  await t('incremental: plan 按 id 认领旧名（歌改名/带歌手形态都直接认领历史 base）', () => {
    const { plan } = svc.incremental
    // 歌曲在网易改过名：磁盘旧文件还是下载时的名字——只凭歌名会按新名重下一遍
    const renamed = { id: 5, name: '新名', artist: 'A' }
    const idx1 = {
      audio: new Map([['旧名', new Set(['mp3'])]]),
      lrc: new Set(['旧名']),
      idMap: new Map([['5', '旧名']]),
    }
    const p1 = plan([renamed], idx1)
    assert.strictEqual(p1.bases.get(renamed), '旧名', '命中 id 必须直接认领历史 base（与现歌名无关）')
    assert.deepStrictEqual(p1.download, [], '认领成功不应重下')
    assert.deepStrictEqual(p1.fill, [])
    assert.deepStrictEqual(p1.skipped, [{ id: 5, name: '新名' }], '三口径不变：音频+歌词齐 → skipped')
    // 带歌手形态的历史 base 同样直接认领（idMap 用普通对象载体，兼容两种）
    const artistForm = { id: 6, name: '晴天', artist: '周杰伦' }
    const idx2 = {
      audio: new Map([['晴天 - 周杰伦', new Set(['mp3'])]]),
      lrc: new Set(['晴天 - 周杰伦']),
      idMap: { 6: '晴天 - 周杰伦' },
    }
    const p2 = plan([artistForm], idx2)
    assert.strictEqual(p2.bases.get(artistForm), '晴天 - 周杰伦', '带歌手的历史 base 应原样认领')
    assert.deepStrictEqual(p2.skipped, [{ id: 6, name: '晴天' }])
    // id 不在索引 → 回退现有名字规则（本批单首、名字不在盘上 → 纯歌名）
    const miss = { id: 7, name: '晴天', artist: '林俊杰' }
    const p3 = plan([miss], idx2)
    assert.strictEqual(p3.bases.get(miss), '晴天', 'ID 缺失应按现有名字规则分配')
    assert.deepStrictEqual(p3.download, [miss], '盘上没有该名 → 走完整下载')
    assert.deepStrictEqual([...p3.lyricsFor], [miss], '缺歌词 → 进补词候选（lyricsFor 口径不变）')
  })

  await t('incremental: plan 同名两首各按自己的 id 认领，不互认（A→base1、B→base2）', () => {
    const { plan } = svc.incremental
    const A = { id: 1, name: '晴天', artist: '周杰伦' }
    const B = { id: 2, name: '晴天', artist: '周杰伦' } // 同名同歌手（歌单重复收录）
    const audio = new Map([['晴天', new Set(['mp3'])], ['晴天 - 周杰伦', new Set(['mp3'])]])
    const lrc = new Set(['晴天', '晴天 - 周杰伦'])
    const idx = { audio, lrc, idMap: new Map([['1', '晴天'], ['2', '晴天 - 周杰伦']]) }
    // 故意把 B 放前面：名字逻辑"先到先得"会让 B 抢走 A 的旧文件
    const p = plan([B, A], idx)
    assert.strictEqual(p.bases.get(A), '晴天', 'A 按自己的 id 认领 base1')
    assert.strictEqual(p.bases.get(B), '晴天 - 周杰伦', 'B 按自己的 id 认领 base2，不与 A 互认')
    assert.deepStrictEqual(p.download, [])
    assert.deepStrictEqual(p.fill, [])
    assert.deepStrictEqual(p.skipped, [{ id: 2, name: '晴天' }, { id: 1, name: '晴天' }],
      '三口径顺序跟随传入数组，两首都应跳过')
    // 同批里 id 不在索引的新歌：仍走名字逻辑，且避让已按 id 认领走的历史名
    const C = { id: 3, name: '晴天', artist: '梁静茹' }
    const p2 = plan([C, B, A], idx)
    assert.strictEqual(p2.bases.get(A), '晴天', '命中 id 的 A 不受新歌影响')
    assert.strictEqual(p2.bases.get(B), '晴天 - 周杰伦', '命中 id 的 B 不受新歌影响')
    assert.strictEqual(p2.bases.get(C), '晴天 - 梁静茹', 'C 不在索引 → 现有规则（同名组全组加歌手）且避让历史名')
    assert.deepStrictEqual(p2.download, [C], 'C 是没下过的新歌 → 走下载')
    assert.deepStrictEqual(p2.skipped, [{ id: 2, name: '晴天' }, { id: 1, name: '晴天' }],
      '两首命中 id 的旧歌照旧跳过（顺序跟随传入数组，C 在最前但进 download 不进 skipped）')
    // 反证：同一份磁盘状态，无 idMap（引入前行为）时先到先得会张冠李戴——
    // B 抢走本属于 A 的 '晴天'，A 被安上本属于 B 的 '晴天 - 周杰伦'，两首互认（各按对方的文件记账）
    const legacy = plan([B, A], { audio, lrc })
    assert.strictEqual(legacy.bases.get(B), '晴天', '旧行为：B 先到先得抢走本属于 A 的旧文件')
    assert.strictEqual(legacy.bases.get(A), '晴天 - 周杰伦', '旧行为：A 拿到本属于 B 的文件 → 两首互认')
    assert.strictEqual(legacy.bases.get(A), p.bases.get(B), '旧行为下 A 的 base 实为索引里 B 的 base（互换）')
    assert.strictEqual(legacy.bases.get(B), p.bases.get(A), '旧行为下 B 的 base 实为索引里 A 的 base（互换）')
  })

  await t('incremental: run 首次认领无索引旧目录 → 按名字规则跑并回填 .ncm-index.json', async () => {
    const fs = require('fs')
    const path = require('path')
    const os = require('os')
    const dir = tmpDir('backfill-')
    try {
      // 旧目录：只有产物、没有索引文件（引入前的历史批次）
      fs.writeFileSync(path.join(dir, '旧歌.mp3'), Buffer.alloc(8))
      fs.writeFileSync(path.join(dir, '旧歌.lrc'), '词')
      assert.strictEqual(svc.storage.readIndexFile(dir).size, 0, '前提：无索引文件')
      const old = { id: 11, name: '旧歌' }
      const fresh = { id: 12, name: '新歌' }
      const p = svc.incremental.plan([old, fresh], svc.incremental.scanDir(dir)) // 无 idMap → 全按名字规则
      assert.deepStrictEqual(p.skipped.map((s) => s.id), [11], '前提：旧歌按名字认领被跳过')
      const fakeMany = async (list, o) => list.map((s) => ({ ok: true, filepath: path.join(o.dir, `${o.bases.get(s)}.mp3`) }))
      const r = await svc.incremental.run(p, { dir, downloadMany: fakeMany, lyrics: false }, {})
      assert.strictEqual(r.results.length, 1, '新歌应走下载')
      assert.deepStrictEqual(svc.storage.readIndexFile(dir),
        new Map([['11', '旧歌'], ['12', '新歌']]), '被跳过的旧歌与新下载的歌都应回填 id→base')
      // 回填后下一轮：按 id 认领（即使歌在网易改名也认旧文件）
      const renamed = { id: 11, name: '改名后的旧歌' }
      const p2 = svc.incremental.plan([renamed],
        { ...svc.incremental.scanDir(dir), idMap: svc.storage.readIndexFile(dir) })
      assert.strictEqual(p2.bases.get(renamed), '旧歌', '回填后应按 id 认领，不再靠歌名猜')
      assert.deepStrictEqual(p2.skipped, [{ id: 11, name: '改名后的旧歌' }])
      // 只增不删：不在本批的 12 号条目不因本轮只查 11 号而消失
      assert.ok(svc.storage.readIndexFile(dir).has('12'), '未出现的旧条目必须保留')
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  await t('download: downloadMany 每首成功后回写 .ncm-index.json（id→实际落盘 base，失败不记账）', async () => {
    const fs = require('fs')
    const path = require('path')
    const os = require('os')
    const dir = tmpDir('idxwrite-')
    const origResolve = core.url.resolve
    const origStream = core.download.streamTo
    core.url.resolve = async (id) => {
      if (Number(id) === 103) { const e = new Error('无可用链接 (id=103)'); e.noUrl = true; throw e }
      return { id: Number(id), url: 'http://x/a.mp3', br: 320, size: 404, level: 'exhigh', type: 'mp3', ext: 'mp3' }
    }
    core.download.streamTo = async (url, filepath) => {
      fs.writeFileSync(filepath, Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(400, 0x55)]))
      return { size: 404, total: 404 }
    }
    try {
      const songs = [
        { id: 101, name: '甲', artist: 'a', picUrl: '' },
        { id: 102, name: '乙', artist: 'b', picUrl: '' },
        { id: 103, name: '丙', artist: 'c', picUrl: '' },
      ]
      const rs = await svc.download.downloadMany(songs, { dir, br: 320, cover: false })
      assert.strictEqual(rs.filter((r) => r.ok).length, 2, '前两首成功、第三首失败')
      assert.deepStrictEqual(svc.storage.readIndexFile(dir),
        new Map([['101', '甲'], ['102', '乙']]), '成功的两首按真实落盘 base 记账，失败的 103 不记')
      assert.ok(fs.existsSync(path.join(dir, '甲.mp3')), '落盘名与索引一致')
      // 索引与产物对齐：下一轮增量按 id 认领即可跳过（无需再靠歌名）
      const p = svc.incremental.plan([songs[0]],
        { ...svc.incremental.scanDir(dir), idMap: svc.storage.readIndexFile(dir) })
      assert.strictEqual(p.bases.get(songs[0]), '甲')
      assert.deepStrictEqual(p.download, [])
    } finally {
      core.url.resolve = origResolve
      core.download.streamTo = origStream
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  await t('incremental: plan 向后兼容（index 无 idMap 时与原行为逐字一致）', () => {
    const { plan } = svc.incremental
    const songs = [
      { id: 1, name: '晴天', artist: '周杰伦' },
      { id: 2, name: '晴天', artist: '林俊杰' },
      { id: 3, name: '夜曲', artist: '周杰伦' },
    ]
    const base = { audio: new Map([['晴天', new Set(['mp3'])]]), lrc: new Set(['晴天']) }
    const legacy = plan(songs, base) // 引入前形态：index 只有 audio/lrc
    assert.deepStrictEqual(plan(songs, { ...base, idMap: undefined }), legacy, 'idMap:undefined 应与原行为一致')
    assert.deepStrictEqual(plan(songs, { ...base, idMap: new Map() }), legacy, '空 Map 应与原行为一致')
    assert.deepStrictEqual(plan(songs, { ...base, idMap: {} }), legacy, '空对象应与原行为一致')
    // 原行为本身：先到先得认领磁盘旧名 + 同名组全组加歌手 + 三口径
    assert.strictEqual(legacy.bases.get(songs[0]), '晴天')
    assert.strictEqual(legacy.bases.get(songs[1]), '晴天 - 林俊杰')
    assert.strictEqual(legacy.bases.get(songs[2]), '夜曲')
    assert.deepStrictEqual(legacy.download.map((s) => s.id), [2, 3])
    assert.deepStrictEqual(legacy.fill, [])
    assert.deepStrictEqual(legacy.skipped, [{ id: 1, name: '晴天' }])
    assert.deepStrictEqual([...legacy.lyricsFor].map((s) => s.id), [2, 3], 'lyricsFor 口径不变')
  })

  await t('tag: buffer 级内嵌（embedMp3Buf/embedFlacBuf）与文件版产物逐字节一致', () => {
    const dir = tmpDir('tagbuf-')
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR'),
      Buffer.from([0, 0, 0, 3, 0, 0, 0, 2, 8, 6, 0, 0, 0]), Buffer.alloc(4),
    ])
    const mp3Raw = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(400, 0x55)])
    const tagged = core.tag.embedMp3Buf(mp3Raw, { title: 'T', artist: 'A', album: 'B', cover: png, mime: 'image/png' })
    const p1 = path.join(dir, 'b.mp3')
    fs.writeFileSync(p1, tagged)
    const v = core.tag.verifyTags(p1)
    assert.ok(v.ok && v.apic, 'verify 失败: ' + (v && v.error))
    const p2 = path.join(dir, 'c.mp3')
    fs.writeFileSync(p2, mp3Raw)
    core.tag.embedCover(p2, { title: 'T', artist: 'A', album: 'B', cover: png, mime: 'image/png' })
    assert.ok(fs.readFileSync(p2).equals(tagged), 'buffer 版与文件版产物不一致')
    const flacRaw = Buffer.concat([
      Buffer.from('fLaC'),
      Buffer.from([0x00]), Buffer.from([0, 0, 38]), Buffer.alloc(38),
      Buffer.from([0x81]), Buffer.from([0, 0, 4]), Buffer.alloc(4),
      Buffer.from([0xff, 0xf8]), Buffer.alloc(200, 0xaa),
    ])
    const taggedFlac = core.tag.embedFlacBuf(flacRaw, { title: 'F', artist: 'L', album: 'A', cover: png, mime: 'image/png' })
    const p3 = path.join(dir, 'd.flac')
    fs.writeFileSync(p3, taggedFlac)
    const v2 = core.tag.verifyTags(p3)
    assert.ok(v2.ok && v2.mime === 'image/png', 'verify 失败: ' + (v2 && v2.error))
    // 无封面只写文本标签也走同一出口
    const bare = core.tag.embedMp3Buf(mp3Raw, { title: 'T', artist: 'A', album: '' })
    fs.writeFileSync(p1, bare)
    const v3 = core.tag.verifyTags(p1)
    assert.ok(v3.ok && !v3.apic, 'verify 失败: ' + (v3 && v3.error))
    fs.rmSync(dir, { recursive: true, force: true })
  })

  await t('dest: 配置增删/激活/持久化/失效回退（临时文件，不碰真实 destinations.json）', () => {
    const file = path.join(tmpDir('desttest-'), 'destinations.json')
    svc.dest._useFile(file)
    try {
      assert.strictEqual(svc.dest.activeId(), null)
      assert.strictEqual(svc.dest.list().length, 0)
      assert.strictEqual(svc.dest.resolve('X:\\default').kind, 'default')
      const dir = tmpDir('dest-dir-')
      const d = svc.dest.addLocal(dir)
      assert.ok(d.id && d.kind === 'local')
      assert.strictEqual(svc.dest.activeId(), d.id)
      const r = svc.dest.resolve('X:\\default')
      assert.strictEqual(r.kind, 'local')
      assert.strictEqual(r.base, path.resolve(dir))
      // 持久化：丢弃缓存后从盘上读回
      svc.dest._useFile(file)
      assert.strictEqual(svc.dest.activeId(), d.id)
      assert.strictEqual(svc.dest.list().length, 1)
      // 回默认 & 删除
      svc.dest.setActive(null)
      assert.strictEqual(svc.dest.resolve('X:\\default').kind, 'default')
      svc.dest.remove(d.id)
      assert.strictEqual(svc.dest.list().length, 0)
      assert.throws(() => svc.dest.remove('d999'))
      // 激活目的地被拔盘/删除时 resolve 如实回退缺省（不炸建任务）
      const d2 = svc.dest.addLocal(dir)
      svc.dest.setActive(d2.id)
      fs.rmSync(dir, { recursive: true, force: true })
      const r2 = svc.dest.resolve('X:\\default')
      assert.strictEqual(r2.kind, 'default')
      assert.strictEqual(r2.fallbackFrom, d2.id)
    } finally {
      // 恢复到进程级测试配置文件（不是真实 destinations.json——保持整进程隔离）
      svc.dest._useFile(path.join(TEST_DOWNLOAD_DIR, 'destinations.json'))
      fs.rmSync(path.dirname(file), { recursive: true, force: true })
    }
  })

  await t('phone: 设备清单→scanDir/索引→plan 对账（stub adb，无设备无网络）', async () => {
    // 内存设备 FS：stub 掉 core.adb 的文件操作——phone.js 持有 core.adb 的模块对象引用，
    // 属性替换对它可见（finally 逐项还原）
    const deviceFiles = new Map([
      ['晴天.mp3', Buffer.alloc(4)],
      ['晴天.lrc', Buffer.from('[00:01]x')],
      ['.ncm-batch.json', Buffer.from(JSON.stringify({ type: 'playlist', name: '测试歌单', ownerId: '1' }))],
      ['.ncm-index.json', Buffer.from(JSON.stringify({ '1': '晴天' }))],
    ])
    const deviceDirs = new Set(['/sdcard/Music/测试歌单 [1]'])
    const orig = {
      listFiles: core.adb.listFiles, listDirs: core.adb.listDirs, readText: core.adb.readText,
      pushBuffer: core.adb.pushBuffer, mkdirP: core.adb.mkdirP, shell: core.adb.shell, rm: core.adb.rm,
    }
    const pushed = []
    core.adb.listFiles = () => [...deviceFiles.keys()]
    core.adb.listDirs = () => [...deviceDirs].map((p) => p.split('/').pop())
    core.adb.readText = (p) => {
      const name = p.split('/').pop()
      if (!deviceFiles.has(name)) throw new Error('No such file')
      return deviceFiles.get(name).toString('utf8')
    }
    core.adb.pushBuffer = (buf, p) => { pushed.push({ p, buf }); deviceFiles.set(p.split('/').pop(), buf) }
    core.adb.mkdirP = (d) => deviceDirs.add(d)
    core.adb.shell = (cmd) => {
      // 只模拟本用例涉及的 `mv "a" "b"`（shq 双引号包裹，测试路径不含需转义字符）：
      // 按 basename 在内存设备 FS 里搬移，让"先推 .tmp 再 mv"的原子写语义对断言可见。
      // 不 stub 的话这条会经真实 adb 打到插着的真机——测试铁律红线
      const m = /^mv "(.+)" "(.+)"$/.exec(cmd)
      if (!m) throw new Error('shell 桩只认 mv: ' + cmd)
      const from = m[1].split('/').pop(); const to = m[2].split('/').pop()
      if (!deviceFiles.has(from)) throw new Error('mv: source missing: ' + from)
      deviceFiles.set(to, deviceFiles.get(from))
      deviceFiles.delete(from)
    }
    core.adb.rm = (p) => { deviceFiles.delete(p.split('/').pop()) }
    try {
      const dir = '/sdcard/Music/测试歌单 [1]'
      const idx = svc.phone.scanDir(dir)
      assert.ok(idx.audio.has('晴天') && idx.audio.get('晴天').has('mp3'))
      assert.ok(idx.lrc.has('晴天'))
      // 索引读回：id 1 → 晴天（与设备上的 .ncm-index.json 一致）
      const idMap = svc.phone.readIndexFile(dir)
      assert.strictEqual(idMap.get('1'), '晴天')
      // 对账：晴天按 id 认领跳过，新歌进 download
      const songs = [{ id: 1, name: '晴天', artist: 'J' }, { id: 2, name: '后来', artist: 'X' }]
      const plan = svc.incremental.plan(songs, { ...idx, idMap }, { lyrics: true })
      assert.deepStrictEqual(plan.skipped.map((s) => s.id), [1])
      assert.deepStrictEqual(plan.download.map((s) => s.id), [2])
      // 索引合并写：回填 + 新增条目落在一次推送里；重复合并不再写（dirty 判定）
      const before = pushed.length
      assert.ok(svc.phone.mergeIndexFile(dir, [[1, '晴天'], [2, '后来']]))
      const written = JSON.parse(pushed[pushed.length - 1].buf.toString('utf8'))
      assert.strictEqual(written['1'], '晴天')
      assert.strictEqual(written['2'], '后来')
      assert.ok(svc.phone.mergeIndexFile(dir, [[1, '晴天'], [2, '后来']]))
      assert.strictEqual(pushed.length, before + 1, '无变化的重复合并不得再写')
      // 旧目录（类型匹配）被 findBatchDir 认领；类型不符不认领。
      // （内存桩按 basename 存文件，下方 createBatchDir 写 marker 会覆盖同名键——认领断言必须放在它之前）
      assert.strictEqual(svc.phone.findBatchDir('/sdcard/Music', '测试歌单', 'playlist', '1'), '/sdcard/Music/测试歌单 [1]')
      deviceFiles.set('.ncm-batch.json', Buffer.from(JSON.stringify({ type: 'chart', name: '测试歌单' })))
      assert.strictEqual(svc.phone.findBatchDir('/sdcard/Music', '测试歌单', 'playlist', '1'), null)
      // 批次目录：同 stem 已存在（marker 类型不符被 findBatchDir 拒认、同名重跑等场景）
      // 必须追加 " (n)"——与 storage.createBatchDir 同口径，手机侧静默复用同名目录会
      // 覆盖旧 marker 且两批歌混装污染增量对账
      const created = svc.phone.createBatchDir('/sdcard/Music', '测试歌单', 'playlist', '1')
      assert.strictEqual(created, '/sdcard/Music/测试歌单 [1] (2)', '同 stem 已存在须追加 (n)，不得静默复用')
      const fresh = svc.phone.createBatchDir('/sdcard/Music', '新批次', 'playlist', '7')
      assert.strictEqual(fresh, '/sdcard/Music/新批次 [7]')
      assert.strictEqual(svc.phone.findBatchDir('/sdcard/Music', '新批次', 'playlist', '7'), fresh)
    } finally {
      Object.assign(core.adb, orig)
    }
  })

  await t('server: 下载位置/ADB 门面端点形状（纯本地，stub adb）', async () => {
    const origDevices = core.adb.devices
    // cookie 与探测都要桩掉：本用例断言的是"纯本地"，而 /api/status 会走
    // service/login.probeCookieState → core.raw('login_status') —— 打的是**真实** music.163.com，
    // 还会把开发者真实的会话 cookie 发出去（cookie.txt 就在项目根目录，has() 为真）。
    // 前一个用例刚把 cookie 值改成别的，缓存因此失效，这一句必然触发一次真实外网请求（最长 5s）
    const origCookieHas = core.cookie.has
    const origCookieGet = core.cookie.get
    const origRaw = core.raw
    core.cookie.has = () => true
    core.cookie.get = () => 'MUSIC_U=单元测试桩'
    core.raw = async () => ({ body: { data: { code: 200 } } })
    svc.adb.invalidate() // 状态缓存必须先失效：否则拿到的是上一个用例留下的 5s 陈旧值
    core.adb.devices = () => [{ serial: 'S', state: 'device', model: 'TEST' }]
    try {
      const serverMod = require('../server')
      const srv = serverMod.app.listen(0)
      await new Promise((r) => srv.on('listening', r))
      const base = `http://127.0.0.1:${srv.address().port}`
      try {
        const d = await (await fetch(`${base}/api/dest`)).json()
        assert.ok(Array.isArray(d.list) && 'active' in d && 'defaultDir' in d)
        const a = await (await fetch(`${base}/api/adb`)).json()
        assert.strictEqual(a.state, 'ready')
        assert.strictEqual(a.device.model, 'TEST')
        const st = await (await fetch(`${base}/api/status`)).json()
        // 桩出来的探测是 code 200 → 必须报 valid；顺带锁住"四态探测"这个语义
        assert.strictEqual(st.cookie, 'valid', '探测返回 200 时应报 valid')
        assert.ok(st.dest && ['default', 'local', 'phone'].includes(st.dest.kind))
        assert.strictEqual(st.dest.kind, 'default', '本用例未激活任何目的地，应为 default')
        assert.strictEqual(st.dest.base, TEST_DOWNLOAD_DIR, '下载根必须是重定向后的临时目录，绝不能是真实 downloads\\')
        // 未知目的地 404；未知 action 400
        assert.strictEqual((await fetch(`${base}/api/open-folder?dest=nope`)).status, 404)
        const bad = await fetch(`${base}/api/dest`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'nope' }) })
        assert.strictEqual(bad.status, 400)
        // 未知 /api 路径必须回 JSON 404：Express 缺省会给 HTML 错误页，
        // 而前端 api() 是按 JSON 解析的，拿到 HTML 会抛"Unexpected token <"
        const unknown = await fetch(`${base}/api/does-not-exist`)
        assert.strictEqual(unknown.status, 404)
        assert.ok(/application\/json/.test(unknown.headers.get('content-type') || ''), '未知 API 必须回 JSON')
        assert.ok(/接口不存在/.test(await unknown.text()))
        // 非 /api 路径仍走 Express 默认 404（浏览器行为，不是 API 契约）
        assert.strictEqual((await fetch(`${base}/no-such-page.html`)).status, 404)
      } finally { if (srv.closeAllConnections) srv.closeAllConnections(); srv.close() }
    } finally {
      core.adb.devices = origDevices
      core.cookie.has = origCookieHas
      core.cookie.get = origCookieGet
      core.raw = origRaw
      svc.adb.invalidate()
    }
  })

  // ---- 本轮加固回归：清洗 / adb 半成品清理 / 四态 / dest.addPhone / open-folder 契约 / 对话框 ----

  await t('download: sanitize 尾点尾空格/保留设备名/非法字符/码点截断（Win32 落盘回归）', () => {
    // 尾点/尾空格：Win32 落盘会静默剥离，记账 base 与磁盘名错位 → 增量永不收敛
    assert.strictEqual(core.download.sanitize('晴天...'), '晴天')
    assert.strictEqual(core.download.sanitize('晴天 . '), '晴天')
    assert.strictEqual(core.download.sanitize('...'), '') // 清洗后为空，调用方（batchStem）有兜底
    // 控制字符（含 \t）按约定映射成下划线：落在名字中间是合法文件名，不会造成增量错位
    assert.strictEqual(core.download.sanitize('晴天\t'), '晴天_')
    // Windows 保留设备名（含带扩展名形态）必须前缀下划线，否则 mkdir/writeFile 直接 ENOENT
    assert.strictEqual(core.download.sanitize('con'), '_con')
    assert.strictEqual(core.download.sanitize('CON.mp3'), '_CON.mp3')
    assert.strictEqual(core.download.sanitize('nul'), '_nul')
    assert.strictEqual(core.download.sanitize('com1'), '_com1')
    // 设备名空间里的其余成员：CONIN$/CONOUT$ 与上标 ¹²³ 形式同样是设备（决策 94）
    assert.strictEqual(core.download.sanitize('CONIN$'), '_CONIN$')
    assert.strictEqual(core.download.sanitize('COM¹'), '_COM¹')
    // 非法字符与控制字符 → 下划线；换行折叠成单空格
    assert.ok(!/[\\/:*?"<>|\r\n]/.test(core.download.sanitize('a/b:c*?"<>|d\ne')))
    // 0x7F（DEL）也要清洗：Windows 允许它出现在文件名里，但各工具链处理不一致
    assert.ok(!core.download.sanitize('a\u007fb').includes('\u007f'))
    // null/undefined 必须归一为空串：String(undefined)==='undefined' 是真值，
    // 会产出字面量叫 undefined.flac 的文件（歌名缺失的电台/播客条目会命中）
    assert.strictEqual(core.download.sanitize(undefined), '')
    assert.strictEqual(core.download.sanitize(null), '')
    assert.strictEqual(core.download.sanitize('undefined'), 'undefined', '字面量 "undefined" 是真实歌名，不得被误伤')
    // 码点截断：120 码点上限，不产生孤立代理字符（slice(0,120) 会把 emoji 切半）
    const long = core.download.sanitize('🎵'.repeat(130))
    assert.ok([...long].length <= 120, `码点数不得超过 120，实际 ${[...long].length}`)
    assert.ok(!/[\uD800-\uDFFF]/.test(long.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')), '不得残留孤立代理字符')
    // 字节上限（决策 94）：NTFS/ext4 的单分量上限是 255 **字节**，120 个汉字 = 360 字节必然被拒。
    // 此前只有码点上限，手机管线会在设备端报 File name too long，而那条 adb 错误会被
    // 当成"手机目的地不可用"——把用户的歌单名问题甩给手机
    for (const sample of ['汉'.repeat(200), '🎵'.repeat(200), 'a'.repeat(200)]) {
      const out = core.download.sanitize(sample)
      assert.ok(Buffer.byteLength(out, 'utf8') <= 240,
        `字节数必须 ≤240（给 .tagtmp/[id] 后缀留余量），实际 ${Buffer.byteLength(out, 'utf8')}：${sample[0]}`)
    }
    // ASCII 走码点上限（120），不该被字节上限截到 60
    assert.strictEqual([...core.download.sanitize('a'.repeat(200))].length, 120,
      '120 个 ASCII 是 120 字节，字节上限不得先于码点上限触发')
    // 中文按字节上限收口到约 80 码点（240/3）
    const cjk = core.download.sanitize('汉'.repeat(200))
    assert.ok([...cjk].length >= 78 && [...cjk].length <= 80, `汉字应收口到 ~80 码点，实际 ${[...cjk].length}`)
  })

  await t('adb: pushBuffer 失败路径删远端半成品 + 成功路径零 rm（一次性重载注入 spawnSync 桩）', () => {
    const crypto = require('crypto')
    const origSpawnSync = childProcess.spawnSync
    const calls = []
    const ok = () => ({ error: null, status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') })
    const buf = Buffer.from('音乐字节')
    const md5 = crypto.createHash('md5').update(buf).digest('hex')
    let scenario = 'success'
    // adb.js 在模块加载时解构 spawnSync（本地绑定，事后换 childProcess 属性对它无效），
    // 且直接持有 spawnSync/execOut/rm 的本地引用——只能先装好桩再清缓存重载一个一次性实例来测；
    // core.adb 引用的原实例不受影响，验证完丢弃
    childProcess.spawnSync = (cmd, args) => {
      calls.push(args)
      if (String(args[0]) === 'exec-out') {
        const out = scenario === 'success' ? `${md5}  /sdcard/Music/fine.mp3\n` : 'deadbeef  /sdcard/Music/fine.mp3\n'
        return { ...ok(), stdout: Buffer.from(out) }
      }
      if (scenario === 'write-fail') return { error: null, status: 1, stdout: Buffer.from(''), stderr: Buffer.from('write failed') }
      if (scenario === 'silent-exit') return { error: null, status: 1, stdout: Buffer.from(''), stderr: Buffer.from('') }
      if (scenario === 'timed-out') {
        const e = new Error('spawnSync adb ETIMEDOUT'); e.code = 'ETIMEDOUT'
        return { error: e, status: null, stdout: Buffer.from(''), stderr: Buffer.from('') }
      }
      if (scenario === 'enoent') {
        const e = new Error('spawn adb ENOENT'); e.code = 'ENOENT'
        return { error: e, status: null, stdout: Buffer.from(''), stderr: Buffer.from('') }
      }
      return ok()
    }
    const adbStubbed = (() => {
      const p = require.resolve('../src/core/adb')
      delete require.cache[p]
      return require(p)
    })()
    try {
      // 成功：md5sum 回吐正确哈希 → 返回路径，且不产生任何 rm 调用
      assert.strictEqual(adbStubbed.pushBuffer(buf, '/sdcard/Music/fine.mp3'), '/sdcard/Music/fine.mp3')
      assert.ok(!calls.some((a) => /rm -f/.test(String(a[1]))), '成功路径不得删文件')
      // 写入失败（status!==0）：必须 rm 半成品再抛错，否则截断文件会被 scanDir 认领成"已存在"
      calls.length = 0; scenario = 'write-fail'
      let wf = null
      try { adbStubbed.pushBuffer(buf, '/sdcard/Music/y.mp3') } catch (e) { wf = e }
      assert.ok(wf && /设备端写入失败/.test(wf.message))
      assert.ok(!wf.deviceSuspect, '有 stderr 的业务失败（如磁盘已满）保持终态，不标 deviceSuspect')
      assert.ok(calls.some((a) => /rm -f/.test(String(a[1]))), '失败后必须发 rm 删半成品')
      // 静默异常退出（stderr/stdout 全空）：adb 进程死亡 = 传输中断征兆，标 deviceSuspect 供上层分级
      calls.length = 0; scenario = 'silent-exit'
      let se = null
      try { adbStubbed.pushBuffer(buf, '/sdcard/Music/s.mp3') } catch (e) { se = e }
      assert.ok(se && se.deviceSuspect === true, '空输出异常退出应标 deviceSuspect')
      assert.ok(calls.some((a) => /rm -f/.test(String(a[1]))), '静默退出同样必须删半成品')
      // spawnSync 层超时（USB 停滞挂到 timeout 被收割）：同样标 deviceSuspect
      calls.length = 0; scenario = 'timed-out'
      let to = null
      try { adbStubbed.pushBuffer(buf, '/sdcard/Music/t.mp3') } catch (e) { to = e }
      assert.ok(to && to.deviceSuspect === true, 'spawnSync 层超时应标 deviceSuspect')
      assert.ok(calls.some((a) => /rm -f/.test(String(a[1]))), '超时路径同样必须删半成品')
      // md5 不符：同样 rm 半成品（传输损坏的文件留着会被当完整歌永久跳过）
      calls.length = 0; scenario = 'md5-bad'
      assert.throws(() => adbStubbed.pushBuffer(buf, '/sdcard/Music/z.mp3'), /md5/)
      assert.ok(calls.some((a) => /rm -f/.test(String(a[1]))), 'md5 不符后必须发 rm 删半成品')
      // ENOENT（adb 未装）：同样先删半成品（此前这条路径会留下空文件）并带 noAdb 标记
      calls.length = 0; scenario = 'enoent'
      let caught = null
      try { adbStubbed.pushBuffer(buf, '/sdcard/Music/w.mp3') } catch (e) { caught = e }
      assert.ok(caught && caught.noAdb === true, 'ENOENT 应抛 noAdb 标记错误')
      assert.ok(calls.some((a) => /rm -f/.test(String(a[1]))), 'ENOENT 路径同样必须删半成品')
    } finally {
      childProcess.spawnSync = origSpawnSync
      delete require.cache[require.resolve('../src/core/adb')] // 丢弃带桩绑定的一次性实例
    }
  })

  await t('adb: run() 对传输停滞同样标 deviceSuspect；md5sum 阶段失败也删半成品（一次性重载）', () => {
    const crypto = require('crypto')
    const origSpawnSync = childProcess.spawnSync
    const calls = []
    const ok = () => ({ error: null, status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') })
    const buf = Buffer.from('x')
    let scenario = 'ok'
    childProcess.spawnSync = (cmd, args) => {
      calls.push(args)
      // run-timeout：任意命令的 spawnSync 层超时（覆盖 run() 直接调用与经 execOut 的 md5sum）
      if (scenario === 'run-timeout') {
        const e = new Error('spawnSync adb ETIMEDOUT'); e.code = 'ETIMEDOUT'
        return { error: e, status: null, stdout: Buffer.from(''), stderr: Buffer.from('') }
      }
      if (String(args[0]) === 'exec-out') {
        if (scenario === 'md5-throw') {
          const e = new Error('spawnSync adb ETIMEDOUT'); e.code = 'ETIMEDOUT'
          return { error: e, status: null, stdout: Buffer.from(''), stderr: Buffer.from('') }
        }
        const md5 = crypto.createHash('md5').update(buf).digest('hex')
        return { ...ok(), stdout: Buffer.from(`${md5}  /sdcard/Music/fine.mp3\n`) }
      }
      if (scenario === 'run-silent') return { error: null, status: 1, stdout: Buffer.from(''), stderr: Buffer.from('') }
      if (scenario === 'run-stderr') return { error: null, status: 1, stdout: Buffer.from(''), stderr: Buffer.from('error: device offline') }
      return ok()
    }
    const adbStubbed = (() => {
      const p = require.resolve('../src/core/adb')
      delete require.cache[p]
      return require(p)
    })()
    try {
      // run()：spawnSync 层超时 → deviceSuspect。md5sum 校验（execOut）走 run()，
      // 不打标记的话校验停滞会绕过 pushToDevice 的断连宽限容错（P1 回归锁）
      scenario = 'run-timeout'
      let to = null
      try { adbStubbed.run(['devices', '-l']) } catch (e) { to = e }
      assert.ok(to && to.deviceSuspect === true, 'run() spawnSync 层超时应标 deviceSuspect')
      // run()：静默异常退出（无任何输出）→ 同样疑似断连
      scenario = 'run-silent'
      let se = null
      try { adbStubbed.run(['shell', 'x']) } catch (e) { se = e }
      assert.ok(se && se.deviceSuspect === true, 'run() 空输出异常退出应标 deviceSuspect')
      // run()：有 stderr 的业务失败保持普通错误（不乱标，终态语义留给上层正则）
      scenario = 'run-stderr'
      let rs = null
      try { adbStubbed.run(['shell', 'x']) } catch (e) { rs = e }
      assert.ok(rs && !rs.deviceSuspect && /device offline/.test(rs.message), '有 stderr 的失败保持终态普通错误')
      // pushBuffer：写入完成后 md5sum 阶段抛错（USB 写入尾部断开的典型形态——设备端留下
      // 截断文件）必须先 rm 半成品再抛，否则截断文件被下次 scanDir 认领成"完整歌"永久跳过
      scenario = 'md5-throw'
      let mt = null
      try { adbStubbed.pushBuffer(buf, '/sdcard/Music/m.mp3') } catch (e) { mt = e }
      assert.ok(mt && mt.deviceSuspect === true, 'md5sum 停滞错误应带 deviceSuspect 标记（走宽限重推而非记失败）')
      assert.ok(calls.some((a) => /rm -f/.test(String(a[1]))), 'md5sum 阶段失败必须发 rm 删半成品')
    } finally {
      childProcess.spawnSync = origSpawnSync
      delete require.cache[require.resolve('../src/core/adb')]
    }
  })

  await t('adb: status 四态归一 + 就绪短缓存（devices 桩）', () => {
    const origDevices = core.adb.devices
    try {
      svc.adb.invalidate()
      core.adb.devices = () => [{ serial: 'S', state: 'device', model: 'TEST' }]
      assert.strictEqual(svc.adb.status().state, 'ready')
      core.adb.devices = () => [] // 缓存期内换桩：不得重探（ready 缓存 5s）
      assert.strictEqual(svc.adb.status().state, 'ready', '就绪缓存期内不得重探')
      svc.adb.invalidate()
      const nd = svc.adb.status()
      assert.strictEqual(nd.state, 'no-device')
      assert.ok(/管理文件|传输文件/.test(nd.message), '无设备提示须带手机端 USB 用途指引（仅充电探不到）')
      svc.adb.invalidate()
      core.adb.devices = () => [{ serial: 'S', state: 'unauthorized' }]
      const st = svc.adb.status()
      assert.strictEqual(st.state, 'unauthorized')
      assert.ok(/USB 调试/.test(st.message), '未授权态必须给可操作的指引文案')
      svc.adb.invalidate()
      core.adb.devices = () => { const e = new Error('spawn adb ENOENT'); e.code = 'ENOENT'; throw e }
      assert.strictEqual(svc.adb.status().state, 'no-adb')
      svc.adb.invalidate()
      core.adb.devices = () => { throw new Error('adb: daemon crashed') }
      assert.strictEqual(svc.adb.status().state, 'error')
    } finally {
      core.adb.devices = origDevices
      svc.adb.invalidate()
    }
  })

  await t('dest: addPhone 全链路（stub adb）——路径归一/探测先行/持久化/不可用拒绝', () => {
    const file = path.join(tmpDir('destphone-'), 'destinations.json')
    const origStatus = svc.adb.status
    const origProbe = svc.adb.probeWritable
    const probed = []
    svc.dest._useFile(file)
    try {
      svc.adb.status = () => ({ state: 'ready', device: { serial: 'S', state: 'device', model: 'M' }, message: '设备已连接（M）' })
      svc.adb.probeWritable = (dir) => { probed.push(dir); return { ok: true } }
      // 多斜杠/尾斜杠归一成规范设备路径
      const d = svc.dest.addPhone('/sdcard//Music/')
      assert.strictEqual(d.kind, 'phone')
      assert.strictEqual(d.path, '/sdcard/Music')
      assert.deepStrictEqual(probed, ['/sdcard/Music'], '入列前必须先探测目录可写')
      assert.strictEqual(svc.dest.activeId(), d.id)
      // 持久化：丢弃缓存后从盘上读回
      svc.dest._useFile(file)
      assert.strictEqual(svc.dest.activeId(), d.id)
      // 归一后同路径幂等（不重复入列）：不带前导斜杠也归一到同一路径
      const again = svc.dest.addPhone('sdcard/Music')
      assert.strictEqual(again.id, d.id)
      assert.strictEqual(svc.dest.list().length, 1)
      // 设备不可用：拒绝且不入列
      svc.adb.status = () => ({ state: 'no-device', device: null, message: '未检测到已连接的设备' })
      assert.throws(() => svc.dest.addPhone('/sdcard/Music2'), /手机不可用/)
      // 设备根目录：拒绝（下载批次需要子目录归属）
      svc.adb.status = () => ({ state: 'ready', device: { serial: 'S', state: 'device' }, message: 'x' })
      assert.throws(() => svc.dest.addPhone('/'), /设备内的文件夹路径/)
      assert.strictEqual(svc.dest.list().length, 1, '失败的添加不得留下半条目')
    } finally {
      svc.adb.status = origStatus
      svc.adb.probeWritable = origProbe
      // 恢复到进程级测试配置文件（不是真实 destinations.json——保持整进程隔离）
      svc.dest._useFile(path.join(TEST_DOWNLOAD_DIR, 'destinations.json'))
      fs.rmSync(path.dirname(file), { recursive: true, force: true })
    }
  })

  await t('server: open-folder 目的地契约——缺省跟随激活目的地 / dest=default 显式回缺省 / phone 400', async () => {
    const serverMod = require('../server')
    const file = path.join(tmpDir('destopen-'), 'destinations.json')
    const origStatus = svc.adb.status
    const origProbe = svc.adb.probeWritable
    svc.dest._useFile(file)
    let srv = null
    try {
      svc.adb.status = () => ({ state: 'ready', device: { serial: 'S', state: 'device', model: 'M' }, message: 'x' })
      svc.adb.probeWritable = () => ({ ok: true })
      const phone = svc.dest.addPhone('/sdcard/Music')
      srv = serverMod.app.listen(0)
      await new Promise((r) => srv.on('listening', r))
      const base = `http://127.0.0.1:${srv.address().port}`
      // 激活手机目的地：缺省（不带 dest）跟随 → 电脑端打不开，400 给可懂文案
      const r1 = await fetch(`${base}/api/open-folder`)
      assert.strictEqual(r1.status, 400, `激活手机目的地时缺省 open-folder 应 400，实际 ${r1.status}`)
      assert.ok((await r1.json()).error.includes('手机'))
      // dest=default 显式指回缺省下载根：手机激活期间用户仍能打开电脑端默认目录
      const r2 = await (await fetch(`${base}/api/open-folder?dest=default`)).json()
      assert.strictEqual(r2.dir, TEST_DOWNLOAD_DIR)
      // 显式指定 phone 目的地 → 同样 400
      const r3 = await fetch(`${base}/api/open-folder?dest=${phone.id}`)
      assert.strictEqual(r3.status, 400)
      // 未知目的地 → 404（原有契约回归）
      assert.strictEqual((await fetch(`${base}/api/open-folder?dest=nope`)).status, 404)
    } finally {
      if (srv) await new Promise((r) => srv.close(r))
      svc.adb.status = origStatus
      svc.adb.probeWritable = origProbe
      svc.dest._useFile(path.join(TEST_DOWNLOAD_DIR, 'destinations.json'))
      fs.rmSync(path.dirname(file), { recursive: true, force: true })
    }
  })

  await t('dialog: pickFolder UTF-8 输出声明 + 取消/超时/PowerShell 缺失三路径（execFile 桩）', async () => {
    execFileStub.calls.length = 0
    // 正常路径：脚本必须声明 UTF-8 输出（中文系统 PS 5.1 默认 cp936，中文路径会乱码落盘）
    const p1 = core.dialog.pickFolder()
    const [cmd, args, opts, cb] = execFileStub.calls[execFileStub.calls.length - 1]
    assert.strictEqual(cmd, 'powershell.exe')
    assert.ok(args.includes('-NoProfile') && args.includes('-STA'), 'FolderBrowserDialog 需要 STA 线程')
    assert.ok(/OutputEncoding\s*=\s*\[System\.Text\.Encoding\]::UTF8/.test(args[args.length - 1]), 'PS 脚本必须声明 UTF-8 输出')
    assert.strictEqual(opts.timeout, 5 * 60 * 1000, '5 分钟无操作超时')
    cb(null, 'C:\\音乐\\下载\r\n', '')
    assert.strictEqual(await p1, 'C:\\音乐\\下载')
    // 用户取消：空输出 → null（不是报错）
    const p2 = core.dialog.pickFolder()
    execFileStub.calls[execFileStub.calls.length - 1][3](null, '', '')
    assert.strictEqual(await p2, null)
    // 超时：killed → 可读文案
    const p3 = core.dialog.pickFolder()
    const killed = new Error('killed'); killed.killed = true
    execFileStub.calls[execFileStub.calls.length - 1][3](killed, '', '')
    await assert.rejects(() => p3, /超时/)
    // PowerShell 缺失：ENOENT → noPowerShell 标记（门面据此回 500 而非 400）
    const p4 = core.dialog.pickFolder()
    const enoent = new Error('spawn powershell.exe ENOENT'); enoent.code = 'ENOENT'
    execFileStub.calls[execFileStub.calls.length - 1][3](enoent, '', '')
    await assert.rejects(() => p4, (e) => e.noPowerShell === true)
  })

  await t('download: 目标文件已在时不覆盖重下（只增不删，existed 记账 + 缺词仍补）', async () => {
    const origGetOne = svc.core.song.getOne
    const origResolve = core.url.resolve
    const dir = path.join(TEST_DOWNLOAD_DIR, `noover-${Date.now()}`)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, '晴天.mp3'), 'OLD-CONTENT')
    try {
      svc.core.song.getOne = async () => ({ id: 1, name: '晴天', artist: '周杰伦', album: '', picUrl: 'http://ex/p.jpg', duration: 0 })
      core.url.resolve = async () => ({ url: 'http://127.0.0.1:1/f.mp3', br: 320000, size: 11, level: 'exhigh', ext: 'mp3' })
      const r = await svc.download.download(1, { dir, br: 320, cover: false })
      assert.strictEqual(r.existed, true, '已存在的目标文件应记 existed')
      assert.strictEqual(fs.readFileSync(path.join(dir, '晴天.mp3'), 'utf8'), 'OLD-CONTENT', '已有文件不得被覆盖重下')
      assert.strictEqual(r.size, 'OLD-CONTENT'.length, 'existed 记账取磁盘实际大小')
      assert.ok(!r.filepath.endsWith('.part'), '不得触碰半成品路径')
    } finally {
      svc.core.song.getOne = origGetOne
      core.url.resolve = origResolve
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  // ---- 本轮加固回归：进度计数 / 手机断连容错 / 运行日志 ----

  await t('job: processed 真实计数（跳过+逐首回调各计一次），终态瘦身截日志后仍在', async () => {
    // 桩掉 downloadMany（job.js 持模块对象引用，属性替换可见）：两首都走 onFile
    const origMany = svc.download.downloadMany
    const origRun = svc.incremental.run
    try {
      svc.download.downloadMany = async (songs, opts) => {
        for (const s of songs) opts.onFile({ ok: true, filepath: `X:/${s.name}.mp3` }, s)
        return songs.map((s) => ({ ok: true, filepath: `X:/${s.name}.mp3`, song: s }))
      }
      // 无 plan：processed = onFile 次数
      const id1 = svc.job.startJob('计数A', [{ id: 1, name: '甲' }, { id: 2, name: '乙' }], { dir: path.join(TEST_DOWNLOAD_DIR, 'jobA'), br: 320, cover: false })
      await until(() => (svc.job.jobs.get(id1) || {}).status === 'done' || (svc.job.jobs.get(id1) || {}).status === 'error')
      const j1 = svc.job.jobs.get(id1)
      assert.strictEqual(j1.status, 'done')
      assert.strictEqual(j1.processed, 2, `processed 应为 2，实际 ${j1.processed}`)
      assert.strictEqual(svc.job.slimJob(j1).processed, 2, '终态瘦身截日志后 processed 必须保留（进度条依赖它）')
      // 有 plan：skipped 先计数 + download 的 onFile 计数（incremental.run 桩掉真跑，但照常调 onFile）
      svc.incremental.run = async (plan, opts, cbs) => {
        if (cbs && cbs.onFile && plan.download[0]) cbs.onFile({ ok: true, filepath: 'X:/丙.mp3' }, plan.download[0])
        return { results: [{ ok: true, filepath: 'X:/丙.mp3' }], fillResults: [] }
      }
      const id2 = svc.job.startJob('计数B', [{ id: 3, name: '丙' }], { dir: path.join(TEST_DOWNLOAD_DIR, 'jobB'), br: 320, plan: { skipped: [{ id: 9, name: '旧歌' }], download: [{ id: 3, name: '丙' }], fill: [], bases: new Map(), lyricsFor: new Set() } })
      await until(() => (svc.job.jobs.get(id2) || {}).status === 'done' || (svc.job.jobs.get(id2) || {}).status === 'error')
      assert.strictEqual(svc.job.jobs.get(id2).processed, 2, 'skipped 1 + onFile 1 = 2')
    } finally {
      svc.download.downloadMany = origMany
      svc.incremental.run = origRun
    }
  })

  await t('job: createTask 手机目的地建任务全链路（TDZ 回归：dir 不得困在 try 块作用域里）', async () => {
    // 曾经的回归：对账 try/catch 把 let dir 圈进块作用域，try 外 startJob 引用的变成后面
    // local 分支的同名 let —— "Cannot access 'dir' before initialization"，手机建任务必炸。
    // 此前单测只直调 startJob，漏了这条门面链路——本用例必须走完整 createTask
    const file = path.join(TEST_DOWNLOAD_DIR, `dest-phone-${Date.now()}.json`)
    const origGetDetail = core.song.getDetail
    const origStatus = svc.adb.status
    const origInvalidate = svc.adb.invalidate
    const origPrims = { pushBuffer: core.adb.pushBuffer, listDirs: core.adb.listDirs, listFiles: core.adb.listFiles, readText: core.adb.readText, mkdirP: core.adb.mkdirP, rm: core.adb.rm }
    const origMany = svc.phone.downloadMany
    svc.adb.status = () => ({ state: 'ready', device: { serial: 'S', state: 'device', model: 'TEST' }, message: 'x' })
    svc.adb.invalidate = () => {}
    core.adb.pushBuffer = () => {}
    core.adb.listDirs = () => []
    core.adb.listFiles = () => []
    core.adb.readText = () => 'ok' // probeWritable 读回探针
    core.adb.mkdirP = () => {}
    core.adb.rm = () => {}
    svc.phone.downloadMany = async (songs) => songs.map((s) => ({ ok: true, filepath: `/sdcard/Music/x/${s.name}.mp3`, song: s }))
    try {
      svc.dest._useFile(file)
      const d = svc.dest.addPhone('/sdcard/Music')
      svc.dest.setActive(d.id)
      core.song.getDetail = async () => [{ id: 1, name: '甲', artist: 'A' }]
      const r = await svc.job.createTask({ source: 'songs', ids: '1', br: 320 }, { downloadDir: 'X:\\default' })
      assert.strictEqual(r.code, 200, `手机建任务应成功（TDZ 回归），实际 ${r.code} ${JSON.stringify(r.body)}`)
      const j = svc.job.jobs.get(r.body.jobId)
      await until(() => j.status === 'done' || j.status === 'error')
      assert.strictEqual(j.status, 'done', `任务应正常跑完，实际 ${j.status}: ${j.error || ''}`)
      assert.strictEqual(j.destKind, 'phone', '任务目的地必须是 phone（否则用例没打到目标分支）')
    } finally {
      core.song.getDetail = origGetDetail
      svc.adb.status = origStatus
      svc.adb.invalidate = origInvalidate
      Object.assign(core.adb, origPrims)
      svc.phone.downloadMany = origMany
      svc.dest._useFile(path.join(TEST_DOWNLOAD_DIR, 'destinations.json'))
      fs.rmSync(file, { force: true })
      svc.adb.invalidate()
    }
  })

  await t('phone: pushToDevice 三路径——断触自愈重推 / 设备真掉中止 / 非设备错误不重试', async () => {
    const origPush = core.adb.pushBuffer
    const origStatus = svc.adb.status
    const origInvalidate = svc.adb.invalidate
    const origTuning = { ...svc.phone._tuning }
    svc.phone._tuning.graceMs = 40   // 缩短宽限：用例毫秒级
    svc.phone._tuning.rounds = 1
    svc.adb.invalidate = () => {}    // 探测缓存失效变空操作（status 桩自己控制状态）
    const buf = Buffer.from('ab')
    try {
      // 路径 A（USB 断触自愈）：首推报 device not found → 宽限内设备回来 → 重推成功
      let pushCalls = 0
      core.adb.pushBuffer = (b, p) => { pushCalls++; if (pushCalls === 1) throw new Error("error: device 'S' not found") }
      svc.adb.status = () => ({ state: 'ready', device: { serial: 'S', state: 'device' }, message: 'x' })
      await svc.phone.pushToDevice(buf, '/sdcard/Music/a.mp3')
      assert.strictEqual(pushCalls, 2, '自愈路径应恰好重推一次')
      // 路径 B（设备真掉）：宽限轮询始终不在线 → 宽限耗尽即中止（设备没回来就不盲目重推）
      pushCalls = 0
      core.adb.pushBuffer = () => { pushCalls++; throw new Error('error: device offline') }
      svc.adb.status = () => ({ state: 'no-device', device: null, message: '未检测到已连接的设备' })
      let err = null
      try { await svc.phone.pushToDevice(buf, '/sdcard/Music/b.mp3') } catch (e) { err = e }
      assert.ok(err && err.deviceGone, '设备真掉必须抛 deviceGone')
      assert.ok(/手机已断开/.test(err.message), `文案异常: ${err.message}`)
      assert.strictEqual(pushCalls, 1, `设备未恢复不得重推（否则空推无意义），实际 ${pushCalls} 次`)
      // 路径 C（md5 传输损坏）：buffer 还在内存，重推零成本
      pushCalls = 0
      core.adb.pushBuffer = () => { pushCalls++; if (pushCalls === 1) throw new Error('远端 md5 校验不符（传输损坏），半成品已删除') }
      svc.adb.status = () => ({ state: 'ready', device: { serial: 'S', state: 'device' }, message: 'x' })
      await svc.phone.pushToDevice(buf, '/sdcard/Music/c.mp3')
      assert.strictEqual(pushCalls, 2, 'md5 不符应重推一次')
      // 路径 D（非设备错误）：终态不重试，立即上抛
      pushCalls = 0
      core.adb.pushBuffer = () => { pushCalls++; throw new Error('设备端写入失败: 磁盘已满') }
      err = null
      try { await svc.phone.pushToDevice(buf, '/sdcard/Music/d.mp3') } catch (e) { err = e }
      assert.ok(err && !err.deviceGone && /磁盘已满/.test(err.message))
      assert.strictEqual(pushCalls, 1, '非设备类错误不得重试')
      // 路径 E（传输停滞型断连）：spawnSync 层错误带 deviceSuspect 标记（文案不在设备正则里）
      // → 视为断连征兆给恢复宽限；设备回来则重推成功
      pushCalls = 0
      core.adb.pushBuffer = () => {
        pushCalls++
        if (pushCalls === 1) { const e = new Error('spawnSync adb ETIMEDOUT'); e.deviceSuspect = true; throw e }
      }
      svc.adb.status = () => ({ state: 'ready', device: { serial: 'S', state: 'device' }, message: 'x' })
      await svc.phone.pushToDevice(buf, '/sdcard/Music/e.mp3')
      assert.strictEqual(pushCalls, 2, 'deviceSuspect 标记应触发宽限重推')
      // 对照：没有标记的同文案错误仍是终态（标记只由 core/adb 在可靠判据下打）
      pushCalls = 0
      core.adb.pushBuffer = () => { pushCalls++; throw new Error('spawnSync adb ETIMEDOUT') }
      err = null
      try { await svc.phone.pushToDevice(buf, '/sdcard/Music/f.mp3') } catch (e) { err = e }
      assert.ok(err && !err.deviceGone && pushCalls === 1, '无标记不得重试')
    } finally {
      core.adb.pushBuffer = origPush
      svc.adb.status = origStatus
      svc.adb.invalidate = origInvalidate
      Object.assign(svc.phone._tuning, origTuning)
    }
  })

  await t('phone: downloadMany 设备断连中止整批（不再逐首空转）+ fillLyric 设备中止上抛', async () => {
    const origResolve = core.url.resolve
    const origFetch = global.fetch
    const origPush = core.adb.pushBuffer
    const origListFiles = core.adb.listFiles
    const origReadText = core.adb.readText
    const origMkdirP = core.adb.mkdirP
    const origStatus = svc.adb.status
    const origInvalidate = svc.adb.invalidate
    const origLyricGet = core.lyric.get
    const origTuning = { ...svc.phone._tuning }
    svc.phone._tuning.graceMs = 40
    svc.phone._tuning.rounds = 1
    svc.adb.invalidate = () => {}
    // 序列桩：批次开头的预检查时设备在线（真实断连场景 = 中途拔线），此后一直不在线
    let statusCalls = 0
    svc.adb.status = () => (++statusCalls === 1
      ? { state: 'ready', device: { serial: 'S', state: 'device' }, message: 'x' }
      : { state: 'no-device', device: null, message: '未检测到已连接的设备' })
    core.adb.pushBuffer = () => { throw new Error('error: device offline') }
    // scanDir/索引读回必须隔离（本机插着真机——不 stub 会打到真实设备）
    core.adb.listFiles = () => []
    core.adb.readText = () => { throw new Error('No such file') }
    core.adb.mkdirP = () => {}
    core.url.resolve = async () => ({ url: 'http://stub/1.mp3', br: 320000, size: 2, level: 'exhigh', ext: 'mp3' })
    // 假音频流：取流阶段本地完成（不碰网络），失败点落在设备推送
    global.fetch = async () => new Response(Buffer.from('ab'), { status: 200, headers: { 'content-length': '2' } })
    core.lyric.get = async () => ({ lrc: '[00:01]x', tlyric: '' })
    try {
      const songs = [{ id: 1, name: '甲', artist: 'A' }, { id: 2, name: '乙', artist: 'B' }]
      let err = null
      let seen = 0
      try {
        await svc.phone.downloadMany(songs, { dir: '/sdcard/Music/T [1]', br: 320, cover: false, onFile: () => seen++ })
      } catch (e) { err = e }
      assert.ok(err && err.deviceGone, 'downloadMany 必须把 deviceGone 上抛中止整批')
      assert.ok(/手机已断开/.test(err.message))
      assert.strictEqual(seen, 1, '只有第一首记失败，第二首不得再走取流空转')
      // fillLyric：设备断连上抛（否则整份 fill 列表逐首各等一轮宽限）
      err = null
      try { await svc.phone.fillLyric({ id: 1, name: '甲' }, '/sdcard/Music/T [1]', '甲') } catch (e) { err = e }
      assert.ok(err && err.deviceGone, 'fillLyric 遇设备断连必须上抛')
      // 对照：普通歌词失败仍吞掉返回失败结果（不中止批次）
      svc.adb.status = () => ({ state: 'ready', device: { serial: 'S', state: 'device' }, message: 'x' })
      core.adb.pushBuffer = () => { throw new Error('设备端写入失败: exit 1') }
      const r = await svc.phone.fillLyric({ id: 1, name: '甲' }, '/sdcard/Music/T [1]', '甲')
      assert.strictEqual(r.ok, false)
      assert.ok(r.error, '普通失败照旧返回结果对象')
    } finally {
      core.url.resolve = origResolve
      global.fetch = origFetch
      core.adb.pushBuffer = origPush
      core.adb.listFiles = origListFiles
      core.adb.readText = origReadText
      core.adb.mkdirP = origMkdirP
      svc.adb.status = origStatus
      svc.adb.invalidate = origInvalidate
      core.lyric.get = origLyricGet
      Object.assign(svc.phone._tuning, origTuning)
    }
  })

  await t('download: assignBaseNames claimedPreseed——id 命中的 "(n)" 历史 base 不被字面同名新歌抢走', () => {
    const { assignBaseNames } = svc.download
    const newcomer = { id: 2, name: '晴天 (2)', artist: 'X' }
    // 场景：磁盘上有 "晴天 (2)" 文件，但它其实是 id 1 那首歌的历史命名（override base）。
    // 新歌字面名恰同：无预置时会在认领阶段抢走它（误判"已存在"永久跳过）；预置 claimed 后必须避让
    const taken = new Set(['晴天 (2)'])
    const m = assignBaseNames([newcomer], taken, taken)
    assert.strictEqual(m.get(newcomer), '晴天 (2) - X', '预置 base 只许避让不许认领，新歌应拿带歌手的新名')
    // 对照：不传预置时旧口径仍认领（向后兼容，行为锁定）
    const m2 = assignBaseNames([newcomer], new Set(['晴天 (2)']))
    assert.strictEqual(m2.get(newcomer), '晴天 (2)')
  })

  await t('job: fm/simi 数量上限（>MAX_RECOMMEND_TOTAL 提前 400，不进取曲链路白烧请求）', async () => {
    const over = await svc.job.createTask({ source: 'fm', total: svc.job.MAX_RECOMMEND_TOTAL + 1 }, { downloadDir: 'X:\\d' })
    assert.strictEqual(over.code, 400, `超上限应 400，实际 ${over.code}`)
    assert.ok(/数量过大/.test(over.body.error), `文案应提示分批: ${over.body.error}`)
    const simi = await svc.job.createTask({ source: 'simi', id: '1', total: 99999 }, { downloadDir: 'X:\\d' })
    assert.strictEqual(simi.code, 400)
    assert.ok(/数量过大/.test(simi.body.error))
  })

  await t('login: 803 未带 cookie 不得覆盖现有登录态（抛错保留，正常 803 照常保存）', async () => {
    const origCheckQr = core.login.checkQr
    const origSave = core.cookie.save
    const origGet = core.cookie.get
    const saved = []
    try {
      core.cookie.save = (c) => saved.push(c)
      core.cookie.get = () => 'MUSIC_U=KEEP'
      core.login.checkQr = async () => ({ code: 803, cookie: '' })
      let err = null
      try { await svc.login.pollQr('k', { timeout: 5000 }) } catch (e) { err = e }
      assert.ok(err && /登录响应异常/.test(err.message), `应抛"登录响应异常": ${err && err.message}`)
      assert.deepStrictEqual(saved, [], '空 cookie 绝不得落盘覆盖好 cookie')
      // 正常 803（带 cookie）仍照常保存
      core.login.checkQr = async () => ({ code: 803, cookie: 'MUSIC_U=NEW' })
      const c = await svc.login.pollQr('k', { timeout: 5000 })
      assert.deepStrictEqual(saved, ['MUSIC_U=NEW'])
      assert.strictEqual(c, 'MUSIC_U=KEEP')
    } finally {
      core.login.checkQr = origCheckQr
      core.cookie.save = origSave
      core.cookie.get = origGet
    }
  })

  await t('server: /api/jobs 保运行任务不被终端态挤出列表（running 全量入列，终端补足到 20）', async () => {
    const serverMod = require('../server')
    const { jobs } = serverMod._internals
    const savedJobs = [...jobs.entries()]
    jobs.clear()
    const mk = (id, status) => ({
      id, label: `假${id}`, folder: '', batchKey: '', status, cancelled: false,
      log: ['行'], result: null, error: null, total: 1,
      // startedAt 用 id 数值造新旧差：running(900) 比全部 done(801~825) 更旧——
      // 旧口径按 startedAt 一刀切 slice(0,20) 时它恰好被挤出，本用例锁的就是这个回归
      startedAt: Date.now() - Number(id), handle: { cancel() {}, signal: {} },
    })
    try {
      jobs.set('900', mk('900', 'running'))
      for (let i = 1; i <= 25; i++) jobs.set(String(800 + i), mk(String(800 + i), 'done'))
      const srv = serverMod.app.listen(0)
      await new Promise((r) => srv.on('listening', r))
      const base = `http://127.0.0.1:${srv.address().port}`
      try {
        const list = await (await fetch(`${base}/api/jobs`)).json()
        assert.ok(list.some((j) => j.id === '900'), 'running 任务不得被挤出列表（进度/取消入口必须保留）')
        assert.strictEqual(list.length, 20, `running 全量 + 终端补足到 20，实际 ${list.length}`)
        assert.ok(list.every((j) => j.status === 'running' || j.status === 'done'), '不得混入未注入的状态')
      } finally { await new Promise((r) => srv.close(r)) }
    } finally {
      jobs.clear()
      for (const [k, v] of savedJobs) jobs.set(k, v)
    }
  })

  await t('phone: CDN 透明压缩（content-encoding）时跳过截断/大小断言——两管线同守卫', async () => {
    // 场景：响应带 content-encoding（如 gzip），content-length 是压缩字节数、实收是解压后
    // 字节数，两者必然不等——无守卫时手机管线会把正常文件逐首误判"下载截断"终态失败
    const origResolve = core.url.resolve
    const origFetch = global.fetch
    const origPush = core.adb.pushBuffer
    const origListFiles = core.adb.listFiles
    const origReadText = core.adb.readText
    const origMkdirP2 = core.adb.mkdirP
    const origStatus = svc.adb.status
    const origInvalidate = svc.adb.invalidate
    const origLyricGet = core.lyric.get
    svc.adb.invalidate = () => {}
    svc.adb.status = () => ({ state: 'ready', device: { serial: 'S', state: 'device' }, message: 'x' })
    core.adb.pushBuffer = () => {}
    core.adb.listFiles = () => []
    core.adb.readText = () => { throw new Error('No such file') }
    core.adb.mkdirP = () => {}
    core.url.resolve = async () => ({ url: 'http://stub/1.mp3', br: 320000, size: 2, level: 'exhigh', ext: 'mp3' })
    // content-length: 2 与实收 3B 故意不符 + content-encoding: gzip——无守卫必抛"截断/大小异常"
    global.fetch = async () => new Response(Buffer.from('abc'), {
      status: 200,
      headers: { 'content-length': '2', 'content-encoding': 'gzip' },
    })
    core.lyric.get = async () => ({ lrc: '[00:01]x', tlyric: '' })
    try {
      const results = await svc.phone.downloadMany([{ id: 1, name: '甲', artist: 'A' }], { dir: '/sdcard/Music/E [1]', br: 320, cover: false })
      assert.strictEqual(results.length, 1)
      assert.strictEqual(results[0].ok, true, `压缩响应不得误判截断/大小异常: ${results[0].error || ''}`)
      assert.ok(results[0].size >= 3, '音频字节应完整进入打标签流程（size 为打标签后长度）')
    } finally {
      core.url.resolve = origResolve
      global.fetch = origFetch
      core.adb.pushBuffer = origPush
      core.adb.listFiles = origListFiles
      core.adb.readText = origReadText
      svc.adb.status = origStatus
      svc.adb.invalidate = origInvalidate
      core.lyric.get = origLyricGet
      core.adb.mkdirP = origMkdirP2
    }
  })

  await t('logger: 双写落盘（行格式/时间戳），失败静默不抛', () => {
    // 落盘指向临时路径：真实 logs/service.log 归运行中的服务，测试不得读写/删除它
    const tmpLog = path.join(TEST_DOWNLOAD_DIR, 'test-service.log')
    svc.logger._useFile(tmpLog)
    try {
      svc.logger.log('test', '写入一行')
      svc.logger.error('test', '错误一行')
      const text = fs.readFileSync(tmpLog, 'utf8')
      const lines = text.trim().split('\n')
      assert.ok(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} \[info\] test 写入一行/.test(lines[0]), `行格式异常: ${lines[0]}`)
      assert.ok(/\[error\] test 错误一行/.test(lines[lines.length - 1]))
    } finally {
      // 还原到本套件的临时日志（此前还原到真实 logs/service.log，会让后续用例重新污染生产日志）
      svc.logger._useFile(path.join(TEST_DOWNLOAD_DIR, 'service.log'))
    }
  })

  // ================= 本轮加固的回归锁 =================
  // 下面每一条都对应一个"已确认存在、且现有用例覆盖不到"的缺陷。
  // 没有它们，下一次重构就能把同一条路悄悄走回去而不被发现。

  await t('error: isTransient 把环境故障/传输停滞判为终态（不再白重试）', () => {
    // adb 未装：重试装不上它；deviceSuspect（USB 半死/adb 挂死）：背靠背重跑同一条命令
    // 设备还没重新枚举，必然再失败。断连的恢复逻辑在 service/phone 的宽限重推里，不在这里
    assert.strictEqual(core.error.isTransient(Object.assign(new Error('未找到 adb 可执行文件'), { noAdb: true })), false)
    assert.strictEqual(core.error.isTransient(Object.assign(new Error('adb 异常退出（exit 1，无任何输出）'), { deviceSuspect: true })), false)
    // 对照：普通超时/连接重置仍须是瞬时（不能一起误伤）
    assert.strictEqual(core.error.isTransient(Object.assign(new Error('x'), { name: 'TimeoutError' })), true)
    assert.strictEqual(core.error.isTransient(Object.assign(new Error('x'), { code: 'ECONNRESET' })), true)
    // 循环引用的 body 不得让错误文案/分级自己抛掉（JSON.stringify 遇环会 TypeError）
    const cyc = { status: 500, body: { msg: 'x' } }
    cyc.body.self = cyc
    assert.ok(typeof core.error.errMsg(cyc) === 'string' && core.error.errMsg(cyc).length > 0)
    assert.strictEqual(core.error.isTransient(cyc), true)
  })

  await t('retry: shouldRetry 自身抛错不得顶掉真实错误（fail-open）', async () => {
    let calls = 0
    const real = new Error('真实的网络失败')
    let got = null
    try {
      await core.retry.withRetry(async () => { calls++; throw real }, {
        retries: 2, backoffMs: 0,
        shouldRetry: () => { throw new Error('判定器自己炸了') },
      })
    } catch (e) { got = e }
    // 判定器坏掉时按"值得重试"兜底；无论重试几次，冒泡的必须是原始错误而不是判定器的错误
    assert.strictEqual(got, real, `冒泡的应是原始错误，实际: ${got && got.message}`)
    assert.ok(calls >= 2, '判定器抛错时按可重试兜底，应至少尝试 2 次')
  })

  await t('util.mergeSignals: 任一信号触发即中断（旧版 Node 无 AbortSignal.any 时的等价物）', async () => {
    const a = new AbortController()
    const b = new AbortController()
    const s = svc.utilMergeSignalsForTest || require('../src/service/util').mergeSignals
    const merged = s(a.signal, b.signal)
    assert.strictEqual(merged.aborted, false)
    b.abort()
    assert.strictEqual(merged.aborted, true, '超时侧触发应连带中断合并信号')
    // 已中止的一侧要立刻生效（不等另一个）
    const c = new AbortController(); c.abort()
    const d = new AbortController()
    assert.strictEqual(s(c.signal, d.signal).aborted, true, '传入已中止信号应立即为中止态')
    // 单侧/空侧的退化形态
    assert.strictEqual(s(null, b.signal), b.signal)
    assert.strictEqual(s(a.signal, null), a.signal)
  })

  await t('tag: embedFlacBuf 拒绝"块链后无音频帧"的废文件', () => {
    // 构造 fLaC + STREAMINFO(last)，块链结束即 EOF：魔数合法、块边界合法，
    // 但产物会是"元数据完好、整首无声"。过去 verifyAudioHead/verifyFile 只看 fLaC 头，拦不住，
    // 而增量对账按文件名认领 → 这首坏文件被永久跳过
    const u24 = (n) => Buffer.from([(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff])
    const streaminfo = Buffer.alloc(34)
    const header = Buffer.from([0x80 | 0]) // STREAMINFO 且为末块
    const noAudio = Buffer.concat([Buffer.from('fLaC', 'ascii'), header, u24(34), streaminfo])
    assert.throws(() => core.tag.embedFlacBuf(noAudio, { title: 'x', artist: 'y' }), /结构异常/,
      '块链后无音频帧必须抛结构异常（终态、不重试），不得产出无声文件')
    // 对照：块链后有真音频帧时正常产出
    const withAudio = Buffer.concat([noAudio, Buffer.from([0xff, 0xf8, 0x00, 0x00])])
    const out = core.tag.embedFlacBuf(withAudio, { title: 'x', artist: 'y' })
    assert.ok(out.length > withAudio.length, '合法输入应产出更长的 buffer（多出标签块）')
  })

  await t('tag: verifyMp3/verifyFlac 对截断输入返回判定对象而不是抛 RangeError', () => {
    const dir = tmpDir('ncm-tagb-')
    try {
      // ID3v2.3 头声称 size=4，实际只有帧 ID（4 字节）——读帧长需要 pos+8，越界
      const mp3 = path.join(dir, 'bad.mp3')
      fs.writeFileSync(mp3, Buffer.concat([Buffer.from('ID3', 'ascii'), Buffer.from([3, 0, 0]), Buffer.from([0, 0, 0, 4]), Buffer.from('TIT2', 'ascii')]))
      const r1 = core.tag.verifyMp3(mp3)
      assert.ok(r1 && r1.ok === false, `应返回判定对象，实际: ${JSON.stringify(r1)}`)
      // FLAC 在块头中间被截断（剩 1~2 字节）时 readUIntBE 会抛
      const flac = path.join(dir, 'bad.flac')
      const si = Buffer.alloc(34)
      const block = Buffer.concat([Buffer.from([0x00]), Buffer.from([0, 0, 34]), si])
      fs.writeFileSync(flac, Buffer.concat([Buffer.from('fLaC', 'ascii'), block, Buffer.from([0x84, 0x00])]))
      const r2 = core.tag.verifyFlac(flac)
      assert.ok(r2 && r2.ok === false, `应返回判定对象，实际: ${JSON.stringify(r2)}`)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  await t('tag: FLAC 标签不得写入字面量 undefined（与 MP3 同口径）', () => {
    const u24 = (n) => Buffer.from([(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff])
    // STREAMINFO 必须是**末块**（头字节 0x80|0），否则块链解析会继续往下读、把这几个音频字节当块头
    const raw = Buffer.concat([
      Buffer.from('fLaC', 'ascii'), Buffer.from([0x80]), u24(34), Buffer.alloc(34),
      Buffer.from([0xff, 0xf8, 0x00, 0x00]),
    ])
    const out = core.tag.embedFlacBuf(raw, {})
    assert.ok(!out.includes(Buffer.from('TITLE=undefined')), 'TITLE 不得是字面量 undefined')
    assert.ok(!out.includes(Buffer.from('ARTIST=undefined')), 'ARTIST 不得是字面量 undefined')
  })

  await t('download: 歌词走原子替换（.part + rename），不留半截 .lrc', async () => {
    const origLyric = core.lyric.get
    const dir = tmpDir('ncm-lrc-')
    try {
      core.lyric.get = async () => ({ lrc: '[00:01.00]第一行\n[00:02.00]第二行', tlyric: '' })
      const target = path.join(dir, '歌.lrc')
      const got = await svc.download.saveLyric(123, target)
      assert.strictEqual(got, target)
      assert.ok(fs.readFileSync(target, 'utf8').includes('第二行'))
      assert.deepStrictEqual(fs.readdirSync(dir), ['歌.lrc'], '目录里只应有最终 .lrc，不得残留 .part')
      // 无歌词时返回 null 且不落任何文件（不留 0 字节 .lrc——scanDir 会把它当成"词已齐全"永久跳过）
      core.lyric.get = async () => ({ lrc: '', tlyric: '' })
      const empty = path.join(dir, '空.lrc')
      assert.strictEqual(await svc.download.saveLyric(124, empty), null)
      assert.ok(!fs.existsSync(empty), '无歌词不得创建空 .lrc')
    } finally {
      core.lyric.get = origLyric
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  await t('download: content-encoding 存在时外层二次校验也必须跳过（本地管线与手机管线同守）', () => {
    // 完整性断言（截断/大小双口径）已收敛到 util.assertIntegrity——两条管线共用一份，
    // 守卫只需存在且 encoded 分支正确，任何一侧都不再有独立实现可分叉。
    // 行为级验证另有专项用例（手机管线 CDN 透明压缩 + 本地管线截断/大小异常双口径）
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'service', 'util.js'), 'utf8')
    const guard = src.match(/if \(!encoded && declared > 0 && got !== declared\)/)
    assert.ok(guard, 'assertIntegrity 的截断断言必须带 !encoded 守卫')
    assert.ok(/if \(!encoded && want > 0\)/.test(src), 'assertIntegrity 的大小断言必须带 !encoded 守卫')
    // 两条管线都必须经由 assertIntegrity 校验（不得有人旁路出独立断言）
    assert.ok(/assertIntegrity\(/.test(fs.readFileSync(path.join(__dirname, '..', 'src', 'service', 'download.js'), 'utf8')),
      '本地管线必须调用 assertIntegrity')
    assert.ok(/assertIntegrity\(/.test(fs.readFileSync(path.join(__dirname, '..', 'src', 'service', 'phone.js'), 'utf8')),
      '手机管线必须调用 assertIntegrity')
  })

  await t('storage: 批次标记不可读/格式非法时不再认领（防跨来源误跳）', () => {
    const base = tmpDir('ncm-mk-')
    try {
      const dir = svc.storage.createBatchDir(base, '同名歌单', 'playlist', '7')
      // 标记被外部写坏（截断 JSON）：旧口径当"旧版本产物"认领，
      // 于是 chart/timestamp 同名目录也会被歌单认领 → 歌被误判"已存在"永久跳过
      fs.writeFileSync(path.join(dir, '.ncm-batch.json'), '{截断')
      assert.strictEqual(svc.storage.findBatchDir(base, '同名歌单', 'playlist', '7'), null, '坏标记必须不认领')
      // 合法 JSON 但不是对象
      fs.writeFileSync(path.join(dir, '.ncm-batch.json'), '"null"')
      assert.strictEqual(svc.storage.findBatchDir(base, '同名歌单', 'playlist', '7'), null, '非对象标记必须不认领')
      // 标记文件不存在 = 旧版本产物，仍要向后兼容认领
      fs.unlinkSync(path.join(dir, '.ncm-batch.json'))
      assert.strictEqual(svc.storage.findBatchDir(base, '同名歌单', 'playlist', '7'), dir, '无标记的老目录仍须认领')
    } finally { fs.rmSync(base, { recursive: true, force: true }) }
  })

  await t('storage: 索引里的基础名也要过清洗（索引是唯一"被读取"的命名输入）', () => {
    const base = tmpDir('ncm-idx-')
    try {
      const dir = svc.storage.createBatchDir(base, 'B', 'playlist', '1')
      fs.writeFileSync(path.join(dir, '.ncm-index.json'), JSON.stringify({ 1: 'nul', 2: 'a/b', 3: '正常歌名', 4: '' }))
      const m = svc.storage.readIndexFile(dir)
      assert.strictEqual(m.get('1'), '_nul', '保留设备名须被清洗加前缀，否则 path.join 会打在 NUL 设备上')
      assert.strictEqual(m.get('2'), 'a_b', '分隔符须被替换，否则会越出批次目录')
      assert.strictEqual(m.get('3'), '正常歌名', '合法名原样保留')
      assert.ok(!m.has('4'), '清洗后为空的名字必须丢弃')
    } finally { fs.rmSync(base, { recursive: true, force: true }) }
  })

  await t('storage: mergeIndexFile 临时名唯一（同目录并发写不互抢）', () => {
    const base = tmpDir('ncm-idx2-')
    try {
      const dir = svc.storage.createBatchDir(base, 'B', 'playlist', '1')
      svc.storage.mergeIndexFile(dir, [['1', 'a']])
      svc.storage.mergeIndexFile(dir, [['2', 'b']])
      const leftovers = fs.readdirSync(dir).filter((f) => /\.tmp$/.test(f))
      assert.deepStrictEqual(leftovers, [], `不得残留索引临时文件: ${leftovers.join(',')}`)
      const m = svc.storage.readIndexFile(dir)
      assert.strictEqual(m.get('1'), 'a')
      assert.strictEqual(m.get('2'), 'b')
    } finally { fs.rmSync(base, { recursive: true, force: true }) }
  })

  await t('job: 取消与失败同样落批次报告与汇总（半途而废也可事后核对）', async () => {
    const origMany = svc.download.downloadMany
    const origWrite = svc.storage.writeBatchReport
    const dir = tmpDir('ncm-cancel-')
    try {
      // 队列是全局串行的：先确保上一批已排空，否则本任务的等待会被别人的任务吃掉
      await until(() => !svc.job.jobQueue.active && svc.job.jobQueue.pending === 0, 8000)
      // 无 plan 任务走 download.downloadMany（本次刻意不打桩 plan）：
      // 抛 AbortError 并带上部分结果 = "下了 1 首后被取消"的真实形态
      svc.download.downloadMany = async () => {
        throw Object.assign(new Error('任务已取消'), {
          name: 'AbortError',
          partialResults: [{ ok: true, filepath: path.join(dir, '甲.mp3') }],
        })
      }
      svc.storage.writeBatchReport = (d, o) => { svc.storage.__lastReport = { d, o }; return true }
      const songs = [{ id: '1', name: '甲', artist: 'A', album: 'B', picUrl: '', picId: 'p' },
        { id: '2', name: '乙', artist: 'A', album: 'B', picUrl: '', picId: 'p' }]
      const id = svc.job.startJob('取消测试', songs, { dir, br: 2000, destKind: 'local' })
      const job = svc.job.jobs.get(id)
      await until(() => job.status === 'cancelled' || job.status === 'error' || job.status === 'done', 8000)
      assert.notStrictEqual(job.status, 'running', '任务必须走到终态')
      // signal 未 abort 时不能被当成"用户取消"——否则错误被吞成 cancelled，事后再也查不到原因
      assert.strictEqual(job.status, 'error', `未 abort 的 AbortError 应按失败收口，实际 ${job.status}`)
      assert.ok(job.result, '失败也必须给出汇总（此前直接 return，job.result 为 null）')
      assert.ok(svc.storage.__lastReport, '失败也必须落 下载结果.txt（此前完全没有）')
      assert.strictEqual(svc.storage.__lastReport.d, dir)
      assert.strictEqual(svc.storage.__lastReport.o.summary.ok, 1, '部分结果（已下的那首）必须被计入')
      svc.job.jobs.delete(id)
    } finally {
      svc.download.downloadMany = origMany
      svc.storage.writeBatchReport = origWrite
      delete svc.storage.__lastReport
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  await t('job: startJob 缺 opts 时不得卡在 running（曾永久占住 batchKey）', async () => {
    await until(() => !svc.job.jobQueue.active && svc.job.jobQueue.pending === 0, 8000)
    const origMany = svc.download.downloadMany
    // 兜底桩：缺 opts 时会在取到管线之前就抛错，这里只是防止万一走到下载而真的发网络请求
    svc.download.downloadMany = async () => []
    // startJob 是公开导出（svc.job.startJob）；opts 为 undefined 时，
    // 唯一的裸解引用若发生在 try 外会被队列 catch 吞掉 → 任务永远 running、
    // 进不了驱逐列表、还会被 findDup 按 batchKey 认领
    const songs = [{ id: '9', name: 'x', artist: 'a', album: 'b', picUrl: '', picId: 'p' }]
    const id = svc.job.startJob('缺opts', songs)
    const job = svc.job.jobs.get(id)
    await until(() => job.status !== 'running' && job.status !== 'queued', 8000)
    assert.notStrictEqual(job.status, 'running', '任务绝不能停在 running（否则永不可驱逐、还会吞掉后续同批次请求）')
    assert.ok(job.error, '应记录失败原因')
    svc.job.jobs.delete(id)
    svc.download.downloadMany = origMany
  })

  await t('job: findDup 不并入正在取消的任务（取消后重下必须是新任务）', async () => {
    await until(() => !svc.job.jobQueue.active && svc.job.jobQueue.pending === 0, 8000)
    const origRun = svc.incremental.run
    try {
      // 挂住任务：保持在"运行中"，从而可以精确构造"协作式取消的窗口"
      let release = null
      const gate = new Promise((r) => { release = r })
      svc.incremental.run = async () => { await gate; return { results: [], fillResults: [] } }
      const songs = [{ id: '77', name: 'x', artist: 'a', album: 'b', picUrl: '', picId: 'p' }]
      const batchKey = 'chart|测试榜|dest:default'
      const idA = svc.job.startJob('任务A', songs, { dir: TEST_DOWNLOAD_DIR, br: 320, destKind: 'local', batchKey, plan: { skipped: [], download: songs, fill: [], bases: new Map(), lyricsFor: new Set() } })
      const a = svc.job.jobs.get(idA)
      await until(() => a.status === 'running', 4000)
      // 协作式取消：status 仍是 running，直到管线观察到 abort
      svc.job.cancelJob(idA)
      assert.strictEqual(a.cancelled, true)
      assert.strictEqual(a.status, 'running', '取消是协作式的，此刻状态仍是 running')
      // 这个窗口里再点一次下载，绝不能被并进正在收尾的 A（并进去的结果是"什么都没下"）
      const idB = svc.job.startJob('任务B', songs, { dir: TEST_DOWNLOAD_DIR, br: 320, destKind: 'local', batchKey, plan: { skipped: [], download: songs, fill: [], bases: new Map(), lyricsFor: new Set() } })
      assert.notStrictEqual(idB, idA, '正在取消的任务不得再接收合并')
      svc.job.jobs.delete(idB)
      release()
    } finally {
      svc.incremental.run = origRun
      await until(() => !svc.job.jobQueue.active && svc.job.jobQueue.pending === 0, 8000)
    }
  })

  await t('job: batchKey 必须逐来源携带身份（五源曾共用同一个空键，导致第二首从未下载却报成功）', async () => {
    // 决策 73。song/songs/daily/fm/simi 五源的 batchKey 曾全部退化成字面量
    // "timestamp||dest:default"（既无 ownerId 也无 dirName），而 findDup 又被提前到
    // 目录分支之前 → "下载单曲 A"运行中再点"下载单曲 B"会被判成重复请求合并，
    // 返回 200 already，第二首从未被下载。这是纯静默丢数据，必须锁死。
    await until(() => !svc.job.jobQueue.active && svc.job.jobQueue.pending === 0, 8000)
    const origMany = svc.download.downloadMany
    const origGetDetail = core.song.getDetail
    const origList = core.playlist ? core.playlist.get : null
    // 必须显式钉住本地目的地：测试环境里可能残留着真机测试写下的手机目的地，
    // 一旦 createTask 走 phone 分支，本用例的 downloadMany 桩完全打不到（会真的去连设备）
    const origActiveId = svc.dest.activeId()
    svc.dest.setActive('')
    // 桩掉批次目录创建与增量扫描：本用例只关心 batchKey 的唯一性，
    // 不该在临时目录里真建目录真扫盘（createTask 会 await 多次 fs 调用）
    const dir = fs.mkdtempSync(path.join(TEST_DOWNLOAD_DIR, 'ncm-bk-'))
    const origCreate = svc.storage.createBatchDir
    const origFind = svc.storage.findBatchDir
    const origScan = svc.storage.scanDir
    const origSweep = svc.storage.sweepDownloads
    svc.storage.createBatchDir = () => dir
    svc.storage.findBatchDir = () => null
    svc.storage.scanDir = () => ({ audio: new Map(), lrc: new Set() })
    svc.storage.sweepDownloads = () => 0
    // 挂住任务体：只需让任务停在 running，从而能观察后续请求是否被误合并。
    // 用"逐个可释放"的闸门（而不是一个永不 resolve 的 gate）——后者会把队列永久占住，
    // 让后续依赖队列排空的用例全部超时
    let release = () => {}
    const seen = []
    // 闸门带自动放行兜底：release 只指向最后一次调用，靠手动释放必然漏掉某个任务体
    // （每个任务各有自己的闸门），队列被永久占住会让后续用例全部超时。
    // 加超时后即使漏放，任务也会自己走下去——测试仍会在断言处失败，而不是变成全局卡死
    svc.download.downloadMany = async (songs) => {
      seen.push(songs.map((s) => s.id))
      await new Promise((r) => {
        release = r
        const t = setTimeout(r, 2500)
        if (typeof t.unref === 'function') t.unref()
      })
      return { results: songs.map((s) => ({ ok: true, filepath: TEST_DOWNLOAD_DIR + s.name + '.mp3', song: s })), fillResults: [] }
    }
    core.song.getDetail = async (ids) => {
      const arr = Array.isArray(ids) ? ids : [ids]
      return arr.map((x) => ({ id: String(x), name: '歌' + x, artist: 'A', album: 'B', picUrl: '', picId: 'p' }))
    }
    try {
      // 1) 单曲 A 先建任务（本地目的地，桩掉扫盘副作用）
      const a = await svc.job.createTask({ source: 'song', id: '1', br: 320 }, { downloadDir: TEST_DOWNLOAD_DIR })
      assert.strictEqual(a.code, 200, `单曲建任务应成功，实际 ${a.code} ${JSON.stringify(a.body)}`)
      const ja = svc.job.jobs.get(a.body.jobId)
      await until(() => ja.status === 'running', 4000)
      // 2) 单曲 B 必须开新任务，不能被并进 A
      const b = await svc.job.createTask({ source: 'song', id: '2', br: 320 }, { downloadDir: TEST_DOWNLOAD_DIR })
      assert.notStrictEqual(b.body.jobId, a.body.jobId,
        '不同单曲必须开独立任务（曾被并入 A，第二首从未下载却返回 200 already）')
      assert.notStrictEqual(b.body.already, true, '不同单曲不得报 already')
      // 3) 同一首歌重复点击 = 真正的重复请求，必须合并（这是 findDup 存在的理由，不能被误伤）
      const dup = await svc.job.createTask({ source: 'song', id: '1', br: 320 }, { downloadDir: TEST_DOWNLOAD_DIR })
      assert.strictEqual(dup.body.jobId, a.body.jobId, '同一单曲重复提交应合并（避免重复消耗带宽）')
      assert.strictEqual(dup.body.already, true)
      // 4) 同一首歌不同音质必须开新任务（合并会让用户选的无损被静默丢弃）
      // 先放行闸门再等终态：cancelJob 是协作式的，任务体卡在闸门上时收口不会发生
      svc.job.cancelJob(a.body.jobId)
      release()
      await until(() => ja.status !== 'running' && ja.status !== 'queued', 4000)
      await until(() => !svc.job.jobQueue.active && svc.job.jobQueue.pending === 0, 8000)
      const c = await svc.job.createTask({ source: 'song', id: '1', br: 320 }, { downloadDir: TEST_DOWNLOAD_DIR })
      const jc = svc.job.jobs.get(c.body.jobId)
      await until(() => jc.status === 'running', 4000)
      const d2 = await svc.job.createTask({ source: 'song', id: '1', br: 2000 }, { downloadDir: TEST_DOWNLOAD_DIR })
      assert.notStrictEqual(d2.body.jobId, c.body.jobId,
        '同一首歌不同音质是两个不同批次（合并 = 用户明确选的无损被静默丢弃）')
      assert.strictEqual(d2.body.already, undefined, '不同音质不得报 already')
      svc.job.cancelJob(c.body.jobId)
      svc.job.cancelJob(d2.body.jobId)
      // 每个挂起的 downloadMany 各有自己的闸门，release 只指向最后一个；
      // 取消后循环释放直到队列排空，否则终态收口会一直等在闸门上
      for (let i = 0; i < 10 && (svc.job.jobQueue.active || svc.job.jobQueue.pending); i++) {
        release()
        await new Promise((r) => setTimeout(r, 30))
      }
      await until(() => !svc.job.jobQueue.active && svc.job.jobQueue.pending === 0, 8000)
    } finally {
      release() // 必须无条件放行，否则队列被本用例永久占住，后续全部超时
      for (let i = 0; i < 8; i++) { release(); await new Promise((r) => setTimeout(r, 30)) }
      svc.download.downloadMany = origMany
      core.song.getDetail = origGetDetail
      if (origList) core.playlist.get = origList
      try { svc.dest.setActive(origActiveId || '') } catch { /* 原目的地已失效也无所谓 */ }
      svc.storage.createBatchDir = origCreate
      svc.storage.findBatchDir = origFind
      svc.storage.scanDir = origScan
      svc.storage.sweepDownloads = origSweep
      fs.rmSync(dir, { recursive: true, force: true })
      // 清掉本用例遗留的任务记录，避免 50 条驱逐阈值被测试数据占满
      for (const id of [...svc.job.jobs.keys()]) {
        const j = svc.job.jobs.get(id)
        if (j && (j.batchKey.includes('song|') || j.batchKey.includes('songs|') || j.batchKey.includes('daily:') || j.batchKey.includes('fm:'))) svc.job.jobs.delete(id)
      }
      await until(() => !svc.job.jobQueue.active && svc.job.jobQueue.pending === 0, 8000)
    }
  })

  await t('job: 排队中取消也必须给出完整终态账（result 非空 + 落报告）', async () => {
    // 决策 74。queued 取消路径此前只置 status='cancelled'：result 留 null、不落报告。
    // 后果：同一"已取消"状态在排队取消时渲染空白、在执行中取消时渲染完整（两种形状）；
    // 且批次目录已被 createTask 建好，用户打开只有标记文件、没有任何解释它为何存在
    await until(() => !svc.job.jobQueue.active && svc.job.jobQueue.pending === 0, 8000)
    const origMany = svc.download.downloadMany
    const origWrite = svc.storage.writeBatchReport
    let report = null
    try {
      let rel = () => {}
      svc.download.downloadMany = async () => { await new Promise((r) => { rel = r }); return { results: [], fillResults: [] } }
      svc.storage.writeBatchReport = (d, o) => { report = { d, o }; return true }
      const dir = fs.mkdtempSync(path.join(TEST_DOWNLOAD_DIR, 'ncm-qcancel-'))
      const songs = [{ id: '1', name: '甲', artist: 'A', album: 'B', picUrl: '', picId: 'p' },
        { id: '2', name: '乙', artist: 'A', album: 'B', picUrl: '', picId: 'p' }]
      // 先占住队列，让第二个任务停在 queued
      const blocker = svc.job.startJob('占位', songs, { dir, br: 320, destKind: 'local' })
      await until(() => svc.job.jobs.get(blocker).status === 'running', 4000)
      const qid = svc.job.startJob('排队取消', songs, {
        dir,
        br: 320,
        destKind: 'local',
        plan: { skipped: [songs[0]], download: [songs[1]], fill: [], bases: new Map(), lyricsFor: new Set() },
      })
      const q = svc.job.jobs.get(qid)
      assert.strictEqual(q.status, 'queued', '前置条件：任务应停在排队中')
      const r = svc.job.cancelJob(qid)
      assert.strictEqual(r.code, 200)
      assert.strictEqual(q.status, 'cancelled')
      assert.ok(q.result, '排队中取消也必须有汇总（否则同一状态在两种取消时机下渲染出两种形状）')
      assert.strictEqual(q.result.total, 2)
      assert.strictEqual(q.result.skipped, 1, '预检跳过的歌必须计入（它已在建任务时冻结进 plan）')
      assert.strictEqual(q.result.ok, 0)
      assert.ok(report, '排队中取消也必须落 下载结果.txt（目录已建好却无任何痕迹解释它）')
      assert.strictEqual(report.d, dir)
      assert.strictEqual(q.handle, null, '终态必须释放 handle（否则 AbortController 及其监听器一直被 jobs 表持有）')
      svc.job.cancelJob(blocker)
      rel()
      await until(() => !svc.job.jobQueue.active && svc.job.jobQueue.pending === 0, 8000)
      svc.job.jobs.delete(blocker)
      svc.job.jobs.delete(qid)
      fs.rmSync(dir, { recursive: true, force: true })
    } finally {
      if (typeof rel === 'function') rel()
      svc.download.downloadMany = origMany
      svc.storage.writeBatchReport = origWrite
      for (const id of [...svc.job.jobs.keys()]) svc.job.jobs.get(id) && svc.job.jobs.get(id).handle && svc.job.cancelJob(id)
      await until(() => !svc.job.jobQueue.active && svc.job.jobQueue.pending === 0, 8000)
    }
  })

  await t('job: 终态必须释放 handle（否则 AbortController 被 jobs 表长期持有）', async () => {
    await until(() => !svc.job.jobQueue.active && svc.job.jobQueue.pending === 0, 8000)
    const origMany = svc.download.downloadMany
    try {
      svc.download.downloadMany = async (songs) => ({ results: songs.map((s) => ({ ok: true, filepath: TEST_DOWNLOAD_DIR + s.name + '.mp3', song: s })), fillResults: [] })
      const dir = fs.mkdtempSync(path.join(TEST_DOWNLOAD_DIR, 'ncm-hrel-'))
      const songs = [{ id: '1', name: '甲', artist: 'A', album: 'B', picUrl: '', picId: 'p' }]
      const id = svc.job.startJob('释放句柄', songs, { dir, br: 320, destKind: 'local' })
      const job = svc.job.jobs.get(id)
      await until(() => job.status === 'done' || job.status === 'error', 8000)
      assert.strictEqual(job.status, 'done', `任务应正常完成，实际 ${job.status}: ${job.error || ''}`)
      assert.strictEqual(job.handle, null, '终态后 handle 必须置空')
      svc.job.jobs.delete(id)
      fs.rmSync(dir, { recursive: true, force: true })
    } finally {
      svc.download.downloadMany = origMany
      await until(() => !svc.job.jobQueue.active && svc.job.jobQueue.pending === 0, 8000)
    }
  })

  await t('util: mergeSignals 退化分支不得在同一个 signal 上累积监听器', async () => {
    // 决策 75。mergeSignals 在两条管线里是每首调用的；退化分支（Node 18.0~18.16，
    // 无 AbortSignal.any）会在同一个任务级 signal 上每首挂 2 个监听器且从不摘除——
    // 第 11 首起 MaxListenersExceededWarning，且只要任务还在 50 条 jobs 表里就一直可达。
    // 这里强制走退化分支来验证（当前 Node 有原生 any，故临时摘掉）
    const realAny = AbortSignal.any
    try {
      AbortSignal.any = undefined
      delete require.cache[require.resolve('../src/service/util')]
      const fresh = require('../src/service/util')
      const job = new AbortController()
      const merged = []
      for (let i = 0; i < 50; i++) merged.push(fresh.mergeSignals(job.signal, AbortSignal.timeout(60000)))
      // Node 的默认上限是 10；50 首（=100 个监听器）必然触发告警
      const before = process.getMaxListeners()
      process.setMaxListeners(0)
      process.setMaxListeners(before)
      let warned = false
      const onWarn = (w) => { if (/MaxListeners/.test(w && w.name || '')) warned = true }
      process.on('warning', onWarn)
      await new Promise((r) => setTimeout(r, 30))
      process.off('warning', onWarn)
      assert.strictEqual(warned, false, '退化分支下 50 次合并不得触发 MaxListeners 告警（监听器泄漏）')
      // 中止后上游必须真的摘干净
      merged.forEach((m) => m.removeEventListener('abort', () => {}))
      job.abort()
      await new Promise((r) => setTimeout(r, 30))
      assert.strictEqual(merged[0].aborted, true, '合并信号必须跟随上游中止')
    } finally {
      AbortSignal.any = realAny
      delete require.cache[require.resolve('../src/service/util')]
    }
  })

  await t('util: mergeSignals 退化分支在上游 abort 后真正摘除监听器', async () => {
    const realAny = AbortSignal.any
    try {
      AbortSignal.any = undefined
      delete require.cache[require.resolve('../src/service/util')]
      const fresh = require('../src/service/util')
      const job = new AbortController()
      const merged = []
      for (let i = 0; i < 60; i++) merged.push(fresh.mergeSignals(job.signal, AbortSignal.timeout(60000)))
      job.abort()
      await new Promise((r) => setTimeout(r, 20))
      assert.strictEqual(merged[0].aborted, true)
      // 监听器摘除后再合并一批，新的合并不得受上一次的残留影响
      assert.strictEqual(merged[59].aborted, true, '所有合并信号都应已中止')
      const fresh2 = fresh.mergeSignals(new AbortController().signal, AbortSignal.timeout(60000))
      assert.strictEqual(fresh2.aborted, false, '新合并不得被已中止的上游污染')
    } finally {
      AbortSignal.any = realAny
      delete require.cache[require.resolve('../src/service/util')]
    }
  })

  await t('phone: 中止必须挂 partialResults（否则取消后显示"下载 0"，日志里却躺着 250 条完成）', async () => {
    // 决策 73。phone.downloadMany 的两处中止上抛与 phone.run 的补词循环此前都不带
    // partialResults，而 job.finish 靠它汇总 → 缺了就退化成空数组，手机批次的取消
    // 摘要会说"下载 0，失败 0"，与逐首"完成："日志直接矛盾。
    // 取消走**真实 signal**（与用户点取消同路径）：abort 落在第 3 首的取流里，
    // 由 fetchBufferWithProgress 的 reader 抛 AbortError，最贴近真实
    const pushed = { n: 0 }
    const rl = withStubbedPhone({
      resolveWithFallback: async () => ({ url: 'http://x/a.mp3', level: 'exhigh', br: 320, size: 72, ext: 'mp3' }),
      adb: { pushBuffer: () => { pushed.n++ } },
      tag: { embedMp3Buf: (b) => b, verifyAudioHead: () => true },
      status: { state: 'ready', message: 'x' }, // downloadMany 开头会复查设备在线
    })
    const origFetch = global.fetch
    try {
      // 前两首正常取流（这样 results 里有已完成项），第 3 首触发真实 abort：
      // reader.read() 拒绝 AbortError —— 与用户点取消时 fetchBufferWithProgress 的行为一致
      let songs = 0
      const ac = new AbortController()
      const good = fakeAudioFetch()
      global.fetch = async (...a) => {
        songs++
        if (songs >= 3) {
          ac.abort()
          return {
            ok: true, status: 200,
            headers: { get: (h) => (h === 'content-length' ? '72' : null) },
            body: { getReader: () => ({ read: async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }) }, cancel: async () => {} }) },
          }
        }
        return good(...a)
      }
      const list = [1, 2, 3, 4, 5].map((i) => ({ id: String(i), name: '歌' + i, artist: 'A', album: 'B', picUrl: '', picId: 'p' }))
      let caught = null
      try {
        await rl.phone.downloadMany(list, { dir: '/sdcard/Music/T', lyrics: false, cover: false, signal: ac.signal })
      } catch (e) { caught = e }
      assert.ok(caught, `第 3 首取消必须上抛，实际未抛（pushed=${pushed.n}）`)
      assert.strictEqual(caught.name, 'AbortError', `必须是 AbortError，实际 ${caught.name}: ${caught.message}`)
      assert.ok(caught.partialResults, '中止必须挂 partialResults（job.finish 靠它汇总，缺了就显示"下载 0"）')
      assert.ok(caught.partialResults.length >= 1,
        `已完成的各首必须计入（实际 ${caught.partialResults && caught.partialResults.length}）`)
      assert.ok(caught.partialResults.every((r) => r.ok || r.error), '每项都必须是完整的结果对象')
      assert.ok(caught.partialResults.length < list.length, '中止前不应把全部歌都算作完成')
    } finally { global.fetch = origFetch; rl.restore() }
  })

  await t('phone: 设备断连中止同样必须挂 partialResults', async () => {
    const pushed = { n: 0 }
    const rl = withStubbedPhone({
      resolveWithFallback: async () => ({ url: 'http://x/a.mp3', level: 'exhigh', br: 320, size: 72, ext: 'mp3' }),
      adb: {
        pushBuffer: () => {
          pushed.n++
          // 第 3 首：设备类错误（走 pushToDevice 的重试与等待后仍失败 → deviceGone 上抛）
          if (pushed.n === 3) { const e = new Error('error: device not found'); throw e }
        },
      },
      tag: { embedMp3Buf: (b) => b, verifyAudioHead: () => true },
      // 起始必须 ready（否则 downloadMany 开头就整体中止，测不到逐首路径）；
      // 断连由 pushBuffer 第 3 次抛设备类错误模拟，重试等待期间 status 转 offline
      status: { state: 'ready', message: 'x' },
      statusAfter: { state: 'offline', message: 'not found' },
    })
    const origFetch = global.fetch
    try {
      global.fetch = fakeAudioFetch()
      const list = [1, 2, 3, 4, 5].map((i) => ({ id: String(i), name: '歌' + i, artist: 'A', album: 'B', picUrl: '', picId: 'p' }))
      let caught = null
      try {
        await rl.phone.downloadMany(list, { dir: '/sdcard/Music/T', lyrics: false, cover: false })
      } catch (e) { caught = e }
      assert.ok(caught, `设备断连必须上抛中止整批，实际未抛（pushed=${pushed.n}）`)
      assert.strictEqual(caught.deviceGone, true, '必须带 deviceGone（否则上层不会中止整批）')
      assert.ok(caught.partialResults, '设备断连中止同样必须挂 partialResults（否则已完成各首的账全丢）')
      assert.ok(caught.partialResults.length >= 1, '已完成各首必须计入')
    } finally { global.fetch = origFetch; rl.restore() }
  })

  await t('phone: mergeIndexFile 临时名带 pid+序号（与 storage 同守，防跨进程互抢）', async () => {
    // 决策 73。固定名 .tmp 时两个写入方（第二个服务实例、tools/phone-fill.js）会互相覆盖，
    // A 的 mv 把 B 的内容搬成正式索引，A 刚 flush 的条目就此丢失
    const origPush = core.adb.pushBuffer
    const origShell = core.adb.shell
    const origListFiles = core.adb.listFiles
    const origReadText = core.adb.readText
    const origExec = core.adb.execOut
    try {
      core.adb.readText = () => ''
      core.adb.listFiles = () => []
      core.adb.execOut = () => ''
      const paths = []
      core.adb.pushBuffer = (_buf, p) => { paths.push(p); throw new Error('推送失败（测试桩）') }
      core.adb.shell = () => {}
      svc.phone.mergeIndexFile('/sdcard/Music/T', new Map([['1', '甲']]))
      svc.phone.mergeIndexFile('/sdcard/Music/T', new Map([['2', '乙']]))
      const tmps = paths.filter((p) => /\.tmp$/.test(p))
      assert.strictEqual(tmps.length, 2, `两次合并都应推临时文件，实际 ${tmps.length}`)
      assert.notStrictEqual(tmps[0], tmps[1], `临时名不得固定（两写入方会互抢），实际两次都是 ${tmps[0]}`)
      assert.ok(/\$\{process\.pid\}|\d+/.test(tmps[0]), `临时名必须含 pid 段（跨进程唯一），实际 ${tmps[0]}`)
      assert.ok(tmps.every((p) => /\.ncm-index\.json\..+\.tmp$/.test(p)), `临时名格式不符 storage 口径: ${tmps.join(' ')}`)
    } finally {
      core.adb.pushBuffer = origPush
      core.adb.shell = origShell
      core.adb.listFiles = origListFiles
      core.adb.readText = origReadText
      core.adb.execOut = origExec
    }
  })

  await t('phone: pushToDevice 每轮开头查取消（否则取消后仍阻塞满 30s 同步 spawnSync）', async () => {
    // 决策 75。首次 pushBuffer 之前不查取消：取消若落在"音频推完、歌词未推"之间，
    // 那次 .lrc 推送仍会跑满 PUSH_TIMEOUT=30s，期间事件循环被占满、DELETE 请求都解析不了
    const origPush = core.adb.pushBuffer
    try {
      let pushes = 0
      core.adb.pushBuffer = () => { pushes++ }
      const ac = new AbortController()
      ac.abort()
      let threw = null
      try { await svc.phone.pushToDevice(Buffer.from('x'), '/sdcard/Music/T/a.mp3', { signal: ac.signal }) } catch (e) { threw = e }
      assert.ok(threw, '已取消的 signal 必须让 pushToDevice 抛错')
      assert.strictEqual(pushes, 0, `一次 adb 推送都不该发生（实际 ${pushes} 次）——用户点了取消却还要再等 30 秒`)
    } finally { core.adb.pushBuffer = origPush }
  })

  await t('download: 批次内重复对象也必须回 onFile（两条管线口径一致）', async () => {
    // 决策 75。本地管线对"同一歌单里同一首歌出现两次（同一对象）"记了失败结果却没调
    // onFile，于是既不计入 processed 也不进日志；手机管线同一情形是调了的
    const dir = fs.mkdtempSync(path.join(TEST_DOWNLOAD_DIR, 'ncm-dupref-'))
    try {
      const origFetch = core.raw.fetchBuffer
      const origStream = core.raw.streamTo
      const origTag = { embedMp3Buf: core.tag.embedMp3Buf }
      // 同一对象引用出现两次
      const same = { id: '1', name: '重复歌', artist: 'A', album: 'B', picUrl: '', picId: 'p' }
      core.raw.fetchBuffer = async () => Buffer.from('ID3fake-audio')
      core.raw.streamTo = async () => ({ bytes: 10 })
      core.tag.embedMp3Buf = (buf) => buf
      core.song.getDetail = async () => [same]
      const seen = []
      const out = await svc.download.downloadMany([same, same], { dir, lyrics: false, cover: false, onFile: (r) => seen.push(r) })
      const dups = seen.filter((r) => !r.ok && /重复歌曲对象/.test(r.error || ''))
      assert.strictEqual(dups.length, 1, `重复项必须回 onFile（否则不计进度、不进日志），实际回调 ${seen.length} 次`)
      assert.ok(Array.isArray(out) || out.results, '返回值形状不变')
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  await t('download: 大小写不同的歌名不得被判成同一首（Windows/Android 大小写不敏感 → 永久丢歌）', async () => {
    // 决策 78。NTFS 与 ext4/f2fs 都大小写不敏感，而 Set.has 大小写敏感。链路：
    // 磁盘有 `Hello World.mp3`，API 给出 `hello world` → 分配时若判"没占用"就分到同名 base →
    // existsSync 在不敏感盘上返回 true → 走 existed 分支 → **这首歌永远不会被下载**，
    // 而日志与报告都断言它已存在，且每轮增量重复、永不自愈
    const dir = fs.mkdtempSync(path.join(TEST_DOWNLOAD_DIR, 'ncm-case-'))
    try {
      // 分配侧：磁盘已有 `Hello World`，来一首 `hello world`。分配可以"认领"磁盘上的同名文件
      // （那确实是同一首歌），但当它不认领、而是要**新建**时，绝不能新建出一个与磁盘上
      // 大小写不同的名字——那样在 NTFS/ext4 上就是同一个文件
      const taken = new Set(['Hello World'])
      const song = { id: '2', name: 'hello world', artist: 'Different Artist', album: 'Y', picUrl: '', picId: 'p' }
      const got = svc.download.assignBaseNames([song], taken).get(song)
      // 关键性质：无论走认领还是新建，结果都必须是磁盘上那个名字（认领），
      // 或一个与磁盘名大小写不冲突的名字（新建）。"hello world" 与 "Hello World"
      // 在 NTFS 上是同一个文件，所以分配结果不得是后者
      assert.ok(!(got === 'hello world'),
        `分配结果不得是 "hello world"（与磁盘上的 Hello World 在 NTFS/ext4 上是同一个文件，会被永久跳过），实际 ${got}`)
      assert.strictEqual(got, 'Hello World', '应当直接认领磁盘上的既有名字（这确实是同一首歌）')
      // 序号侧：`Song (2)` 在盘上时，不得新建出 `song (2)` 这种大小写不同的同名
      const taken2 = new Set(['Song (2)'])
      const song2 = { id: '3', name: 'song', artist: 'Z', album: 'Y', picUrl: '', picId: 'p' }
      const g2 = svc.download.assignBaseNames([song2], taken2).get(song2)
      assert.ok(!(g2 && g2.toLowerCase() === 'song (2)'),
        `" (n)" 序号分配同样必须折叠大小写，实际分到 ${g2}`)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  await t('incremental: 大小写不同的歌名按"同一首歌"认领，不得凭空多下一份', async () => {
    // 决策 78 的另一半：plan 查 audioIndex/lrcIndex 也必须用同一把折叠尺子。
    // 若 plan 不折叠：分配说"没占用"→ plan 说"没有音频文件"→ 进下载列表 →
    // existsSync 在不敏感盘上返回 true → 走 existed 分支 → 记"同音质已存在"而**从未下载**。
    // 反过来若 plan 折叠、分配不折叠，也会出现"认领了一个大小写不同的名字"的不一致
    const dir = fs.mkdtempSync(path.join(TEST_DOWNLOAD_DIR, 'ncm-case2-'))
    try {
      fs.writeFileSync(path.join(dir, 'Hello World.mp3'), 'x')
      const song = { id: '9', name: 'hello world', artist: 'X', album: 'Y', picUrl: '', picId: 'p' }
      const p = svc.incremental.plan([song], { ...svc.storage.scanDir(dir), idMap: new Map() }, { lyrics: false })
      // 折叠后的正确行为：认领磁盘上那个文件（它就是这个 base 的产物），既不重下也不丢歌
      assert.strictEqual(p.download.length, 0, '不得凭空再下一份（磁盘上已有该 base 的文件）')
      assert.strictEqual(p.skipped.length, 1, '应判为已存在并跳过（base 一致，只是大小写不同）')
      assert.strictEqual(p.bases.get(song), 'Hello World', 'base 必须统一到磁盘上的实际大小写，否则记账与磁盘名错位')
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  await t('download: verifyFile 必须校验实际读取字节数（2 字节的 FF Ex 不得当成合法 mp3）', async () => {
    // 决策 76。head 是 Buffer.alloc(16)，文件不足 16 字节时尾部零填充；
    // verifyMagic 对 mp3 只需 buf[0]==0xff && (buf[1]&0xe0)==0xe0 → "FF Ex" 两字节即通过，
    // 随后被 rename 成正式歌名、进索引、被增量永久当成"已存在"，而播放器打不开
    const dir = fs.mkdtempSync(path.join(TEST_DOWNLOAD_DIR, 'ncm-short-'))
    try {
      const short = path.join(dir, '短.mp3')
      fs.writeFileSync(short, Buffer.from([0xff, 0xfb]))
      assert.throws(() => core.download.verifyFile(short, 'mp3'),
        '2 字节的 mp3 必须判失败（不检查 readSync 返回值就会放行）')
      assert.ok(!fs.existsSync(short), '校验失败必须删掉半成品（否则下一轮会被认领）')
      const shortFlac = path.join(dir, '短.flac')
      fs.writeFileSync(shortFlac, Buffer.from('fLaC', 'ascii'))
      assert.throws(() => core.download.verifyFile(shortFlac, 'flac'), '4 字节的 fLaC 必须判失败')
      // 正常文件仍必须放行
      const good = path.join(dir, '好.mp3')
      fs.writeFileSync(good, Buffer.concat([Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x00', 'latin1'), Buffer.alloc(32)]))
      assert.strictEqual(core.download.verifyFile(good, 'mp3'), true, '正常文件必须放行')
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  await t('job/下载来源: 原型链上的键不得被当成来源（constructor/toString → 400 而非 500）', async () => {
    // 决策 77。UI_SOURCES/RECOMMEND_SOURCES 是普通对象字面量，p.source='constructor'
    // 取到 Object.prototype.constructor（真值）→ 通过 !fn 检查 → 被当函数调用 →
    // 500 + 一句 JavaScript 内部错误，而不是本该给的 400"未知来源"
    await until(() => !svc.job.jobQueue.active && svc.job.jobQueue.pending === 0, 8000)
    for (const bad of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
      const r = await svc.job.createTask({ source: bad, id: '1' }, { downloadDir: TEST_DOWNLOAD_DIR })
      assert.strictEqual(r.code, 400, `source=${bad} 必须 400，实际 ${r.code} ${JSON.stringify(r.body)}`)
      assert.ok(/未知来源/.test(r.body.error || ''), `source=${bad} 的错误文案应为"未知来源"，实际 ${JSON.stringify(r.body.error)}`)
    }
  })

  await t('cookie: 含换行的 cookie 判为未登录（否则全站 ERR_INVALID_CHAR 却显示已登录）', async () => {
    // 决策 92。trim 只去首尾，从编辑器粘贴的 cookie 很容易在两段之间留换行。
    // 带 LF 的 Cookie 头被 Node 直接抛 ERR_INVALID_CHAR → 每个接口都 500，
    // 而 /api/login/status 仍报 cookie 有效 → 用户同时看到"已登录"和"服务全挂"。
    // 注：NUL 无法用环境变量构造（Windows 的 set 会在 NUL 处截断整个值），
    // 那条路径在真实场景里表现为"cookie 被截成半个"——同样由 has() 判为非空而误报已登录
    const saved = process.env.NCM_COOKIE
    try {
      process.env.NCM_COOKIE = 'MUSIC_U=abc\nX-Injected: def'
      core.cookie._resetCache()
      assert.strictEqual(core.cookie.has(), false, '含换行的 cookie 必须判为未登录')
      process.env.NCM_COOKIE = 'MUSIC_U=正常值'
      core.cookie._resetCache()
      assert.strictEqual(core.cookie.has(), true, '正常 cookie 必须判为已登录（别把好凭证也毙了）')
    } finally {
      if (saved === undefined) delete process.env.NCM_COOKIE
      else process.env.NCM_COOKIE = saved
      core.cookie._resetCache()
    }
  })

  await t('dest: 手改 destinations.json 的非法条目必须被丢弃（盘根不得成为清扫目标）', async () => {
    // 决策 91。文件注释里建议用户手改，而 addLocal 会拒盘根 —— 但手改绕过了全部校验：
    // {"kind":"local","path":"C:\\"} 能过 load()，随后建任务时 storage.sweepDownloads("C:\\")
    // 递归整块盘、删掉别家软件的 *.part/*.tagtmp（不可恢复、无记录）
    const file = path.join(TEST_DOWNLOAD_DIR, 'dest-bad.json')
    // 盘根用 path.parse().root 现算，不写字面量：写死 'C:\\' 在不同平台上不等价，
    // 而 JSON.stringify 之后再被别的环节转义，出错时极难定位
    const diskRoot = path.parse(path.resolve(path.sep)).root
    const okDir = path.join(TEST_DOWNLOAD_DIR, 'dest-bad-ok')
    const cfg = {
      active: 'd1',
      next: 9,
      list: [
        { id: 'd1', kind: 'local', path: diskRoot },                // 盘根：清扫会遍历整块磁盘
        { id: 'd2', kind: 'weird', path: path.join(diskRoot, 'x') }, // 未知类型
        { id: 'd3', kind: 'local' },                                 // 缺路径
        { id: '', kind: 'local', path: path.join(diskRoot, 'y') },   // 缺 id
        null,                                                        // 不是对象
        { id: 'd5', kind: 'local', path: okDir },                    // 合法，保留
        { id: 'd6', kind: 'phone', path: '/sdcard/Music' },          // 合法，保留
      ],
    }
    fs.writeFileSync(file, JSON.stringify(cfg))
    // 前置自检：这份 fixture 自己必须真的含盘根，否则下面的断言会因为 fixture 写错而假绿/假红
    assert.strictEqual(path.resolve(cfg.list[0].path), diskRoot, `fixture 第一条必须是盘根，实际 ${cfg.list[0].path}`)
    // 注意：_useFile 已经清缓存，**不能**再调 _reset()——它会把 FILE 指回项目根的真实
    // destinations.json，于是 list() 读的根本不是这份 fixture（表现为盘根条目"没被丢弃"）
    svc.dest._useFile(file)
    try {
      const ids = svc.dest.list().map((d) => d.id)
      assert.ok(!ids.includes('d1'), `盘根条目必须被丢弃（否则清扫遍历整块盘），实际剩 ${ids.join(',')}`)
      assert.ok(!ids.includes('d2'), '未知 kind 必须被丢弃')
      assert.ok(!ids.includes('d3'), '缺路径必须被丢弃')
      assert.ok(!ids.includes(''), '缺 id 必须被丢弃')
      assert.strictEqual(ids.length, 2, `只应保留两条合法条目，实际 ${ids.length}：${ids.join(',')}`)
      assert.ok(ids.includes('d5'), '合法本地条目必须保留')
      assert.ok(ids.includes('d6'), '合法手机条目必须保留')
      assert.strictEqual(svc.dest.activeId(), null, 'active 指向被丢弃的条目时必须回落为缺省（不得指向盘根）')
    } finally {
      // 恢复指向临时目录里那份（而不是 _reset() 的项目根真实文件），避免污染后续用例
      svc.dest._useFile(path.join(TEST_DOWNLOAD_DIR, 'destinations.json'))
      fs.rmSync(file, { force: true })
    }
  })

  await t('job: 批次级失败的原因必须进卡片日志（此前只落 service.log，用户只看到"失败 0"）', async () => {
    // 决策 80。job.result 在所有终态路径上都是真值对象，前端据此渲染汇总，
    // 于是 job.error 分支永远走不到 —— 手机任务排队期间拔线时用户只看到
    // 红色"出错"卡片配一句"失败 0"，真因只躺在 logs/service.log 里
    await until(() => !svc.job.jobQueue.active && svc.job.jobQueue.pending === 0, 8000)
    const origMany = svc.download.downloadMany
    const origWrite = svc.storage.writeBatchReport
    try {
      svc.download.downloadMany = async () => { throw new Error('手机已断开（未检测到 ADB 设备），任务终止') }
      svc.storage.writeBatchReport = () => true
      const dir = fs.mkdtempSync(path.join(TEST_DOWNLOAD_DIR, 'ncm-errvis-'))
      const songs = [{ id: '1', name: '甲', artist: 'A', album: 'B', picUrl: '', picId: 'p' }]
      const id = svc.job.startJob('失败可见性', songs, { dir, br: 320, destKind: 'local' })
      const job = svc.job.jobs.get(id)
      await until(() => job.status === 'error' || job.status === 'done', 8000)
      assert.strictEqual(job.status, 'error', '任务应按失败收口')
      const hasReason = job.log.some((l) => /手机已断开/.test(l))
      assert.ok(hasReason, `失败原因必须出现在卡片日志里（用户只看得到这里），实际日志：${JSON.stringify(job.log)}`)
      svc.job.jobs.delete(id)
      fs.rmSync(dir, { recursive: true, force: true })
    } finally {
      svc.download.downloadMany = origMany
      svc.storage.writeBatchReport = origWrite
      await until(() => !svc.job.jobQueue.active && svc.job.jobQueue.pending === 0, 8000)
    }
  })

  await t('job: destId 必须随任务下发（否则"打开文件夹"会打开当前目的地而非任务时的目的地）', async () => {
    // 决策 81。destId 只写进了 opts 而没进 job，toPublicJob 展开 job 后恒为 undefined，
    // 前端 openFolder(job.folder, job.destId) 拿不到 → 服务端回落到"当前激活的目的地"。
    // 用户切过下载位置后点旧任务的按钮，打开的是另一个盘，看起来像下载丢了
    await until(() => !svc.job.jobQueue.active && svc.job.jobQueue.pending === 0, 8000)
    const origMany = svc.download.downloadMany
    try {
      svc.download.downloadMany = async (songs) => ({ results: songs.map((s) => ({ ok: true, filepath: TEST_DOWNLOAD_DIR + s.name + '.mp3', song: s })), fillResults: [] })
      const dir = fs.mkdtempSync(path.join(TEST_DOWNLOAD_DIR, 'ncm-destid-'))
      const songs = [{ id: '1', name: '甲', artist: 'A', album: 'B', picUrl: '', picId: 'p' }]
      const id = svc.job.startJob('目的地绑定', songs, { dir, br: 320, destKind: 'local', destId: 'd7', destName: 'U盘' })
      const job = svc.job.jobs.get(id)
      await until(() => job.status === 'done' || job.status === 'error', 8000)
      assert.strictEqual(job.destId, 'd7', `任务必须记住下载位置 id，实际 ${JSON.stringify(job.destId)}`)
      const pub = svc.job.toPublicJob(job)
      assert.strictEqual(pub.destId, 'd7', '对外形状也必须带 destId（前端要靠它把按钮绑回当时的位置）')
      assert.ok(!('handle' in pub), '不得外泄 handle')
      svc.job.jobs.delete(id)
      fs.rmSync(dir, { recursive: true, force: true })
    } finally {
      svc.download.downloadMany = origMany
      await until(() => !svc.job.jobQueue.active && svc.job.jobQueue.pending === 0, 8000)
    }
  })

  await t('queue: pump 的意外拒绝不会逃成未处理拒绝', async () => {
    // 结构保证：active 由 finally 复位、任务体自带 catch。这里只锁"push 不抛"
    const q = svc.queue.createSerialQueue()
    const handle = q.push(() => { throw new Error('任务体抛错') })
    assert.ok(handle && typeof handle.id === 'number')
    await until(() => !q.active && q.pending === 0, 2000)
    assert.ok(true, '任务体抛错后队列必须照常排空（不得卡在 active）')
  })

  await t('instance: stopOldService 各条守卫（不误杀、不谎报成功）', async () => {
    // instance.js 在加载时解构 execSync，事后替换 child_process.execSync 无效（决策 61 的教训）——
    // 必须先打桩再重载模块，finally 里恢复并再清一次缓存，防止桩泄漏到后续用例
    const child = require('child_process')
    const key = require.resolve('../src/service/instance')
    const origExec = child.execSync
    const origKill = process.kill
    const calls = { exec: 0 }
    // netstat 输出必须通过变量切换，不能事后重写 child.execSync：
    // instance.js 在 require 时就把 execSync 解构进了局部变量，重写 exports 上的那份对它无效
    // （与决策 61 的"先 require 后打桩"是同一类陷阱，这里换成桩在先 + 输出可控）
    let netstatOut = [
      '  Proto  Local Address          Foreign Address        State           PID',
      '  TCP    127.0.0.1:3000         0.0.0.0:0              LISTENING       12345',
    ].join('\r\n')
    let listener = true // 端口是否还被占着
    let killReleases = true // 杀掉后是否真的释放端口（末位场景要模拟"没释放"）
    child.execSync = () => { calls.exec++; return listener ? netstatOut : '  TCP    [::]:135    0.0.0.0:0    LISTENING    999\r\n' }
    let killed = []
    process.kill = (pid) => { killed.push(pid); if (killReleases) listener = false }
    const origFetch = global.fetch
    let inst
    try {
      delete require.cache[key]
      inst = require('../src/service/instance')
      // isOurs 内部是模块内裸引用（不是 exports 上的），打桩 exports 不生效——
      // 它靠 fetch /api/ping 判定，所以桩 global.fetch 才是正确的注入口
      let pingText = 'netease-music-service'
      global.fetch = async () => ({ ok: true, text: async () => pingText })
      // 非本服务：一律不许杀
      pingText = '别的程序'
      assert.strictEqual(await inst.stopOldService(3000), false, '非本服务必须返回 false')
      assert.deepStrictEqual(killed, [], '非本服务绝不能调用 process.kill')
      // 本服务：杀一次后端口释放
      pingText = 'netease-music-service'
      listener = true; killReleases = true
      killed = []
      assert.strictEqual(await inst.stopOldService(3000), true, '杀成功且端口释放应返回 true')
      assert.deepStrictEqual(killed, [12345], 'process.kill 只应被调一次且 PID 正确')
      // 端口始终不释放：必须返回 false。此前无条件 return true →
      // stop.js 打印"已停止"并退出 0，而服务其实还在跑，紧接着新实例 EADDRINUSE
      listener = true; killReleases = false
      killed = []
      assert.strictEqual(await inst.stopOldService(3000), false, '端口未释放必须返回 false，不得谎报成功')
      assert.deepStrictEqual(killed, [12345], '端口未释放时仍应尝试杀过一次')
      // findListenerPid 解析口径
      netstatOut = [
        '  Proto  Local Address          Foreign Address        State           PID',
        '  TCP    127.0.0.1:3000         0.0.0.0:0              LISTENING       12345',
      ].join('\r\n')
      listener = true
      assert.strictEqual(inst.findListenerPid(3000), 12345, '应解析出 LISTENING 行的 PID')
      // 只有 ESTABLISHED（无 LISTENING）不算监听者
      netstatOut = '  TCP    127.0.0.1:3000         127.0.0.1:1       ESTABLISHED     4242\r\n'
      assert.strictEqual(inst.findListenerPid(3000), null, '非 LISTENING 行不应被当成监听者')
      // 端口号不匹配的行必须忽略
      netstatOut = '  TCP    127.0.0.1:3001         0.0.0.0:0              LISTENING       777\r\n'
      assert.strictEqual(inst.findListenerPid(3000), null, '别的端口不应被匹配上')
      // netstat 不可用
      child.execSync = () => { throw new Error('netstat not found') }
      delete require.cache[key]
      inst = require('../src/service/instance')
      assert.strictEqual(inst.findListenerPid(3000), null, 'netstat 失败须返回 null 而不是抛')
    } finally {
      // 全部桩必须在 finally 恢复：本用例若中途断言失败，global.fetch 的桩泄漏出去
      // 会让后面所有 HTTP 用例拿不到真 fetch，表现为一片与本用例无关的失败
      global.fetch = origFetch
      child.execSync = origExec
      process.kill = origKill
      delete require.cache[key]
      // 恢复默认实例：重新加载后 core/service 持有的仍是旧引用，这里保证后续用例拿到干净模块
      require(key)
    }
  })

  await t('cookie: _useFile 隔离后可测 save/clear 与 mtime 失效', () => {
    const f = path.join(TEST_DOWNLOAD_DIR, 'cookie-test.txt')
    core.cookie._useFile(f)
    try {
      core.cookie.save('MUSIC_U=abc')
      assert.strictEqual(core.cookie.get(), 'MUSIC_U=abc')
      assert.ok(fs.existsSync(f), 'save 必须落盘')
      // 裸值自动补键名；双前缀去重；带空格的值要 trim（否则 has() 报已登录但请求被网易拒）
      core.cookie.save('bare')
      assert.strictEqual(core.cookie.get(), 'MUSIC_U=bare')
      core.cookie.save('MUSIC_U=MUSIC_U=x')
      assert.strictEqual(core.cookie.get(), 'MUSIC_U=x')
      assert.strictEqual(core.cookie.save('MUSIC_U=  padded  '), undefined)
      assert.strictEqual(core.cookie.get(), 'MUSIC_U=padded', '值里的空格必须被 trim')
      // 空值不算登录态
      core.cookie.save('MUSIC_U=')
      assert.strictEqual(core.cookie.has(), false)
      // 外部改文件后应立即可见（mtime 失效）。同毫秒写入时 mtime 可能不变，
  // 那是 mtime 缓存的固有取舍（cookie.js 注释已声明），故这里只断言"读到的是文件当前内容"，
  // 不强行要求一定是 second —— 强行要求会把测试写成必然偶发失败的那一类
      core.cookie.save('MUSIC_U=first')
      const onDisk = fs.readFileSync(f, 'utf8').trim()
      assert.strictEqual(core.cookie.get(), onDisk, 'get() 必须与文件当前内容一致')
      core.cookie.clear()
      assert.strictEqual(core.cookie.has(), false)
      assert.ok(!fs.existsSync(f), 'clear 必须删文件')
    } finally { core.cookie._useFile() }
  })

  await t('cookie: 归一化不得破坏"以其它键开头"的真实 cookie', () => {
    // 真实 cookie.txt 以 MUSIC_A_T= 之类开头；若归一化把它当裸值再包一层 MUSIC_U=，
    // 产出的凭证网易根本不认——表现为"明明登录了却什么都下不了"，且毫无报错可查
    const f = path.join(TEST_DOWNLOAD_DIR, 'cookie-real.txt')
    const real = 'MUSIC_A_T=1671529203667; Max-Age=2147483647; MUSIC_U=realvalue; __csrf=abc'
    core.cookie._useFile(f)
    try {
      core.cookie.save(real)
      assert.strictEqual(core.cookie.get(), real, '其它键开头的 cookie 必须原样透传')
      assert.strictEqual(core.cookie.has(), true)
      // 双前缀必须真正去重（此前只是"剥一个再补一个"，等于没去）
      core.cookie.save('MUSIC_U=MUSIC_U=x')
      assert.strictEqual(core.cookie.get(), 'MUSIC_U=x', '双前缀必须循环剥到只剩一个')
      // 真实项目里的 cookie.txt 必须能原样通过归一化（防止改动破坏线上登录态读取）
      core.cookie._useFile()
      const onDisk = fs.readFileSync(path.join(__dirname, '..', 'cookie.txt'), 'utf8').trim()
      assert.strictEqual(core.cookie.get(), onDisk, '真实 cookie.txt 归一化后必须与原文逐字节一致')
    } finally { core.cookie._useFile() }
  })

  await t('logger: 超限轮转为 .old 且只留一代', () => {
    const tmpLog = path.join(TEST_DOWNLOAD_DIR, 'rotate.log')
    svc.logger._useFile(tmpLog)
    try {
      fs.writeFileSync(tmpLog, Buffer.alloc(2 * 1024 * 1024 + 64, 0x41))
      svc.logger.log('test', '触发轮转')
      assert.ok(fs.existsSync(tmpLog + '.old'), '超 2MB 必须轮转出 .old')
      const head = fs.readFileSync(tmpLog, 'utf8')
      assert.ok(/日志已轮转/.test(head), '新文件首行应记录轮转事件')
      // 再写不应产生第二代
      svc.logger.log('test', '再写一行')
      const files = fs.readdirSync(TEST_DOWNLOAD_DIR).filter((f) => f.indexOf('rotate.log') === 0)
      assert.ok(files.length <= 2, `只应存在 service.log 与 .old 两代，实际: ${files.join(',')}`)
    } finally { svc.logger._useFile(path.join(TEST_DOWNLOAD_DIR, 'service.log')) }
  })

  await t('chart: 缓存可清空（避免单测里的假榜单漏给后续用例）', async () => {
    const origFetch = core.chart.fetchToplist
    try {
      let calls = 0
      core.chart.fetchToplist = async () => { calls++; return [{ id: 1, name: '榜A' }] }
      svc.chart._resetCache()
      await svc.chart.charts()
      await svc.chart.charts()
      assert.strictEqual(calls, 1, '缓存命中不得重复请求')
      await svc.chart.charts(true)
      assert.strictEqual(calls, 2, 'refresh=true 必须绕过缓存')
      svc.chart._resetCache()
      core.chart.fetchToplist = async () => { calls++; return [{ id: 2, name: '榜B' }] }
      const again = await svc.chart.charts()
      assert.strictEqual(again[0].name, '榜B', '_resetCache 后必须重新取数，不能拿到旧缓存')
    } finally {
      core.chart.fetchToplist = origFetch
      svc.chart._resetCache()
    }
  })

  await t('dest: 外部改动 destinations.json 后立即生效（mtime 失效）', () => {
    const f = path.join(TEST_DOWNLOAD_DIR, 'dest-mtime.json')
    svc.dest._useFile(f)
    try {
      svc.dest.addLocal(TEST_DOWNLOAD_DIR)
      const before = svc.dest.list().length
      assert.strictEqual(before, 1)
      // 手工塞一个条目（模拟用户手改文件）。显式把 mtime 推到未来：
      // mtime 缓存的失效判据就是 mtime，同毫秒写入时两者相等是文件系统精度问题，
      // 不是缺陷——用未来 mtime 才能确定性地验证"缓存确实按 mtime 失效"
      const payload = JSON.stringify({
        active: null, next: 9,
        list: [{ id: 'd5', kind: 'local', name: '手加的', path: TEST_DOWNLOAD_DIR, addedAt: new Date().toISOString() }],
      })
      fs.writeFileSync(f, payload, 'utf8')
      const future = new Date(Date.now() + 5000)
      fs.utimesSync(f, future, future)
      const after = svc.dest.list()
      assert.strictEqual(after.length, 1, '外部改动后应读到新内容')
      assert.strictEqual(after[0].id, 'd5', `读到的应是外部写入的条目，实际 ${after.map((d) => d.id).join(',')}`)
      // next 校对：maxId=5 → 下次新增必须拿到不冲突的 id
      svc.dest.addLocal(tmpDir('ncm-dest2-'))
      const ids = svc.dest.list().map((d) => d.id)
      assert.strictEqual(new Set(ids).size, ids.length, `id 不得重复: ${ids.join(',')}`)
    } finally { svc.dest._useFile(path.join(TEST_DOWNLOAD_DIR, 'destinations.json')) }
  })

  await t('dest: addPhone 路径归一（点段/双斜杠/控制字符）', () => {
    const origStatus = svc.adb.status
    const origProbe = svc.adb.probeWritable
    const f = path.join(TEST_DOWNLOAD_DIR, 'dest-phone.json')
    svc.dest._useFile(f)
    try {
      svc.adb.status = () => ({ state: 'ready', device: { serial: 'S' }, message: 'x' })
      const probed = []
      svc.adb.probeWritable = (d) => { probed.push(d) }
      // 三种等价写法必须归一到同一串，且只入列一次
      svc.dest.addPhone('/sdcard/Music')
      svc.dest.addPhone('/sdcard//./Music/')
      svc.dest.addPhone('/sdcard/Music/sub/..')
      assert.deepStrictEqual(probed, ['/sdcard/Music', '/sdcard/Music', '/sdcard/Music'],
        `等价写法必须归一到同一串，实际: ${probed.join(' | ')}`)
      assert.strictEqual(svc.dest.list().length, 1, '/sdcard/Music 与其等价写法只能入列一次')
      // 真正不同的子目录应另入一条
      svc.dest.addPhone('/sdcard/Music/子目录')
      assert.strictEqual(svc.dest.list().length, 2)
      // 控制字符必须被拒：Windows argv 会在 NUL 处截断，探针会作用在另一条路径上并"成功"，
      // 之后歌落在别处而界面显示的是这条路 —— 用拼接构造，避免源码里出现真实控制字节
      const withCtrl = (code) => '/sdcard/Music' + String.fromCharCode(code) + '/x'
      assert.throws(() => svc.dest.addPhone(withCtrl(0)), /控制字符/, 'NUL 必须被拒')
      assert.throws(() => svc.dest.addPhone(withCtrl(10)), /控制字符/, '换行必须被拒')
      assert.throws(() => svc.dest.addPhone(withCtrl(127)), /控制字符/, 'DEL 必须被拒')
      assert.strictEqual(svc.dest.list().length, 2, '被拒的路径不得入列（不得留半条目）')
      // 根目录不可用（批次需要子目录）
      assert.throws(() => svc.dest.addPhone('/'), /文件夹路径/)
    } finally {
      svc.adb.status = origStatus
      svc.adb.probeWritable = origProbe
      svc.dest._useFile(path.join(TEST_DOWNLOAD_DIR, 'destinations.json'))
    }
  })

  await t('phone: 目录缺失/扫描失败按空目录继续（不再掀掉整批）', async () => {
    const origResolve = core.url.resolve
    const origListFiles = core.adb.listFiles
    const origMkdirP = core.adb.mkdirP
    const origReadText = core.adb.readText
    const origPush = core.adb.pushBuffer
    const origShell = core.adb.shell
    const origStatus = svc.adb.status
    const origInvalidate = svc.adb.invalidate
    const origFetch = global.fetch
    try {
      svc.adb.invalidate = () => {}
      svc.adb.status = () => ({ state: 'ready', device: { serial: 'S' }, message: 'x' })
      core.adb.mkdirP = () => {}
      core.adb.pushBuffer = () => {}
      core.adb.shell = () => {} // 索引合并的 mv：不打桩会打到真实 adb
      core.adb.readText = () => { throw new Error('No such file') }
      // 关键：扫描目录直接抛错（设备拔了/目录被删），此前这一句在 try 之外 → 整批零首下载
      core.adb.listFiles = () => { throw new Error('find: /sdcard/Music/T: No such file or directory') }
      core.url.resolve = async () => ({ url: 'http://stub/1.mp3', br: 320000, size: 3, level: 'exhigh', ext: 'mp3' })
      global.fetch = async () => new Response(Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x00\xff\xfbabc'), { status: 200 })
      const songs = [{ id: '1', name: '甲', artist: 'A', album: 'B', picUrl: '', picId: 'p' }]
      const results = await svc.phone.downloadMany(songs, { dir: '/sdcard/Music/T', br: 320, cover: false })
      assert.strictEqual(results.length, 1, '扫描失败后仍应逐首处理，不能整批消失')
      assert.ok(results[0].ok, `该首应正常直写，实际: ${results[0].error}`)
    } finally {
      core.url.resolve = origResolve
      core.adb.listFiles = origListFiles
      core.adb.mkdirP = origMkdirP
      core.adb.readText = origReadText
      core.adb.pushBuffer = origPush
      core.adb.shell = origShell
      svc.adb.status = origStatus
      svc.adb.invalidate = origInvalidate
      global.fetch = origFetch
    }
  })

  await t('phone: noAdb 中止整批（不逐首白烧取流）', async () => {
    const origResolve = core.url.resolve
    const origListFiles = core.adb.listFiles
    const origMkdirP = core.adb.mkdirP
    const origReadText = core.adb.readText
    const origPush = core.adb.pushBuffer
    const origStatus = svc.adb.status
    const origInvalidate = svc.adb.invalidate
    const origFetch = global.fetch
    let resolveCalls = 0
    try {
      svc.adb.invalidate = () => {}
      svc.adb.status = () => ({ state: 'ready', device: { serial: 'S' }, message: 'x' })
      core.adb.mkdirP = () => {}
      core.adb.listFiles = () => []
      core.adb.readText = () => { throw new Error('No such file') }
      core.url.resolve = async () => { resolveCalls++; return { url: 'http://stub/1.mp3', br: 320000, size: 3, level: 'exhigh', ext: 'mp3' } }
      global.fetch = async () => new Response(Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x00\xff\xfbabc'), { status: 200 })
      // adb 可执行文件消失：环境故障，等设备回来也等不到
      core.adb.pushBuffer = () => { throw Object.assign(new Error('未找到 adb 可执行文件'), { noAdb: true }) }
      const songs = Array.from({ length: 5 }, (_, i) => ({ id: String(i + 1), name: '歌' + i, artist: 'A', album: 'B', picUrl: '', picId: 'p' }))
      let err = null
      try { await svc.phone.downloadMany(songs, { dir: '/sdcard/Music/T', br: 320, cover: false }) } catch (e) { err = e }
      assert.ok(err, 'adb 缺失必须中止整批')
      assert.strictEqual(resolveCalls, 1, `只应尝试第一首（实际解链 ${resolveCalls} 次）——每首都完整下载再失败就是白烧网易请求`)
    } finally {
      core.url.resolve = origResolve
      core.adb.listFiles = origListFiles
      core.adb.mkdirP = origMkdirP
      core.adb.readText = origReadText
      core.adb.pushBuffer = origPush
      svc.adb.status = origStatus
      svc.adb.invalidate = origInvalidate
      global.fetch = origFetch
    }
  })

  await t('phone: 标签内嵌失败不丢整首（embedError 口径与本地管线一致）', async () => {
    const origResolve = core.url.resolve
    const origListFiles = core.adb.listFiles
    const origMkdirP = core.adb.mkdirP
    const origReadText = core.adb.readText
    const origPush = core.adb.pushBuffer
    const origStatus = svc.adb.status
    const origInvalidate = svc.adb.invalidate
    const origFetch = global.fetch
    const origEmbed = core.tag.embedMp3Buf
    const origShell = core.adb.shell
    const pushed = []
    try {
      svc.adb.invalidate = () => {}
      svc.adb.status = () => ({ state: 'ready', device: { serial: 'S' }, message: 'x' })
      core.adb.mkdirP = () => {}
      core.adb.listFiles = () => []
      core.adb.readText = () => { throw new Error('No such file') }
      core.adb.shell = () => {} // 索引合并的 mv：不打桩会打到真实 adb（保险丝会拦）
      // pushBuffer 会被音频与索引各调一次，故按路径区分而不是数总次数
      core.adb.pushBuffer = (buf, p) => { pushed.push({ p: String(p), len: buf.length }) }
      core.url.resolve = async () => ({ url: 'http://stub/1.mp3', br: 320000, size: 11, level: 'exhigh', ext: 'mp3' })
      global.fetch = async () => new Response(Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x00\xff\xfbabc'), { status: 200 })
      core.tag.embedMp3Buf = () => { throw new Error('旧 ID3 结构异常（测试注入）') }
      const songs = [{ id: '1', name: '甲', artist: 'A', album: 'B', picUrl: '', picId: 'p' }]
      const results = await svc.phone.downloadMany(songs, { dir: '/sdcard/Music/T', br: 320, cover: false })
      assert.strictEqual(results.length, 1)
      assert.ok(results[0].ok, `打标签失败不得让整首丢失，实际: ${results[0].error}`)
      assert.ok(results[0].embedError, '应记录 embedError（本地管线同名机制，任务日志会显示"（内嵌失败：…）"）')
      const audioPush = pushed.find((x) => /\.mp3$/.test(x.p))
      assert.ok(audioPush, `音频原样仍应被推上设备（实际推送: ${pushed.map((x) => x.p).join(', ')}）`)
    } finally {
      core.tag.embedMp3Buf = origEmbed
      core.adb.shell = origShell
      core.url.resolve = origResolve
      core.adb.listFiles = origListFiles
      core.adb.mkdirP = origMkdirP
      core.adb.readText = origReadText
      core.adb.pushBuffer = origPush
      svc.adb.status = origStatus
      svc.adb.invalidate = origInvalidate
      global.fetch = origFetch
    }
  })

  await t('server: /api/dest/active 的三类入参（缺 body 400 / 空串切回缺省 / 坏 id 400）', async () => {
    const serverMod = require('../server')
    const srv = serverMod.app.listen(0)
    await new Promise((r) => srv.on('listening', r))
    const base = `http://127.0.0.1:${srv.address().port}`
    // 用独立的 destinations.json 隔离，避免动到别的用例留下的激活态
    svc.dest._useFile(path.join(TEST_DOWNLOAD_DIR, 'dest-active.json'))
    const post = (body, raw) => fetch(`${base}/api/dest/active`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: raw === undefined ? JSON.stringify(body) : raw,
    })
    try {
      // body 不是 JSON 对象时必须 400 且不得静默改目的地。
      // 注意 JSON 字面量 'null' 会被 body-parser 的 strict 模式先拒掉（也归 400，
      // 但走的是解析失败那条路）；'id=abc' 这种非 JSON 则 req.body 为 undefined，
      // 旧写法会走 id='' 把目的地**静默改回缺省**并返回 200
      const none = await post(undefined, 'null')
      assert.strictEqual(none.status, 400, `非对象 body 必须 400（实际 ${none.status}）`)
      assert.ok(/"error":/.test(await none.text()), '必须回 JSON 错误，而不是 HTML 错误页')
      const txt = await post(undefined, 'id=abc')
      assert.strictEqual(txt.status, 400, `非 JSON body 必须 400（实际 ${txt.status}）`)
      // 数组 body 同样必须 400（Array.isArray 要单独判，'id' in [] 恒 false）
      const arr = await post(undefined, '[]')
      assert.strictEqual(arr.status, 400, `数组 body 必须 400（实际 ${arr.status}）`)
      // 空串是合法输入：切回缺省下载目录（UI 下拉第一项传的就是空串）
      const back = await post({ id: '' })
      assert.strictEqual(back.status, 200, `空串必须切回缺省（实际 ${back.status}）`)
      assert.ok(/"active":null/.test(await back.text()), '空串必须切回缺省目录')
      const backNull = await post({ id: null })
      assert.strictEqual(backNull.status, 200, `id:null 也必须切回缺省（实际 ${backNull.status}）`)
      assert.ok(/"active":null/.test(await backNull.text()))
      // 不存在的 id 归 400 且文案可读（不再把请求体原值当错误信息）
      const bad = await post({ id: 'nope' })
      assert.strictEqual(bad.status, 400)
      const badText = await bad.text()
      assert.ok(/不存在/.test(badText), `错误文案应说明"不存在"，实际: ${badText}`)
      assert.ok(!/"error":"nope"/.test(badText), '不得把用户输入原值当错误信息回显')
    } finally {
      if (srv.closeAllConnections) srv.closeAllConnections()
      srv.close()
      svc.dest._useFile(path.join(TEST_DOWNLOAD_DIR, 'destinations.json'))
    }
  })

  await t('login: 二次 /api/login/start 不得开出第二条轮询（busy 独占）', async () => {
    const origCreateQr = svc.login.createQr
    const origPoll = svc.login.pollQr
    let pollStarted = 0
    let qrCalls = 0
    try {
      svc.login.createQr = async () => { qrCalls++; return 'KEY-' + qrCalls }
      // 挂住不 resolve：模拟"第一轮还在等用户扫码"
      svc.login.pollQr = () => { pollStarted++; return new Promise(() => {}) }
      const serverMod = require('../server')
      const srv = serverMod.app.listen(0)
      await new Promise((r) => srv.on('listening', r))
      const base = `http://127.0.0.1:${srv.address().port}`
      try {
        const a = await (await fetch(`${base}/api/login/start`)).json()
        assert.strictEqual(a.started, true)
        assert.strictEqual(a.already, undefined)
        // 关键：状态已从 running 变为 running 之后（用户扫码 → 'scanned'）再点一次，
        // 旧口径拿 status==='running' 当守卫会开出第二条轮询；两轮共用一个 qr.png，
        // 先结束的那轮会把另一轮的二维码删掉
        const st = await (await fetch(`${base}/api/login/status`)).json()
        assert.ok(['running', 'idle', 'error'].includes(st.status), `意外状态 ${st.status}`)
        const b = await (await fetch(`${base}/api/login/start`)).json()
        assert.strictEqual(b.already, true, '已有轮询在跑时必须返回 already=true')
        assert.strictEqual(qrCalls, 1, '不得重复生成二维码')
        assert.strictEqual(pollStarted, 1, '不得开出第二条轮询')
      } finally { if (srv.closeAllConnections) srv.closeAllConnections(); srv.close() }
    } finally {
      svc.login.createQr = origCreateQr
      svc.login.pollQr = origPoll
    }
  })

  await t('incremental: plan 对残缺/畸形 index 一律给出闭合账目（不抛）', () => {
    const S = (id, name, artist) => ({ id: String(id), name, artist: artist || 'A', album: 'B', picUrl: '', picId: 'p' })
    const shapes = {
      '完全不传 index': undefined,
      '空对象': {},
      '缺 audio': { lrc: new Set() },
      '缺 lrc': { audio: new Map([['a', new Set(['mp3'])]]) },
      'audio/lrc 形状不对': { audio: [], lrc: {}, idMap: 'x' },
      '正常空目录': { audio: new Map(), lrc: new Set() },
      '已有音频与词': { audio: new Map([['a', new Set(['mp3'])]]), lrc: new Set(['a']) },
      '有音频缺词': { audio: new Map([['a', new Set(['mp3'])]]), lrc: new Set() },
    }
    for (const [name, idx] of Object.entries(shapes)) {
      const songs = [S(1, 'a')]
      const p = idx === undefined ? svc.incremental.plan(songs) : svc.incremental.plan(songs, idx)
      assert.strictEqual(p.download.length + p.fill.length + p.skipped.length, songs.length,
        `${name}：账目必须闭合（下载+补词+跳过 = 总数）`)
      assert.strictEqual(p.bases.size, songs.length, `${name}：每首歌都必须有命名分配`)
      // 关闭补词后仍要闭合（fill 并入 skipped）
      const q = idx === undefined
        ? svc.incremental.plan(songs, {}, { lyrics: false })
        : svc.incremental.plan(songs, idx, { lyrics: false })
      assert.strictEqual(q.download.length + q.fill.length + q.skipped.length, songs.length,
        `${name}：lyrics=false 时账目仍须闭合`)
      assert.strictEqual(q.fill.length, 0, `${name}：lyrics=false 时不得再有补词项`)
    }
  })

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
  console.log(`\n== 单元测试: ${results.length - fails}/${results.length} 通过 ==`)
  console.log(`== 耗时 ${Date.now() - suiteStart}ms（纯本地 stub + 127.0.0.1 回环，无外网） ==`)
  process.exit(fails ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
