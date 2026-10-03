/**
 * 单测分件（由 test/unit.test.js 拆出）：03-fetchers
 * 桩/收集器见 unit.harness.js；本文件只注册用例，执行由入口调度。
 */
const { t, assert, fs, os, path, core, svc, tmpDir, until, makeGate, stubPhoneIo, fakeAudioFetch, withStubbedPhone, execFileStub, childProcess, TEST_DOWNLOAD_DIR } = require('./unit.harness')

module.exports = async function () {

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
}
