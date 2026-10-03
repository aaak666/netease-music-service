/**
 * 下载底层原语：单 URL 流式落盘 + 文件魔数校验
 * 不做编排（取详情/解直链/批量/跳过判断都在 service 层）
 */
const fs = require('fs')
const { Readable } = require('stream')
const { pipeline } = require('stream/promises')

// Windows 保留设备名（不区分扩展名前后，如 con.mp3 同样非法）：命中加下划线前缀。
// CONIN$/CONOUT$ 与上标 ¹²³ 形式（COM¹/LPT¹）在 Win10+ 的 DOS 设备命名空间里同样是设备，
// 漏掉它们时 path.join 会打到设备上——字节写进控制台输入或直接 EBUSY/ENOENT
const WIN_RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(\..*)?$/i

// 单个文件名分量的字节上限：Android /sdcard（ext4/f2fs）与 NTFS 都是 255。
// 设备端（ext4/f2fs）与 NTFS 的单个文件名分量上限都是 255 **字节**。码点截断到 120 对 ASCII
// （120B）够用，但对 CJK/emoji 是 360~480 字节 —— 设备端必然 "File name too long"，
// 而那条 adb 报错会被当成"手机目的地不可用"，把用户的歌单名问题甩给手机。
// 上限取 240 而非 255：给 `.tagtmp`（7 字节）/ ` [id]`（≤28 字节）后缀留余量，
// 否则"120 个汉字的歌名 + .flac"刚好卡在 255 边界上
const MAX_NAME_BYTES = 240

/**
 * 文件名非法字符清洗（纯函数）：Windows 非法字符 + 控制字符 → 下划线
 * 尾部点/空格必须去掉：Win32 落盘会静默剥离（"abc." → "abc"），导致记账的 base 与
 * 磁盘实际文件名错位——增量对账每次都把这首歌当缺失重新下载再覆盖，永不收敛
 */
function sanitize(name) {
  // null/undefined 必须归一为空串：String(undefined) === 'undefined' 是个真值，
  // 会产出字面量叫 undefined.flac 的文件，且标签里 TITLE 为空（歌名缺失的电台/播客条目会命中）
  let cleaned = String(name == null ? '' : name).replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_').replace(/\s+/g, ' ').trim()
  // 按码点而非 UTF-16 码元截断：直接 slice(0,120) 会把 emoji/生僻字切成孤立代理字符，
  // Windows 拒绝这类文件名（ENOENT），错误还发生在写盘阶段、看不出跟清洗有关
  cleaned = [...cleaned].slice(0, 120).join('').replace(/[.\s]+$/, '')
  // 再按字节收口：码点数够不代表字节数够（120 个汉字 = 360 字节 > 设备端 255）
  // 切在字节边界后可能出现半个多字节字符，用 U+FFFD 收尾并剥掉
  if (Buffer.byteLength(cleaned, 'utf8') > MAX_NAME_BYTES) {
    cleaned = Buffer.from(cleaned, 'utf8').subarray(0, MAX_NAME_BYTES).toString('utf8').replace(/�+$/, '').replace(/[.\s]+$/, '')
  }
  if (WIN_RESERVED.test(cleaned)) cleaned = '_' + cleaned
  return cleaned
}

/** 音频魔数校验（纯函数）：flac → fLaC；mp3 → ID3 或帧头 0xFFEx */
function verifyMagic(buf, ext) {
  if (ext === 'flac') return buf.slice(0, 4).toString('ascii') === 'fLaC'
  if (ext === 'mp3') {
    return buf.slice(0, 3).toString('ascii') === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)
  }
  return true
}

/**
 * 单 URL 流式下载到指定路径（通常传 .part 临时路径）
 * @returns { size, total }；支持 AbortSignal 取消
 */
async function streamTo(url, filepath, { onProgress, signal } = {}) {
  const resp = await fetch(url, { signal })
  if (!resp.ok || !resp.body) {
    // 非 2xx 的 body 是活的未读流：不显式丢弃，undici 的连接不会回池。
    // 签名 URL 过期返回 403 是常见形态，而"下载失败: HTTP 403"被判终态、不走重试，
    // 也就没人替我们清理——大批次里累积起来会把连接池耗尽，后续请求莫名卡住
    try { if (resp.body) await resp.body.cancel() } catch { /* 已自行结束则无事 */ }
    throw new Error(`下载失败: HTTP ${resp.status}`)
  }
  const total = Number(resp.headers.get('content-length')) || 0
  // 服务端透明压缩（content-encoding）时 content-length 是压缩字节数、实收是解压后字节数，
  // 两者必然不等——不做截断断言，否则正常文件会被误判"下载截断"白烧一次重试
  const encoded = resp.headers.get('content-encoding')
  let received = 0
  const source = Readable.fromWeb(resp.body)
  source.on('data', (chunk) => {
    received += chunk.length
    if (onProgress) {
      // 观察回调不设防：抛错会以未捕获同步异常的形式打崩进程，这里原地吞掉
      try { onProgress({ received, total, percent: total ? Math.floor((received / total) * 100) : 0 }) } catch { /* 忽略 */ }
    }
  })
  await pipeline(source, fs.createWriteStream(filepath))
  // 服务端早断流且 fetch 未抛错时，这里就是唯一能拦住截断文件按成功返回的关口。
  // content-encoding 存在时跳过：透明压缩下 content-length 是压缩字节数、实收是解压后字节数，
  // 两者必然不等，不跳过会把每个正常文件都判成"下载截断"并白烧一次重试。
  // encoded 一并回传给调用方——它自己做的那遍二次校验必须用同一个判据，否则这里跳过了、
  // 上层又补回来（手机管线 fetchBufferWithProgress 已是这个形状，两条管线不许分叉）
  if (!encoded && total > 0 && received !== total) {
    throw new Error(`下载截断（断流）: 期望 ${total}B，实际 ${received}B: ${url}`)
  }
  return { size: received, total, encoded: Boolean(encoded) }
}

/** 校验已落盘文件的魔数；不合法则删除文件并抛错；合法返回 true */
function verifyFile(filepath, ext) {
  const fd = fs.openSync(filepath, 'r')
  let ok = false
  try {
    const head = Buffer.alloc(16)
    // 必须看 readSync 的实际读取字节数：不足 16 字节时 head 尾部是零填充，
    // 而 verifyMagic 对 mp3 只需要 buf[0]==0xff && (buf[1]&0xe0)==0xe0 —— 2 字节的
    // "FF Ex" 文件就能通过校验被 rename 成正式歌名，随后被增量永久当成"已存在"（决策 76）
    const n = fs.readSync(fd, head, 0, 16, 0)
    ok = n >= 16 && verifyMagic(head, ext)
  } finally {
    fs.closeSync(fd) // 读失败也要关，否则长任务里会一路漏句柄
  }
  if (!ok) {
    try { fs.unlinkSync(filepath) } catch { /* 被占用则留给下次启动清扫 */ }
    throw new Error(`文件校验失败（非 ${ext} 内容或文件过短）: ${filepath}`)
  }
  return true
}

/**
 * 小文件直接取回内存（封面等：不落盘、不留临时文件）
 * @param timeoutMs 整体超时（默认 10 秒）
 * @param maxBytes 超过则拒绝（防异常大响应撑爆内存，默认 20MB）
 * @returns Buffer
 */
async function fetchBuffer(url, { timeoutMs = 10 * 1000, maxBytes = 20 * 1024 * 1024 } = {}) {
  const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  // 拒收路径必须显式取消 body，否则底层连接悬挂到超时才被回收
  const reject = async (msg) => {
    try { if (resp.body) await resp.body.cancel() } catch { /* 已自行结束则无事 */ }
    throw new Error(msg)
  }
  // 非 2xx 同 streamTo：不取消 body 就会漏连接（403 的 HTML 错误页照样有 body）
  if (!resp.ok || !resp.body) await reject(`下载失败: HTTP ${resp.status}`)
  const declared = Number(resp.headers.get('content-length')) || 0
  if (declared > maxBytes) await reject(`内容过大: ${declared}B`)
  // 流式累计而非 arrayBuffer() 全量进内存再判限：chunked 响应（无 content-length）遇到
  // 异常大响应时，旧写法会把超限内容完整吃进内存才拒绝——这里超限立即取消
  const reader = resp.body.getReader()
  const chunks = []
  let received = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      received += value.length
      if (received > maxBytes) {
        try { await reader.cancel() } catch { /* 已自行结束则无事 */ }
        throw new Error(`内容过大: ${received}B`)
      }
    }
  } catch (e) {
    try { await reader.cancel() } catch { /* 已结束则无事 */ }
    throw e
  }
  return Buffer.concat(chunks)
}

module.exports = { sanitize, verifyMagic, streamTo, verifyFile, fetchBuffer }
