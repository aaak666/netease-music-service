/**
 * 下载服务（本地 fs 管线）：取详情 → 解直链 → 流式落盘 → 校验 → （可选）歌词/封面内嵌
 *
 * 设计约定（按产品取舍）：
 *  - 本模块不做"已下载跳过"判断，给什么下什么；歌单增量的跳过/补词策略在 incremental
 *  - 文件名 = 纯歌名（用户拍板：资源管理器自己会排序，不加歌手前缀）
 *  - 封面只内嵌进音频，不另存文件（下载目录只留 音频 + 歌词）
 *
 * 结构说明：批量下载的决策逻辑（existed 判定/封面去重/记账/中止契约）统一在
 * service/pipeline.runBatch——本地与手机（service/phone）共用同一骨架，本文件只提供
 * fs 落盘后端（fsSink）与单曲下载入口。命名/歌词/封面规则在 service/naming（唯一出处）。
 */
const fs = require('fs')
const path = require('path')
const core = require('../core')
const storage = require('./storage')
const logger = require('./logger')
const { mergeSignals, assertIntegrity } = require('./util')
const naming = require('./naming')
const pipeline = require('./pipeline')
const { resolveWithFallback } = require('./resolve')

const DOWNLOAD_TIMEOUT = naming.TIMEOUTS.DOWNLOAD

// 供老引用与测试使用的转发（命名规则唯一出处 naming）：
const sanitize = naming.sanitize
const baseNameOf = naming.baseNameOf
const nameKey = naming.nameKey
const assignBaseNames = naming.assignBaseNames
const saveLyric = naming.saveLyric
const fetchCover = naming.fetchCover
const TIMEOUTS = naming.TIMEOUTS

/** 本地 fs 落盘后端：流式 .part 落盘 → 魔数校验 → rename → 文件级内嵌封面（不占大文件内存） */
function fsSink(dir) {
  return {
    kind: 'local',
    logTag: 'download',
    prepare() { /* 本地无预检；自定义目录的半成品清扫跟随建任务走（service/job） */ },
    scanExisting() { return storage.scanDir(dir) }, // 目录不存在/不可读返回空索引
    audioPath(base, ext) { return path.join(dir, `${base}.${ext}`) },
    existedSize(base, ext) {
      // existsSync→statSync 之间文件被外部删除的 TOCTOU 窗口：降级 size:0 记账，不该标"失败"
      try { return fs.statSync(path.join(dir, `${base}.${ext}`)).size } catch { return 0 }
    },
    async storeAudio(resolved, { base, song, cover, mime, signal, onProgress }) {
      const filepath = path.join(dir, `${base}.${resolved.ext}`)
      // 文件名 = 分配出的基础名 + 扩展名（清洗在命名分配时已完成）；每首 mkdir 自愈
      //（目录可能在排队期间被外部删除，与手机管线 mkdirP 同口径）
      fs.mkdirSync(dir, { recursive: true })
      const tmpPath = filepath + '.part'
      try {
        await core.retry.withRetry(
          async () => {
            // 取消信号与超时合并（与手机管线同口径，原生 AbortSignal.any）：
            // AbortError 不进重试（isTransient 排除），取消不会引发多余的一次重试请求
            const timeoutSignal = AbortSignal.timeout(DOWNLOAD_TIMEOUT)
            const streamSignal = mergeSignals(signal, timeoutSignal)
            const r = await core.download.streamTo(resolved.url, tmpPath, { onProgress, signal: streamSignal })
            // 完整性双口径断言（截断/大小 + encoded 守卫）在 util.assertIntegrity——与手机管线共用一份
            assertIntegrity({ received: r && r.size, total: r && r.total, expected: resolved.size, encoded: Boolean(r && r.encoded), url: resolved.url })
            return r
          },
          {
            retries: 1, backoffMs: 800,
            // 404/400 等终态不重试；断流/5xx/超时才重试；校验失败在 verify 阶段抛，本就不进重试
            shouldRetry: (err) => core.error.isTransient(err),
            onRetry: (e, i) => logger.log('download', `第 ${i + 1} 次取流失败（瞬时错误），重试: ${song.name || song.id} — ${core.error.errMsg(e)}`),
          },
        )
      } catch (e) {
        // 两次尝试都失败：清掉 .part 半成品（最大几十 MB），别等下次启动清扫
        try { fs.unlinkSync(tmpPath) } catch { /* 不存在则无事 */ }
        throw e
      }
      // 魔数校验也在 .part 清理圈内：校验失败（HTML 错误页/坏头）同样不能把几十 MB 半成品留在盘上
      try {
        core.download.verifyFile(tmpPath, resolved.ext)
      } catch (e) {
        try { fs.unlinkSync(tmpPath) } catch { /* 不存在则无事 */ }
        throw e
      }
      try {
        fs.renameSync(tmpPath, filepath)
      } catch (e) {
        // 目标被播放器占用等：文件其实已下好，卡在"改个名"。给可读文案；
        // .part 尽力清掉，清不掉（仍被占用）留给下次启动清扫
        try { fs.unlinkSync(tmpPath) } catch { /* 仍被占用则留给 sweepDownloads */ }
        throw new Error(`下载完成但落盘失败（文件被占用？）: ${e.message} → ${filepath}`)
      }
      // 标签与封面解耦：无论封面成败，都保证 TITLE/ARTIST/ALBUM 写入（网易原文件常常没有标题）。
      // 封面取回内存直接内嵌，下载目录不落任何封面文件（产品拍板：只留音频+歌词）；
      // 封面二进制由批次层（pipeline）按 picUrl 去重后传入
      let embedError = null
      try {
        core.tag.embedCover(filepath, {
          title: song.name,
          artist: song.artist,
          album: song.album,
          cover,
          mime,
        })
      } catch (e) {
        embedError = e.message
      }
      // size 在标签写盘完成后统计，反映最终文件。不能裸调：文件在 rename 之后、这里之前
      // 被删或被杀软独占时 statSync 会抛，而前面所有步骤都已成功——一抛就把完整可播的
      // 文件记成"失败"且索引也不写
      let size = 0
      try { size = fs.statSync(filepath).size } catch { size = 0 }
      return { filepath, size, embedError }
    },
    async writeLyric(songId, base) {
      return naming.saveLyric(songId, path.join(dir, `${base}.lrc`))
    },
    // 索引逐首直写（本地写盘便宜；手机侧在 adbSink 内部做批次缓冲）。
    // 每首成功即合并写：中途取消/崩溃也已记账；写失败静默（storage.mergeIndexFile 内处理）
    mergeIndex(pairs) { storage.mergeIndexFile(dir, pairs) },
    flushIndex() { /* 逐首直写，无缓冲可刷 */ },
    // 增量回填用（incremental.run 开头全量回填）：立即写，不走逐首通道
    dirExists(d) { return fs.existsSync(d) },
    writeIndexFile(d, pairs) { storage.mergeIndexFile(d, pairs) },
    noteStored() { /* 现状快照不随写更新：本批内 base 唯一，不会重复命中 */ },
    noteLyric() { /* 同上 */ },
    isBatchAbort() { return false }, // 本地管线无整批中止语义
  }
}

/**
 * 下载单曲
 * @param {string|number|object} idOrSong 歌曲 ID 或 song 结构
 * @param {object} opts
 *   - dir: 保存目录（默认 ./downloads）
 *   - br / level: 音质
 *   - lyrics: 同时保存 .lrc 歌词
 *   - cover: 下载封面图并内嵌进音频（内嵌失败不影响音频）
 *   - onProgress: (p) => void，p = { received, total, percent }
 *   - autoDowngrade: 音质取不到时降级（默认 true）
 *   - signal: 任务取消信号（批量路径由骨架注入）：取消即时断流，不再等当前文件下完
 * @returns { filepath, song, level, br, size, ext, lrcFile?, embedded?, embedError?, existed? }
 */
async function download(idOrSong, { dir = path.join(__dirname, '..', '..', 'downloads'), br, level, onProgress, autoDowngrade = true, lyrics = false, cover = true, signal } = {}) {
  const songInfo = typeof idOrSong === 'object' && idOrSong !== null ? idOrSong : await core.song.getOne(idOrSong)
  if (!songInfo) throw new Error(`歌曲不存在 (id=${typeof idOrSong === 'object' ? idOrSong.id : idOrSong})`)

  const resolved = await core.retry.withRetry(
    () => resolveWithFallback(songInfo.id, { br, level, autoDowngrade }),
    {
      retries: 1, backoffMs: 800, timeoutMs: naming.TIMEOUTS.RESOLVE,
      // noUrl = 阶梯全无资源终态，重跑一遍阶梯只是浪费；网络抖动才值得重试
      shouldRetry: (err) => core.error.isTransient(err),
      // 重试决策可观测：事后能回答"这首歌为什么发了两次解析请求"
      onRetry: (e, i) => logger.log('download', `第 ${i + 1} 次尝试失败（瞬时错误），重试: ${songInfo.name || songInfo.id} — ${core.error.errMsg(e)}`),
    },
  )
  fs.mkdirSync(dir, { recursive: true })

  // 文件名 = 分配出的基础名 + 扩展名（分配规则见 naming.assignBaseNames；先清洗再拼扩展名：
  // 否则超长歌名会把扩展名一起截掉，产物无后缀、下次启动被清扫误删）
  const name = naming.assignBaseNames([songInfo], naming.takenBases(dir)).get(songInfo)
  const filename = `${name}.${resolved.ext}`
  const filepath = path.join(dir, filename)

  // 目标文件已在（同基础名同扩展名）→ 不重下不覆盖，直接记账（只增不删）。歌词若确实缺仍要补上——
  // 否则"无无损源 + 缺词"的歌每次重跑都会在这里早退，歌词缺口永久化
  if (fs.existsSync(filepath)) {
    let size = 0
    try { size = fs.statSync(filepath).size } catch { /* 已消失按 0 记 */ }
    const result = { filepath, song: songInfo, level: resolved.level, br: resolved.br, ext: resolved.ext, existed: true, size }
    const lrcPath = filepath.replace(/\.[^.]+$/, '.lrc')
    if (lyrics && !fs.existsSync(lrcPath)) {
      try {
        const lrcFile = await naming.saveLyric(songInfo.id, lrcPath)
        if (lrcFile) result.lrcFile = lrcFile
      } catch { /* 歌词失败不影响记账 */ }
    }
    return result
  }

  const tmpPath = filepath + '.part'
  try {
    await core.retry.withRetry(
      async () => {
        const timeoutSignal = AbortSignal.timeout(DOWNLOAD_TIMEOUT)
        const streamSignal = mergeSignals(signal, timeoutSignal)
        const r = await core.download.streamTo(resolved.url, tmpPath, { onProgress, signal: streamSignal })
        // 完整性断言与批量路径共用 util.assertIntegrity（两管线同守卫，不许分叉）
        assertIntegrity({ received: r && r.size, total: r && r.total, expected: resolved.size, encoded: Boolean(r && r.encoded), url: resolved.url })
        return r
      },
      {
        retries: 1, backoffMs: 800,
        shouldRetry: (err) => core.error.isTransient(err),
        onRetry: (e, i) => logger.log('download', `第 ${i + 1} 次取流失败（瞬时错误），重试: ${songInfo.name || songInfo.id} — ${core.error.errMsg(e)}`),
      },
    )
  } catch (e) {
    // 两次尝试都失败：清掉 .part 半成品（最大几十 MB），别等下次启动清扫
    try { fs.unlinkSync(tmpPath) } catch { /* 不存在则无事 */ }
    throw e
  }
  // 魔数校验也在 .part 清理圈内：校验失败（HTML 错误页/坏头）同样不能把几十 MB 半成品留在盘上
  try {
    core.download.verifyFile(tmpPath, resolved.ext)
  } catch (e) {
    try { fs.unlinkSync(tmpPath) } catch { /* 不存在则无事 */ }
    throw e
  }
  try {
    fs.renameSync(tmpPath, filepath)
  } catch (e) {
    try { fs.unlinkSync(tmpPath) } catch { /* 仍被占用则留给 sweepDownloads */ }
    throw new Error(`下载完成但落盘失败（文件被占用？）: ${e.message} → ${filepath}`)
  }
  const result = { filepath, song: songInfo, level: resolved.level, br: resolved.br, ext: resolved.ext }

  if (lyrics) {
    try {
      // 歌词是可选项：限时 3 秒（LYRIC_TIMEOUT，实测约 160ms），超时/失败直接跳过，不拖累任务
      const lrcFile = await naming.saveLyric(songInfo.id, filepath.replace(/\.[^.]+$/, '.lrc'))
      if (lrcFile) result.lrcFile = lrcFile
    } catch { /* 歌词失败不影响音频 */ }
  }

  // 标签与封面解耦：无论封面成败，都保证 TITLE/ARTIST/ALBUM 写入（网易原文件常常没有标题）
  // 封面取回内存直接内嵌，下载目录不落任何封面文件（产品拍板：只留音频+歌词）
  let coverBuf = null
  let coverMimeActual = null
  if (cover && songInfo.picUrl) {
    try {
      const c = await naming.fetchCover(songInfo.picUrl)
      coverBuf = c.buf
      coverMimeActual = c.mime
    } catch { /* 封面失败不影响音频 */ }
  }

  try {
    result.embedded = core.tag.embedCover(filepath, {
      title: songInfo.name,
      artist: songInfo.artist,
      album: songInfo.album,
      cover: coverBuf,
      mime: coverMimeActual,
    })
  } catch (e) {
    result.embedError = e.message
  }
  // size 在标签/内嵌写盘完成后统计，反映最终文件。
  // 这行不能裸调：文件在 rename 之后、这里之前被删或被杀软独占时 statSync 会抛，
  // 而前面所有步骤都已成功——一抛就被批量路径记成"失败"、索引也不写，
  // 用户为一个完整可播的文件看到红色失败（下次重跑自愈，但当下是错的信息）
  try { result.size = fs.statSync(filepath).size } catch { result.size = 0 }

  return result
}

/**
 * 批量下载（本地管线）：统一骨架 service/pipeline.runBatch + fsSink。
 * 旧版的手写循环（重复引用预筛/纯 ID 展开/命名分配/封面 LRU/逐首容错）全部在骨架里，
 * 与手机管线共用一份；本函数只负责缺省目录与后端装配。
 * @param opts 透传骨架（dir/br/lyrics/cover/skipIfExists/bases/lyricsFor/signal/onFile/onProgress）
 */
async function downloadMany(idsOrSongs, opts = {}) {
  const dir = (opts && opts.dir) || path.join(__dirname, '..', '..', 'downloads')
  return pipeline.runBatch(idsOrSongs, opts, fsSink(dir))
}

module.exports = {
  download, downloadMany, sanitize, baseNameOf, assignBaseNames, saveLyric, fetchCover, nameKey, TIMEOUTS,
  fsSink,
}
