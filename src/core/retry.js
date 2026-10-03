/**
 * 通用异步等待原语：与任何业务无关的单次超时与重试（指数退避）
 * 策略（等多久、重试几次、间隔多少）由调用方决定，这里只提供控制流
 *
 *   await withTimeout(fetchSomething(), 15000)
 *   await withRetry(() => fetchSomething(), { retries: 3, backoffMs: 500 })
 */
async function withRetry(fn, { retries = 3, backoffMs = 500, timeoutMs, shouldRetry, onRetry } = {}) {
  // 单次尝试超时：到点判负（只放弃等待、不中断底层）——复用 withTimeout，全文件只留这一份 race 实现
  const run = () => (timeoutMs ? withTimeout(fn(), timeoutMs) : fn())
  let lastErr
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await run()
    } catch (err) {
      lastErr = err
      // 终态错误直接抛，不浪费重试（如 noUrl / 400 / 404 / 校验失败）；缺省全重试保持兼容。
      // 判定器自身抛错也不得顶掉真实错误：isTransient 内部会序列化 body，循环引用会让它抛，
      // 而调用方看到的应该是"这条 HTTP/网络失败"，不是"Converting circular structure to JSON"。
      // 与 onRetry 同口径的防护：判定器坏掉时兜底按"值得重试"处理
      if (typeof shouldRetry === 'function') {
        let again = true
        try { again = Boolean(shouldRetry(err, attempt)) } catch { again = true }
        if (!again) break
      }
      if (attempt < retries && backoffMs > 0) {
        // onRetry 观察回调：core 不反向依赖 logger，由调用方注入"这次为什么重试"的落日志逻辑
        if (typeof onRetry === 'function') { try { onRetry(err, attempt) } catch { /* 观察回调不影响重试 */ } }
        await new Promise((r) => setTimeout(r, backoffMs * 2 ** attempt))
      }
    }
  }
  throw lastErr
}

/**
 * 单次等待超时：到点判负，只放弃等待、不中断底层请求（底层可能仍在跑）
 * Promise.race 已订阅被竞速的 promise——超时判负后它晚到的成败由 race 内部消化，不会成为未处理 rejection
 *
 *   await withTimeout(someNcmCall(), 15000)
 */
async function withTimeout(promise, ms) {
  const p = Promise.resolve(promise)
  let timer
  try {
    return await Promise.race([
      p,
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`请求超时(${ms}ms)`)), ms) }),
    ])
  } finally {
    clearTimeout(timer) // 判负后清掉定时器，别让它白占事件循环
  }
}

module.exports = { withRetry, withTimeout }
