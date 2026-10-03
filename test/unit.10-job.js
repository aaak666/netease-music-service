/**
 * 单测分件（由 test/unit.test.js 拆出）：10-job
 * 桩/收集器见 unit.harness.js；本文件只注册用例，执行由入口调度。
 */
const { t, assert, fs, os, path, core, svc, tmpDir, until, makeGate, stubPhoneIo, fakeAudioFetch, withStubbedPhone, execFileStub, childProcess, TEST_DOWNLOAD_DIR } = require('./unit.harness')

module.exports = async function () {

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

  await t('job: fm/simi 数量上限（>MAX_RECOMMEND_TOTAL 提前 400，不进取曲链路白烧请求）', async () => {
    const over = await svc.job.createTask({ source: 'fm', total: svc.job.MAX_RECOMMEND_TOTAL + 1 }, { downloadDir: 'X:\\d' })
    assert.strictEqual(over.code, 400, `超上限应 400，实际 ${over.code}`)
    assert.ok(/数量过大/.test(over.body.error), `文案应提示分批: ${over.body.error}`)
    const simi = await svc.job.createTask({ source: 'simi', id: '1', total: 99999 }, { downloadDir: 'X:\\d' })
    assert.strictEqual(simi.code, 400)
    assert.ok(/数量过大/.test(simi.body.error))
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
}
