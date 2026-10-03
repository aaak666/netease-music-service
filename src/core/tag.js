/**
 * 标签底层原语：把封面内嵌进音频文件 + 产物合规性反向校验
 * 纯字节操作零依赖。MP3 走 ID3v2.3（APIC + 文本帧），FLAC 走 METADATA_BLOCK_PICTURE + VORBIS_COMMENT
 * verify* 会按规范重新解析产物，确保严格播放器（如 foobar2000）可读
 */
const fs = require('fs')

// ---------- 字节工具 ----------
const syncSafe = (n) => Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f])
const readSyncSafe = (b, off) => ((b[off] & 0x7f) << 21) | ((b[off + 1] & 0x7f) << 14) | ((b[off + 2] & 0x7f) << 7) | (b[off + 3] & 0x7f)
const u32be = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b }
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b }
const u24be = (n) => Buffer.from([(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff])

/** ID3v2.3 文本帧：编码 0x01 = UTF-16LE 带 BOM（中文必需）；undefined/null 写空串而非字面量 "undefined" */
function id3TextFrame(id, text) {
  const body = Buffer.concat([Buffer.from([0x01]), Buffer.from('\ufeff' + String(text == null ? '' : text), 'utf16le')])
  return Buffer.concat([Buffer.from(id, 'ascii'), u32be(body.length), Buffer.from([0, 0]), body])
}

/** ID3v2.3 APIC 封面帧：编码 0 / mime / 图片类型 3(封面正面) / 空描述 / 图片数据 */
function id3ApicFrame(mime, cover) {
  const body = Buffer.concat([
    Buffer.from([0x00]),
    Buffer.from(mime + '\0', 'ascii'),
    Buffer.from([0x03, 0x00]),
    cover,
  ])
  return Buffer.concat([Buffer.from('APIC', 'ascii'), u32be(body.length), Buffer.from([0, 0]), body])
}

/** 从 PNG(IHDR) / JPEG(SOFn) 头读宽高，读不到返回 0（规范允许未知） */
function imageDims(buf) {
  try {
    if (buf[0] === 0x89 && buf[1] === 0x50) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let p = 2
      while (p + 9 < buf.length) {
        if (buf[p] !== 0xff) { p++; continue }
        const marker = buf[p + 1]
        const len = buf.readUInt16BE(p + 2)
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { h: buf.readUInt16BE(p + 5), w: buf.readUInt16BE(p + 7) }
        }
        p += 2 + len
      }
    }
  } catch { /* 截断/畸形图片：宽高未知不致命，不能让 RangeError 冒出来模糊真实报错 */ }
  return { w: 0, h: 0 }
}

/** FLAC METADATA_BLOCK_PICTURE 块体 */
function flacPictureBody(mime, cover) {
  const { w, h } = imageDims(cover)
  return Buffer.concat([
    u32be(3), // 封面正面
    u32be(mime.length), Buffer.from(mime, 'ascii'),
    u32be(0), // 空描述
    u32be(w), u32be(h), u32be(24), u32be(0), // 色深 24bit，颜色数 0=未知
    u32be(cover.length), cover,
  ])
}

/** FLAC VORBIS_COMMENT 块体（注意：此结构全部小端） */
function flacVorbisBody(fields) {
  const vendor = Buffer.from('netease-music-service', 'ascii')
  const comments = Object.entries(fields).map(([k, v]) => Buffer.from(`${k}=${v}`, 'utf8'))
  const parts = [u32le(vendor.length), vendor, u32le(comments.length)]
  for (const c of comments) parts.push(u32le(c.length), c)
  return Buffer.concat(parts)
}

/** 解析 VORBIS_COMMENT 块体 → 普通对象（同名键后者覆盖）；畸形输入返回空对象不抛错 */
function parseVorbisBody(body) {
  try {
    let p = 0
    const vendorLen = body.readUInt32LE(p); p += 4 + vendorLen
    const count = body.readUInt32LE(p); p += 4
    const fields = {}
    for (let i = 0; i < count; i++) {
      const len = body.readUInt32LE(p); p += 4
      const kv = body.subarray(p, p + len).toString('utf8'); p += len
      const eq = kv.indexOf('=')
      if (eq > 0) fields[kv.slice(0, eq).toUpperCase()] = kv.slice(eq + 1)
    }
    return fields
  } catch { /* 畸形旧注释块当"无标签"处理，后续重建会覆盖出干净结构 */ }
  return {}
}

// ---------- 内嵌 ----------
/**
 * 写盘前内存校验（纯函数，单元测试直接调它，不写盘）：
 * buf 非空且头部是预期音频魔数——MP3→ID3 或 MPEG 帧同步 0xFFEx，FLAC→fLaC。
 * 调用方（replaceAtomic）在打开临时文件前先验它，坏 buf 直接抛错不落盘。
 * @returns true=通过（抛错=不通过）
 */
function verifyAudioHead(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) throw new Error('音频数据为空或过短，拒绝写盘')
  const isID3 = buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33 // 'ID3'
  const isMp3Frame = buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0 // MPEG 帧同步
  const isFlac = buf[0] === 0x66 && buf[1] === 0x4c && buf[2] === 0x61 && buf[3] === 0x43 // 'fLaC'
  if (!(isID3 || isMp3Frame || isFlac)) throw new Error('音频头校验失败，拒绝写盘')
  return true
}

/**
 * 原子替换写盘：同目录临时文件写入 → fsync → 落盘校验 → rename 覆盖目标
 * 任一步失败都删临时文件并抛错，目标文件保持原样——内嵌失败的最坏结果是"没嵌上封面"（仍可播放），
 * 不再是"文件被截断"（那会计为"完成"，并被增量按文件名存在永久跳过）
 * 临时名 .tagtmp 结尾：不匹配 incremental.scanDir 的 mp3|flac|lrc 规则（不会被认领成正式歌曲），
 * 也不在启动清扫白名单里（崩溃残留会被 sweepDownloads 兜底删掉）——与下载半成品 .part 同一套思路
 */
function replaceAtomic(audioPath, buf) {
  // 写盘前先验内存里的完整 buf：坏 buf 直接抛错，一个字节也不落盘
  verifyAudioHead(buf)
  const tmp = audioPath + '.tagtmp'
  let fd = null
  try {
    fd = fs.openSync(tmp, 'w')
    const written = fs.writeSync(fd, buf)
    fs.fsyncSync(fd) // 数据先落盘再改名：改名只动目录项，断电也不会出现"名字换了、内容半截"
    fs.closeSync(fd)
    fd = null
    if (written !== buf.length) throw new Error('临时文件写入不完整')
    // 落盘校验：非空且头部仍是预期魔数（MP3→ID3、FLAC→fLaC），确认写出的是可用音频再改名
    const head = Buffer.alloc(4)
    const rfd = fs.openSync(tmp, 'r')
    try { fs.readSync(rfd, head, 0, 4, 0) } finally { fs.closeSync(rfd) }
    if (head.compare(buf.subarray(0, 4)) !== 0) throw new Error('临时文件头校验失败')
    fs.renameSync(tmp, audioPath) // 同目录（同卷）rename = 原子覆盖
  } catch (e) {
    if (fd !== null) { try { fs.closeSync(fd) } catch { /* 关闭失败忽略 */ } }
    try { fs.unlinkSync(tmp) } catch { /* 临时文件不存在或被占用，忽略 */ }
    throw e
  }
}

/**
 * MP3：重建 ID3v2.3 标签（丢弃旧标签，写入 标题/歌手/专辑，有封面则加 APIC），拼接在音频帧之前
 * 网易云源文件的旧 ID3 通常只有同名元数据，重建不丢有效信息；封面二进制由 embedCover 解析后传入
 * buffer 级纯函数：内存进内存出，文件版与本服务外的直写管线（手机目的地）共用
 */
function embedMp3Buf(audio, { title, artist, album, cover, mime }) {
  let rest = audio
  if (audio.subarray(0, 3).toString('ascii') === 'ID3') {
    // footer 标志（flags 位 0x10）只在 ID3v2.4 里有意义：v2.3 里同一位是 experimental 标志，
    // 不能据此多跳 10 字节（那会把首帧开头 10 字节音频当 footer 丢掉——无声事故）
    const footer = (audio[3] === 4 && (audio[5] & 0x10)) ? 10 : 0
    rest = audio.subarray(10 + readSyncSafe(audio, 6) + footer) // 跳过旧标签
    // 旧标签 size 撒谎（大于实际数据）时 rest 为空：产物会变成"只有标签没有音频"的废文件，
    // verifyAudioHead 只看 ID3 头拦不住它——宁可在这里抛错也不产出无声文件
    if (!rest.length || !(rest[0] === 0xff && (rest[1] & 0xe0) === 0xe0 || rest.subarray(0, 4).toString('ascii') === 'fLaC')) {
      // 文案用"结构异常"而非"大小异常"：后者命中 isTransient 的瞬时分支会被重试整首下载，
      // 而"旧标签 size 撒谎"是这份字节的固有属性，重下一遍还是同样撒谎（FLAC 侧同口径见 embedFlacBuf）
      throw new Error('ID3 结构异常（旧标签 size 越过音频数据），拒绝重建标签')
    }
  }
  const frames = [
    id3TextFrame('TIT2', title), id3TextFrame('TPE1', artist), id3TextFrame('TALB', album || ''),
  ]
  if (cover && cover.length) {
    frames.push(id3ApicFrame(mime || sniffImageMime(cover), cover))
  }
  const framesLen = frames.reduce((n, f) => n + f.length, 0)
  // ID3v2.3 的 size 字段是 28 位同步安全整数：超过 0x0FFFFFFF 时 syncSafe 的高位会带出
  // 标记位，读回来的 size 与写进去的不一致，产出一份帧链自相矛盾的标签。20MB 封面的护栏
  // 离这个上限还有约 13 倍余量，这里只是把"不可能发生"变成"发生了能说清"
  if (framesLen >= 0x10000000) throw new Error('封面过大，ID3 标签超出可编码尺寸')
  const tag = Buffer.concat([Buffer.from('ID3', 'ascii'), Buffer.from([0x03, 0x00, 0x00]), syncSafe(framesLen), ...frames])
  return Buffer.concat([tag, rest])
}

function embedMp3(audioPath, meta) {
  replaceAtomic(audioPath, embedMp3Buf(fs.readFileSync(audioPath), meta))
}

/**
 * FLAC：在 STREAMINFO 后插入 PICTURE 块（封面二进制可选）；VORBIS_COMMENT 总是保证存在
 * （合并现有注释并覆盖 TITLE/ARTIST/ALBUM——网易原文件常常只有 encoder 一个 tag）
 * 重建块链并保证"仅最后一块置 last 标志"；已有 PICTURE 块先剔除防重复
 * buffer 级纯函数（同 embedMp3Buf）
 */
function embedFlacBuf(buf, { title, artist, album, cover, mime }) {
  if (buf.subarray(0, 4).toString('ascii') !== 'fLaC') throw new Error('不是 FLAC 文件')
  let pos = 4
  const blocks = []
  let last = false
  // 截断/畸形块头会让 readUIntBE 抛裸 RangeError（文案不可读，还会被瞬时分级白烧一次重试）：
  // 包一层转成带"结构异常"字样的终态错误（error.js 按此判终态不重试）
  try {
    while (!last) {
      if (pos + 4 > buf.length) throw new Error('块头越出文件末尾')
      const head = buf[pos]
      const len = buf.readUIntBE(pos + 1, 3)
      if (pos + 4 + len > buf.length) throw new Error(`块(type=${head & 0x7f})长度越界`)
      blocks.push({ type: head & 0x7f, data: buf.subarray(pos + 4, pos + 4 + len) })
      last = Boolean(head & 0x80)
      pos += 4 + len
    }
  } catch (e) {
    throw new Error(`FLAC 结构异常（块链解析失败: ${e.message}），拒绝重建标签`)
  }
  // 块链之后必须是真音频帧（与 embedMp3Buf 检查"标签后还有音频"同一道闸）：
  // last 标志谎报（非末块置位）会让上面的循环提前停下、把剩下的元数据块当成音频原样拼上；
  // 文件在块边界处截断则让 pos 直接等于 buf.length。两种情况都会产出"元数据完好、整首无声"
  // 或解码器直接拒绝的废文件——verifyAudioHead/verifyFile 只看 fLaC 魔数，拦不住。
  // 触发路径真实存在：无 content-length 的分块响应 + 接口 size 缺失时，外层两道校验都会被跳过。
  // 文案带"结构异常"以命中 isTransient 的终态分支（不重试：同一份字节重建结果一样）
  if (pos + 2 > buf.length || !(buf[pos] === 0xff && (buf[pos + 1] & 0xfc) === 0xf8)) {
    throw new Error('FLAC 结构异常（块链后无音频帧），拒绝重建标签')
  }
  // 旧封面块与旧 VORBIS_COMMENT 都要剔除：新块会分别重建。旧的 type=4 若留在链里，
  // 产物会带两个 VORBIS_COMMENT（FLAC 规范只允许一个）——多数解码器只读第一个不出错，
  // 严格解析器（部分foobar2000 版本）会直接判为损坏，所以这里连同封面块一起剔掉
  const oldVorbis = blocks.find((b) => b.type === 4)
  const keep = blocks.filter((b) => b.type !== 6 && b.type !== 4)
  const stream = keep[0]
  // STREAMINFO 必须居首：不能无条件把 keep[0] 当成它——畸形输入会被"修好"成更坏的产物，
  // 而运行时不做产物校验（见 service/download 只验魔数），错了没人拦得住
  if (!stream || stream.type !== 0) throw new Error('FLAC 首块不是 STREAMINFO，文件结构异常')
  const rest = keep.slice(1)
  const inserted = []
  if (cover && cover.length) {
    inserted.push({ type: 6, data: flacPictureBody(mime || sniffImageMime(cover), cover) })
  }
  // 标签合并：已有 VORBIS_COMMENT 则解析后覆盖 TITLE/ARTIST/ALBUM，否则新建。
  // undefined/null 写空串而非字面量 "undefined"——与 id3TextFrame 同一不变量，
  // 否则 song.name 缺失的部分接口响应会在 FLAC 标签里留下 TITLE=undefined（MP3 侧已规避）
  const merged = oldVorbis ? parseVorbisBody(oldVorbis.data) : {}
  merged.TITLE = title == null ? '' : title
  merged.ARTIST = artist == null ? '' : artist
  if (album) merged.ALBUM = album
  inserted.push({ type: 4, data: flacVorbisBody(merged) })
  const chain = [stream, ...inserted, ...rest]
  const out = [Buffer.from('fLaC', 'ascii')]
  chain.forEach((b, i) => {
    out.push(Buffer.from([(i === chain.length - 1 ? 0x80 : 0) | b.type]), u24be(b.data.length), b.data)
  })
  // 关键：块链之后是音频帧，必须原样保留（否则元数据完好但整首歌没有声音）
  out.push(buf.subarray(pos))
  return Buffer.concat(out)
}

function embedFlac(audioPath, meta) {
  replaceAtomic(audioPath, embedFlacBuf(fs.readFileSync(audioPath), meta))
}

/** 图片魔数判型（纯函数）：PNG/JPEG 返回对应 mime，其余 null——封面判型的唯一出处 */
function sniffImageMime(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 2) return null
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png'
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg'
  return null
}

/**
 * 按扩展名分发内嵌；封面二选一：cover(内存 Buffer，下载路径用) 或 coverPath(文件路径，测试/兼容用)
 * 都不给则仅写文本标签。返回是否内嵌了封面。
 * 空封面（length 0）当没有处理：空 Buffer 是 truthy，直接内嵌会产出空 APIC/PICTURE 块的坏文件
 */
function embedCover(audioPath, { title, artist, album, coverPath, cover, mime }) {
  let data = cover || (coverPath ? fs.readFileSync(coverPath) : null)
  if (data && (!data.length || !sniffImageMime(data))) data = null // 空缓冲或非图片内容一律不内嵌
  const actualMime = data ? (mime || sniffImageMime(data)) : null
  const ext = audioPath.toLowerCase().endsWith('.flac') ? 'flac' : 'mp3'
  if (ext === 'flac') embedFlac(audioPath, { title, artist, album, cover: data, mime: actualMime })
  else embedMp3(audioPath, { title, artist, album, cover: data, mime: actualMime })
  return Boolean(data)
}

// ---------- 合规性反向校验 ----------
/** 校验 ID3v2.3：帧链合法、帧长守恒、标签结束后紧跟 MPEG 帧同步头 */
function verifyMp3(audioPath) {
  const buf = fs.readFileSync(audioPath)
  if (buf.subarray(0, 3).toString('ascii') !== 'ID3') return { ok: false, error: '缺少 ID3 头' }
  if (buf[3] !== 3) return { ok: false, error: '不是 ID3v2.3' }
  const size = readSyncSafe(buf, 6)
  let pos = 10
  const end = 10 + size
  let sawApic = false
  while (pos < end) {
    // 标签 size 是"自称"的：文件被截断、或某个 tagger 算错了同步安全长度时 end 会越过实际数据。
    // 帧头要读满 10 字节才能取长度，越界即判损坏——不能让它进 readUInt32BE 抛裸 RangeError，
    // 那会破坏"返回判定对象"的约定（同 verifyFlac 的块头守卫口径）
    if (pos + 10 > end || pos + 10 > buf.length) return { ok: false, error: `帧头越界 @${pos}` }
    const id = buf.subarray(pos, pos + 4).toString('ascii')
    // 零字节填充（padding，外来合法 ID3 常见）出现在帧链尾部即视为标签结束，不再当非法帧
    if (/^\0+$/.test(id)) break
    if (!/^[A-Z0-9]{4}$/.test(id)) return { ok: false, error: `非法帧 ID: ${JSON.stringify(id)} @${pos}` }
    const fLen = buf.readUInt32BE(pos + 4)
    if (fLen <= 0 || pos + 10 + fLen > end) return { ok: false, error: `帧 ${id} 长度越界` }
    if (id === 'APIC') {
      sawApic = true
      const body = buf.subarray(pos + 10, pos + 10 + fLen)
      const mimeEnd = body.indexOf(0, 1)
      const mime = body.subarray(1, mimeEnd).toString('ascii')
      if (!/^image\/(png|jpeg|jpg)$/.test(mime)) return { ok: false, error: `APIC mime 异常: ${mime}` }
      const dataLen = body.length - (mimeEnd + 3)
      const magic = body.subarray(body.length - dataLen)
      const isPng = magic[0] === 0x89 && magic[1] === 0x50
      const isJpg = magic[0] === 0xff && magic[1] === 0xd8
      if (!isPng && !isJpg) return { ok: false, error: 'APIC 图片数据魔数不符' }
    }
    pos += 10 + fLen
  }
  if (pos > end) return { ok: false, error: '帧总长与标签大小不符' }
  // padding 分支提前退出时跳过零字节再找帧同步；正常产物 pos === end
  while (pos < end && buf[pos] === 0) pos++
  if (!(buf[pos] === 0xff && (buf[pos + 1] & 0xe0) === 0xe0)) return { ok: false, error: '标签后未紧跟 MPEG 帧同步' }
  return { ok: true, apic: sawApic, tagSize: size }
}

/** 校验 FLAC：块链完整、恰有一个 last 标志且在末块、STREAMINFO 居首、PICTURE 块字段自洽 */
function verifyFlac(audioPath) {
  const buf = fs.readFileSync(audioPath)
  if (buf.subarray(0, 4).toString('ascii') !== 'fLaC') return { ok: false, error: '缺少 fLaC 魔数' }
  let pos = 4
  let sawLast = false
  let first = true
  let picture = null
  let vorbisCount = 0
  while (pos < buf.length) {
    // 块头 4 字节，读长度就要读满：文件在块头中间被截断时（剩 1~2 字节）readUIntBE 会抛
    // RangeError，与 embedFlacBuf:187 的同款守卫一致——校验器必须返回判定而不是抛异常
    if (pos + 4 > buf.length) return { ok: false, error: '块头越出文件末尾' }
    const head = buf[pos]
    const isLast = Boolean(head & 0x80)
    const type = head & 0x7f
    const len = buf.readUIntBE(pos + 1, 3)
    if (pos + 4 + len > buf.length) return { ok: false, error: `块类型${type}长度越界` }
    if (sawLast) return { ok: false, error: 'last 标志后仍有块' }
    if (first && type !== 0) return { ok: false, error: '首块不是 STREAMINFO' }
    if (isLast) sawLast = true
    if (type === 6) picture = buf.subarray(pos + 4, pos + 4 + len)
    if (type === 4) vorbisCount++
    first = false
    pos += 4 + len
    if (isLast) break
  }
  if (!sawLast) return { ok: false, error: '缺少 last 标志' }
  // FLAC 规范：VORBIS_COMMENT 至多一个。历史上 embedFlac 没剔旧块，产物会带两个，
  // verify 也不查 —— 等于测试与运行时双双漏掉，这里补上让同类回归能被发现
  if (vorbisCount > 1) return { ok: false, error: `存在 ${vorbisCount} 个 VORBIS_COMMENT 块（规范只允许 1 个）` }
  // 块链结束后必须还有音频帧数据，否则是"有元数据没声音"的废文件
  if (pos + 64 > buf.length) return { ok: false, error: '块链后没有音频数据' }
  if (!(buf[pos] === 0xff && (buf[pos + 1] & 0xfc) === 0xf8)) return { ok: false, error: '块链后不是 FLAC 音频帧同步' }
  if (!picture) return { ok: true, mime: null, dataLen: 0 }
  // 解析 PICTURE 字段链（畸形字段链按结构异常返回，不让 RangeError 冒出破坏"返回判定对象"的约定）
  try {
    let p = 4 // 跳过 picture type
    const mimeLen = picture.readUInt32BE(p); p += 4
    const mime = picture.subarray(p, p + mimeLen).toString('ascii'); p += mimeLen
    const descLen = picture.readUInt32BE(p); p += 4 + descLen
    p += 16 // w/h/depth/colors
    const dataLen = picture.readUInt32BE(p); p += 4
    const data = picture.subarray(p)
    if (!/^image\/(png|jpeg|jpg)$/.test(mime)) return { ok: false, error: `PICTURE mime 异常: ${mime}` }
    if (dataLen !== data.length) return { ok: false, error: 'PICTURE 数据长度不符' }
    if (!(data[0] === 0x89 && data[1] === 0x50) && !(data[0] === 0xff && data[1] === 0xd8)) return { ok: false, error: 'PICTURE 图片魔数不符' }
    return { ok: true, mime, dataLen }
  } catch (e) {
    return { ok: false, error: 'PICTURE 字段链结构异常: ' + e.message }
  }
}

/** 按扩展名分发校验 */
function verifyTags(audioPath) {
  return audioPath.toLowerCase().endsWith('.flac') ? verifyFlac(audioPath) : verifyMp3(audioPath)
}

module.exports = { embedCover, embedMp3Buf, embedFlacBuf, verifyTags, verifyMp3, verifyFlac, imageDims, verifyAudioHead, sniffImageMime }
