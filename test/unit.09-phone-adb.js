/**
 * 单测分件（由 test/unit.test.js 拆出）：09-phone-adb
 * 桩/收集器见 unit.harness.js；本文件只注册用例，执行由入口调度。
 */
const { t, assert, fs, os, path, core, svc, tmpDir, until, makeGate, stubPhoneIo, fakeAudioFetch, withStubbedPhone, execFileStub, childProcess, TEST_DOWNLOAD_DIR } = require('./unit.harness')

module.exports = async function () {

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
    // 一次性重载（withStubbedPhone）：与任何跨用例残留的模块状态彻底绝缘。本用例曾在按领域
    // 拆分执行顺序后暴露出顺序脆弱性——单跑必绿、长序列必红（stub fetch 的响应体被跨用例状态
    // 干扰成空），hermetic 重载后根除，不再依赖用例间的执行顺序
    const origFetch = global.fetch
    const origInvalidate = svc.adb.invalidate
    const origLyricGet = core.lyric.get
    const { phone, restore } = withStubbedPhone({
      resolveWithFallback: async () => ({ url: 'http://stub/1.mp3', br: 320000, size: 2, level: 'exhigh', ext: 'mp3' }),
      // 序列桩：批次开头的预检查时设备在线（真实断连场景 = 中途拔线），此后一直不在线
      status: { state: 'ready', device: { serial: 'S', state: 'device' }, message: 'x' },
      statusAfter: { state: 'no-device', device: null, message: '未检测到已连接的设备' },
      statusAfterAt: 1,
      adb: { pushBuffer: () => { throw new Error('error: device offline') } },
    })
    phone._tuning.graceMs = 40
    phone._tuning.rounds = 1
    svc.adb.invalidate = () => {}
    // 假音频流：取流阶段本地完成（不碰网络），失败点落在设备推送。
    // 音频给合法 ID3 头 + 帧体（过 verifyAudioHead 的 <4B 拒收），content-length 与实际严格一致——
    // 本用例聚焦断连，不依赖截断口径（74B 与 72B 之差都会被 assertIntegrity 正当判"截断"）
    const fakeMp3 = Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x00' + 'x'.repeat(64))
    global.fetch = async (...a) => {
      const r = new Response(fakeMp3, { status: 200, headers: { 'content-length': String(fakeMp3.length) } })
      return r
    }
    core.lyric.get = async () => ({ lrc: '[00:01]x', tlyric: '' })
    try {
      const songs = [{ id: 1, name: '甲', artist: 'A' }, { id: 2, name: '乙', artist: 'B' }]
      let err = null
      let seen = 0
      try {
        await phone.downloadMany(songs, { dir: '/sdcard/Music/T [1]', br: 320, cover: false, onFile: () => seen++ })
      } catch (e) { err = e }
      assert.ok(err && err.deviceGone, 'downloadMany 必须把 deviceGone 上抛中止整批')
      assert.ok(/手机已断开/.test(err.message))
      assert.strictEqual(seen, 1, '只有第一首记失败，第二首不得再走取流空转')
      // fillLyric：设备断连上抛（否则整份 fill 列表逐首各等一轮宽限）
      err = null
      try { await phone.fillLyric({ id: 1, name: '甲' }, '/sdcard/Music/T [1]', '甲') } catch (e) { err = e }
      assert.ok(err && err.deviceGone, 'fillLyric 遇设备断连必须上抛')
      // 对照：普通歌词失败仍吞掉返回失败结果（不中止批次）；状态桩改回常在线，绕过 prepare 的断连判定
      svc.adb.status = () => ({ state: 'ready', device: { serial: 'S', state: 'device' }, message: 'x' })
      core.adb.pushBuffer = () => { throw new Error('设备端写入失败: exit 1') }
      const r = await phone.fillLyric({ id: 1, name: '甲' }, '/sdcard/Music/T [1]', '甲')
      assert.strictEqual(r.ok, false)
      assert.ok(r.error, '普通失败照旧返回结果对象')
    } finally {
      global.fetch = origFetch
      svc.adb.invalidate = origInvalidate
      core.lyric.get = origLyricGet
      restore()
    }
  })

  await t('phone: CDN 透明压缩（content-encoding）时跳过截断/大小断言——两管线同守卫', async () => {
    // 场景：响应带 content-encoding（如 gzip），content-length 是压缩字节数、实收是解压后
    // 字节数，两者必然不等——无守卫时手机管线会把正常文件逐首误判"下载截断"终态失败。
    // 一次性重载（withStubbedPhone）：与跨用例残留的模块状态绝缘（理由同上条断连用例）
    const origFetch = global.fetch
    const origInvalidate = svc.adb.invalidate
    const origLyricGet = core.lyric.get
    const { phone, restore } = withStubbedPhone({
      resolveWithFallback: async () => ({ url: 'http://stub/1.mp3', br: 320000, size: 2, level: 'exhigh', ext: 'mp3' }),
      status: { state: 'ready', device: { serial: 'S', state: 'device' }, message: 'x' },
    })
    svc.adb.invalidate = () => {}
    // content-length: 2 与实收 3B 故意不符 + content-encoding: gzip——无守卫必抛"截断/大小异常"
    global.fetch = async () => new Response(Buffer.from('abc'), {
      status: 200,
      headers: { 'content-length': '2', 'content-encoding': 'gzip' },
    })
    core.lyric.get = async () => ({ lrc: '[00:01]x', tlyric: '' })
    try {
      const results = await phone.downloadMany([{ id: 1, name: '甲', artist: 'A' }], { dir: '/sdcard/Music/E [1]', br: 320, cover: false })
      assert.strictEqual(results.length, 1)
      assert.strictEqual(results[0].ok, true, `压缩响应不得误判截断/大小异常: ${results[0].error || ''}`)
      assert.ok(results[0].size >= 3, '音频字节应完整进入打标签流程（size 为打标签后长度）')
    } finally {
      global.fetch = origFetch
      svc.adb.invalidate = origInvalidate
      core.lyric.get = origLyricGet
      restore()
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
}
