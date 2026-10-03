/**
 * service 层公共小工具：取消检查、有界缓存——原来散在三/两处逐字重复，收敛于此
 * （只放无策略含义的纯机制；有产品口径的东西不放这里）
 */

/** 协作式取消：在每首/每步边界检查，abort 即抛 AbortError 由上层收尾（当前首不强杀） */
function throwIfCancelled(signal) {
  if (!signal) return
  if (typeof signal.throwIfAborted === 'function') signal.throwIfAborted()
  else if (signal.aborted) {
    const e = new Error('任务已取消')
    e.name = 'AbortError'
    throw e
  }
}

/**
 * 批次级 LRU 缓存（下载管线的封面去重用）：命中时 delete 再 set 提到最新，超限删最旧（Map 首键）
 * 缓存的是 Promise——同 key 并发首查只发一次请求，失败同样入缓存（调用方批次结束即丢弃），
 * 避免大批次里同坏封面逐首重试。limit 默认 40（40 张 1500px 封面约 16MB，防极端大批次占内存）
 */
function createLruCache(fetcher, limit = 40) {
  const cache = new Map()
  return (key) => {
    if (cache.has(key)) {
      const hit = cache.get(key)
      cache.delete(key)
      cache.set(key, hit)
      return hit
    }
    const p = fetcher(key)
    cache.set(key, p)
    if (cache.size > limit) cache.delete(cache.keys().next().value)
    return p
  }
}

/**
 * 合并两个 AbortSignal（任务取消 + 分步超时），任一触发即中断。
 * AbortSignal.any 要 Node 20.3/18.17 才有，package.json 声明 >=18，即 18.0~18.16 上原实现会
 * 走 `AbortSignal.any ? ... : timeoutSignal` 的退化分支——**任务取消信号被整个丢掉**，
 * 只剩 10 分钟超时生效：用户点了取消，接口立刻回 ok，传输却继续跑满，
 * 表现为"点了没反应"且日志一行不出（决策 27 承诺的"当前歌曲即时断流"失效）。
 * 这里手写等价物，全版本行为一致。
 */
function mergeSignals(a, b) {
  if (!a) return b
  if (!b) return a
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([a, b])
  const c = new AbortController()
  const onAbort = (e) => {
    try { c.abort(e && e.target ? e.target.reason : undefined) } catch { /* 已中断则无事 */ }
  }
  const added = []
  for (const s of [a, b]) {
    if (s.aborted) { onAbort({ target: s }); return c.signal }
    s.addEventListener('abort', onAbort, { once: true })
    added.push(s)
  }
  // 监听器必须摘掉：mergeSignals 在两条管线里是**每首**调用的，退化分支下 Node 18.0~18.16
  // 会在同一个任务级 signal 上挂 2×N 个监听器永不移除——第 11 首起 MaxListeners 告警，
  // 且只要任务还在 50 条 jobs 表里就一直可达。原生 AbortSignal.any 自行管理，无需此段
  const prune = () => {
    for (const s of added) {
      try { s.removeEventListener('abort', onAbort) } catch { /* 已销毁的 signal */ }
    }
    added.length = 0
  }
  // 只有真正 abort 时才摘：signal 正常走完（超时/正常结束）时上游不会触发事件，
  // 监听器会留到 signal 被 GC——用 AbortSignal.timeout 的组合就属于这种常态路径
  c.signal.addEventListener('abort', prune, { once: true })
  return c.signal
}

/**
 * 下载完整性双口径断言（两条管线共用的唯一出处——本地 streamTo 后与手机取流后都必须过这一关）：
 *  ① 截断：声明了 content-length 却没给够 → 断流，抛错（瞬时错误，值得重试）
 *  ② 大小：与 resolve 宣称的 size 差 >1KB 且比例 >1% 才判异常（resolve.size 是近似值，宁松勿紧）
 * encoded = CDN 透明压缩：content-length 是压缩字节数、实收是解压后字节数，两者必然不等，
 * 两个断言都必须跳过，否则每个正常文件都被误判"下载截断"并白烧一次重试。
 * 判负后抛错由调用方清理各自的半成品（.part / 设备端文件）。
 */
function assertIntegrity({ received, total, expected, encoded, url }) {
  const got = Number(received) || 0
  const declared = Number(total) || 0
  const want = Number(expected) || 0
  if (!encoded && declared > 0 && got !== declared) {
    throw new Error(`下载截断（断流）: 期望 ${declared}B，实际 ${got}B: ${url}`)
  }
  if (!encoded && want > 0) {
    const diff = Math.abs(got - want)
    if (diff > 1024 && diff / want > 0.01) {
      throw new Error(`下载大小异常: 期望约 ${want}B，实际 ${got}B（差 ${diff}B）: ${url}`)
    }
  }
}

/** 定时等待（推荐/手机管线批间退避、断连恢复轮询用）；signal 可选，等待期间取消立即抛出 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { signal?.removeEventListener?.('abort', onAbort); resolve() }, ms)
    const onAbort = () => { clearTimeout(t); try { throwIfCancelled(signal) } catch (e) { reject(e) } }
    if (signal) {
      if (signal.aborted) return onAbort()
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

module.exports = { throwIfCancelled, createLruCache, mergeSignals, sleep, assertIntegrity }
