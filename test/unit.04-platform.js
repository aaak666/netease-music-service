/**
 * 单测分件（由 test/unit.test.js 拆出）：04-platform
 * 桩/收集器见 unit.harness.js；本文件只注册用例，执行由入口调度。
 */
const { t, assert, fs, os, path, core, svc, tmpDir, until, makeGate, stubPhoneIo, fakeAudioFetch, withStubbedPhone, execFileStub, childProcess, TEST_DOWNLOAD_DIR } = require('./unit.harness')

module.exports = async function () {

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

  await t('login: pollQr 瞬时错续轮 / 终态错速败 / 800 过期 三口径（决策 41 回归锁）', async () => {
    const origCheckQr = core.login.checkQr
    const origSave = core.cookie.save
    const origGet = core.cookie.get
    try {
      core.cookie.save = () => {}
      core.cookie.get = () => 'MUSIC_U=KEEP'
      // 1) 瞬时错误（fetch failed）不判死：前两轮抖动、第三轮成功 → 轮询继续并最终返回
      let n = 0
      core.login.checkQr = async () => {
        n++
        if (n < 3) throw new Error('fetch failed')
        return { code: 803, cookie: 'MUSIC_U=RETRY_OK' }
      }
      const ok = await svc.login.pollQr('k', { timeout: 30000 })
      assert.strictEqual(ok, 'MUSIC_U=KEEP', `瞬时错误应续轮到成功（实际轮询 ${n} 次）`)
      assert.strictEqual(n, 3, '瞬时错误后应继续调用 checkQr，而不是直接超时收尾')
      // 2) 终态错误速败：本可速败的问题不得拖满外层 timeout
      core.login.checkQr = async () => { const e = new Error('key 非法'); e.noUrl = true; throw e }
      let err = null
      try { await svc.login.pollQr('k', { timeout: 30000 }) } catch (e) { err = e }
      assert.ok(err && !/登录超时/.test(err.message), `终态错误必须立即上抛，实际: ${err && err.message}`)
      // 3) 800：如实报"二维码已过期"
      core.login.checkQr = async () => ({ code: 800 })
      err = null
      try { await svc.login.pollQr('k', { timeout: 30000 }) } catch (e) { err = e }
      assert.ok(err && /过期/.test(err.message), `800 应报过期，实际: ${err && err.message}`)
    } finally {
      core.login.checkQr = origCheckQr
      core.cookie.save = origSave
      core.cookie.get = origGet
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
}
