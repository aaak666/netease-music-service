/**
 * 单测分件（由 test/unit.test.js 拆出）：11-server
 * 桩/收集器见 unit.harness.js；本文件只注册用例，执行由入口调度。
 */
const { t, assert, fs, os, path, core, svc, tmpDir, until, makeGate, stubPhoneIo, fakeAudioFetch, withStubbedPhone, execFileStub, childProcess, TEST_DOWNLOAD_DIR } = require('./unit.harness')

module.exports = async function () {

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
      // 5) Win32 尾字符剥离（决策 71 的 '..%20' 形态）：'.. ' 的字符串前缀检查能过，
      //    但 Win32 文件系统会吃掉尾空格使其变成 '..' —— 归一守卫必须先剥再判。
      //    （盘符/ADS 形态如 'x:ads' 无需专测：win32 的 basename 本就把盘符段剥掉，
      //     解析结果恒在根内，守卫的 ':' 正则只是 POSIX 侧的兜底）
      lastOpenByDir.set(root, Date.now())
      const r5 = await reqOpen('.. ')
      assert.strictEqual(r5.dir, root, "'.. '（尾空格）应被归一守卫挡在根目录外")
      assert.strictEqual(r5.throttled, true)
      assert.strictEqual(execFileStub.calls.length, 1, '守卫拦截场景全程不得 exec')
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
}
