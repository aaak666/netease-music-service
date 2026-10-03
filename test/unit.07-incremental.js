/**
 * 单测分件（由 test/unit.test.js 拆出）：07-incremental
 * 桩/收集器见 unit.harness.js；本文件只注册用例，执行由入口调度。
 */
const { t, assert, fs, os, path, core, svc, tmpDir, until, makeGate, stubPhoneIo, fakeAudioFetch, withStubbedPhone, execFileStub, childProcess, TEST_DOWNLOAD_DIR } = require('./unit.harness')

module.exports = async function () {

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
}
