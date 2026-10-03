/**
 * 单测分件（由 test/unit.test.js 拆出）：05-download
 * 桩/收集器见 unit.harness.js；本文件只注册用例，执行由入口调度。
 */
const { t, assert, fs, os, path, core, svc, tmpDir, until, makeGate, stubPhoneIo, fakeAudioFetch, withStubbedPhone, execFileStub, childProcess, TEST_DOWNLOAD_DIR } = require('./unit.harness')

module.exports = async function () {

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

  await t('download: downloadMany 在每首边界感知 signal（已 abort 直接抛，不起网络）', async () => {
    const c = new AbortController()
    c.abort()
    await assert.rejects(
      () => svc.download.downloadMany([{ id: 1, name: '歌' }], { dir: 'x', signal: c.signal }),
      (e) => e.name === 'AbortError' || /取消|abort/i.test(e.message),
    )
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

  await t('download: 批次内重复对象也必须回 onFile（两条管线口径一致）', async () => {
    // 决策 75。本地管线对"同一歌单里同一首歌出现两次（同一对象）"记了失败结果却没调
    // onFile，于是既不计入 processed 也不进日志；手机管线同一情形是调了的
    const dir = fs.mkdtempSync(path.join(TEST_DOWNLOAD_DIR, 'ncm-dupref-'))
    // 桩的保存必须在 try 外（try 内 const 对 finally 不可见）；还原必须在 finally（断言失败也要还原：
    // 此处漏还原 embedMp3Buf（原样返回裸音频）曾让后跑的手机管线"打标签"拿到 3 字节裸音频被
    // verifyAudioHead 正当拒收——单看用例本身全绿，顺序一变就翻红，极难排查）
    const origFetch = core.raw.fetchBuffer
    const origStream = core.raw.streamTo
    const origEmbed = core.tag.embedMp3Buf
    const origGetDetail = core.song.getDetail
    try {
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
    } finally {
      core.raw.fetchBuffer = origFetch
      core.raw.streamTo = origStream
      core.tag.embedMp3Buf = origEmbed
      core.song.getDetail = origGetDetail
      fs.rmSync(dir, { recursive: true, force: true })
    }
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
}
