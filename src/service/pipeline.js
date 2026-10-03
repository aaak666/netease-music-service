/**
 * 批量下载统一骨架（本地 fs 与手机 adb 两条管线的唯一执行路径）。
 *
 * 此前 download.downloadMany 与 phone.downloadMany 是同一骨架的两份手抄：重复引用预筛、
 * 命名分配、封面去重、existed 判定、补词、逐首记账、AbortError/部分结果契约——每处都要
 * "两管线口径对齐"地修两遍。现在决策逻辑只在本文件写一次，平台差异封进 backend（落盘后端）：
 *
 *   prepare()                 任务前预检（手机：设备复查 + mkdirP 自愈，deviceGone 上抛；本地：no-op）
 *   scanExisting()            现状清单 { audio: Map<base,Set<ext>>, lrc: Set<base> }（手机容错返回空清单）
 *   audioPath(base, ext)      结果文件路径（existed 分支与落盘成功共用）
 *   existedSize(base, ext)    existed 分支的记账大小（本地 statSync 兜底 0；手机 null——没有可靠尺寸）
 *   storeAudio(resolved, {base, song, cover, mime, signal, onProgress})
 *                             取流 → 完整性校验 → 打标签 → 落盘，返回 { filepath, size, embedError }
 *                             （本地：流式 .part + rename + embedCover；手机：内存取流 + 内存打标签 + adb 直写）
 *   writeLyric(songId, base, signal) → lrcFile|null（手机断连抛 deviceGone）
 *   mergeIndex(pairs)         逐首成功记账（手机内部批次缓冲每 10 首一刷；本地逐首直写）
 *   flushIndex()              收尾兜底刷盘（本地 no-op）
 *   noteStored/noteLyric      落盘后更新内存现状（手机必需；本地快照不随写更新，no-op）
 *   isBatchAbort(err)         是否中止整批（手机：deviceGone/noAdb；本地恒 false）
 *   logTag                    日志 tag（'download' / 'phone'）
 *
 * 行为契约（与旧两版逐字对齐，均有单测锁定）：
 *  - 结果顺序 = 输入顺序；每首（含重复引用占位）必回调 onFile 恰好一次
 *  - AbortError → 上抛并挂 partialResults；isBatchAbort → 中止整批并挂 partialResults；
 *    其余失败记单首继续
 *  - 观察回调（onFile/onProgress）抛错不中断批次
 */
const core = require('../core')
const naming = require('./naming')
const logger = require('./logger')
const { throwIfCancelled } = require('./util')

/** 中止时把已完成各首挂到错误对象上（job.finish 靠它汇总"取消/失败也落报告"） */
function attachPartial(e, results, fillResults) {
  try {
    if (Array.isArray(results) && results.length) e.partialResults = results.slice()
    if (Array.isArray(fillResults) && fillResults.length) e.partialFillResults = fillResults.slice()
  } catch { /* 冻结/只读错误对象不应盖掉真正的中止原因 */ }
}

async function runBatch(songs, opts = {}, backend) {
  const { onFile, onProgress, bases, lyricsFor, signal, ...go } = opts
  const results = []
  // 运行时读取而非顶层解构：单测的桩机制（替换 ./resolve 的 exports / withStubbedPhone 重载）
  // 对模块加载时的解构绑定无效（HANDOFF 决策 61 的同类陷阱），运行时属性访问才对桩可见
  const { resolveWithFallback } = require('./resolve')
  backend.prepare()
  const present = backend.scanExisting()
  // 重复对象引用预筛：命名分配用 Map<对象, 文件名>，同一引用出现两次无法分配两个文件名——
  // 提前把第二次记为单首失败、其余照常下载（数字/字符串 id 是原始值，可合法重复）
  const seenRefs = new Set()
  const slots = []
  for (const it of songs) {
    if (it && typeof it === 'object') {
      if (seenRefs.has(it)) {
        slots.push({ fail: '批次内出现重复歌曲对象，已跳过重复项', id: it.id })
        seenRefs.add(it) // 记账后不再重复记（同引用第三次起也各占一个失败槽）
        continue
      }
      seenRefs.add(it)
      slots.push({ song: it })
    } else {
      slots.push({ id: it })
    }
  }
  // 纯 ID 项展开（本地 API 允许传数字/字符串 id；手机管线恒为对象，此步无感）：
  // 先取详情归一为对象，命名分配才能按真实歌名走（旧版在单曲 download() 内逐个取）。
  // 失败不中断展开——占位 fail 槽，循环阶段在原位置记失败，保住"结果顺序 = 输入顺序"
  for (const slot of slots) {
    if (slot.song !== undefined || slot.fail !== undefined) continue
    throwIfCancelled(signal)
    try {
      const info = await core.song.getOne(slot.id)
      if (!info) throw new Error(`歌曲不存在 (id=${slot.id})`)
      slot.song = info
    } catch (e) {
      slot.fail = core.error.errMsg(e)
    }
  }
  // 命名分配（唯一出处 naming.assignBaseNames；现状快照即旧 sharedTaken——整批只扫一次）
  let assigned = bases || null
  if (!assigned) {
    try {
      assigned = naming.assignBaseNames(slots.map((s) => s.song).filter(Boolean), new Set([...present.audio.keys(), ...present.lrc]))
    } catch (e) {
      // 预筛已化解重复引用；真抛了也只能整批记失败返回，不能让任务层看到裸异常
      logger.error(backend.logTag, `命名分配失败（本批中止）: ${core.error.errMsg(e)}`)
      throw e
    }
  }
  const getCover = naming.coverCache()
  /** 逐首成功记账（id→base，只增不删；写失败静默——索引缺了只退回按名匹配） */
  const indexSong = (s, base) => {
    if (s && s.id !== undefined && s.id !== null) backend.mergeIndex([[s.id, base]])
  }
  try {
    for (const slot of slots) {
      // 占位失败槽（纯 ID 取详情失败 / 重复对象引用）在原位置记结果，保持顺序与输入一致
      if (slot.fail !== undefined) {
        const fail = { ok: false, id: slot.id, name: '', error: slot.fail }
        results.push(fail)
        if (onFile) try { onFile(fail, slot.id) } catch { /* 观察回调不影响批次 */ }
        continue
      }
      const s = slot.song
      throwIfCancelled(signal)
      try {
        const base = assigned.get(s)
        if (!base) throw new Error('该歌没有命名分配（bases 缺失）')
        // 解链（重试分级：noUrl/4xx/校验失败等终态不重试；网络抖动重试 1 次）
        const resolved = await core.retry.withRetry(
          () => resolveWithFallback(s.id, { br: go.br, level: go.level, autoDowngrade: go.autoDowngrade }),
          {
            retries: 1, backoffMs: 800, timeoutMs: naming.TIMEOUTS.RESOLVE,
            shouldRetry: (e) => core.error.isTransient(e),
            // 重试决策可观测：事后能回答"这首歌为什么发了两次解析请求"
            onRetry: (e, i) => logger.log(backend.logTag, `第 ${i + 1} 次尝试失败（瞬时错误），重试: ${s.name || s.id} — ${core.error.errMsg(e)}`),
          },
        )
        const ext = resolved.ext
        if (ext !== 'mp3' && ext !== 'flac') throw new Error(`未知音频档位: ${ext}（level=${resolved.level}）`)
        // 封面按 picUrl 批次级去重（LRU 40，失败也缓存）：同专辑的歌只拉一次；
        // 预取失败不重试也不落封面（后端拿到的 cover 为 null，只写文本标签）
        let coverBuf = null
        let coverMime = null
        if (go.cover !== false && s.picUrl) {
          try {
            const c = await getCover(s.picUrl)
            if (c) { coverBuf = c.buf; coverMime = c.mime }
          } catch { /* 封面失败不影响音频 */ }
        }
        // existed 判定（统一口径）：同基础名已有音频，且（非补下模式 或 目标扩展名已在）→
        // 不重下不覆盖（只增不删）。补下模式只认目标扩展名为 existed——解析降级回已有音质时
        // 也命中此分支（skipIfExists 语义）。歌词若确实缺仍要补上，否则缺口永久化。
        // 现状清单以任务开始时的快照 + noteStored/noteLyric 的本批更新为准（绝不覆盖已有文件）。
        const existingExts = present.audio.get(base)
        if (existingExts && existingExts.size && (!go.skipIfExists || existingExts.has(ext))) {
          // 记账取真实已有文件：请求无损但已有 mp3 时，报"ext:flac 的 mp3 文件"会误导下游；
          // 同一 base 同时有 mp3 与 flac 时优先报本次目标扩展名
          const realExt = existingExts.has(ext) ? ext : [...existingExts][0]
          const r = {
            ok: true, filepath: backend.audioPath(base, realExt), song: s,
            level: resolved.level, br: resolved.br, ext: realExt,
            size: backend.existedSize(base, realExt), existed: true,
          }
          if ((lyricsFor ? lyricsFor.has(s) : go.lyrics) && !present.lrc.has(base)) {
            try {
              const lrcFile = await backend.writeLyric(s.id, base, signal)
              if (lrcFile) { r.lrcFile = lrcFile; backend.noteLyric(base) }
            } catch (e) {
              // 设备断了必须上抛中止整批（吞掉的话这首会被记"完成"，且后续每首都白下载）
              if (backend.isBatchAbort(e)) throw e
              /* 其余歌词失败不影响记账 */
            }
          }
          results.push(r)
          indexSong(s, base)
          if (onFile) try { onFile(r, s) } catch { /* 观察回调不影响批次 */ }
          continue
        }
        // 取流 → 完整性校验 → 打标签 → 落盘：平台差异全部封在 storeAudio 里，
        // 骨架只消费统一形状 { filepath, size, embedError }
        const stored = await backend.storeAudio(resolved, {
          base, song: s, cover: coverBuf, mime: coverMime, signal,
          onProgress: onProgress ? (p) => { try { onProgress(p, s) } catch { /* 观察回调不影响下载 */ } } : null,
        })
        backend.noteStored(base, ext)
        // 补词（缺词才写；已有歌词不重写——与 existed 分支同一判定）
        let lrcFile = null
        if ((lyricsFor ? lyricsFor.has(s) : go.lyrics) && !present.lrc.has(base)) {
          try {
            lrcFile = await backend.writeLyric(s.id, base, signal)
            if (lrcFile) backend.noteLyric(base)
          } catch (e) {
            if (backend.isBatchAbort(e)) throw e
            /* 其余歌词失败不影响音频 */
          }
        }
        const ok = {
          ok: true, filepath: stored.filepath, song: s,
          level: resolved.level, br: resolved.br, ext, size: stored.size,
          embedded: Boolean(coverBuf),
        }
        if (lrcFile) ok.lrcFile = lrcFile
        if (stored.embedError) ok.embedError = stored.embedError
        results.push(ok)
        indexSong(s, base)
        if (onFile) try { onFile(ok, s) } catch { /* 观察回调不影响批次 */ }
      } catch (e) {
        // 取消中断（AbortError）不是这首歌的失败：如实上抛交任务层收口为 cancelled——
        // 否则日志会先多一条"失败：<英文 abort 文案>"再跟"已取消"，误导事后排查
        if (e && e.name === 'AbortError') {
          attachPartial(e, results, [])
          throw e
        }
        const fail = { ok: false, id: s && s.id, name: (s && s.name) || '', error: core.error.errMsg(e) }
        results.push(fail)
        if (onFile) try { onFile(fail, s) } catch { /* 观察回调不影响批次 */ }
        // 设备断连/adb 缺失中止整批：当前首如实记失败，其余不再逐首空转（每首都省下一次完整取流）。
        // 已完成各首的索引随批次缓冲落盘（finally 兜底 flush），重跑任务时增量对账自动续上
        if (backend.isBatchAbort(e)) {
          const why = e.noAdb ? 'ADB 不可用' : '设备断开'
          logger.error(backend.logTag, `${why}，批次中止（已完成 ${results.length}/${slots.length} 首）: ${e.message}`)
          attachPartial(e, results, [])
          throw e
        }
      }
    }
  } finally {
    backend.flushIndex()
  }
  return results
}

module.exports = { runBatch, attachPartial }
