/**
 * 单测分件（由 test/unit.test.js 拆出）：02-tag-lyric
 * 桩/收集器见 unit.harness.js；本文件只注册用例，执行由入口调度。
 */
const { t, assert, fs, os, path, core, svc, tmpDir, until, makeGate, stubPhoneIo, fakeAudioFetch, withStubbedPhone, execFileStub, childProcess, TEST_DOWNLOAD_DIR } = require('./unit.harness')

module.exports = async function () {

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

  await t('meting: 格式组装', () => {
    const item = svc.meting.toMetingItem({ id: 1, name: 'x', artist: 'a/b' }, 'http://x/meting')
    assert.strictEqual(item.url, 'http://x/meting?type=url&id=1')
    assert.strictEqual(item.pic, 'http://x/meting?type=pic&id=1')
    assert.strictEqual(item.lrc, 'http://x/meting?type=lrc&id=1')
    assert.strictEqual(item.artist, 'a/b')
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
}
