/**
 * 单测分件（由 test/unit.test.js 拆出）：06-storage
 * 桩/收集器见 unit.harness.js；本文件只注册用例，执行由入口调度。
 */
const { t, assert, fs, os, path, core, svc, tmpDir, until, makeGate, stubPhoneIo, fakeAudioFetch, withStubbedPhone, execFileStub, childProcess, TEST_DOWNLOAD_DIR } = require('./unit.harness')

module.exports = async function () {

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
}
