/**
 * 串行任务队列（策略层原语，可单测）：FIFO，同一时刻只执行一个任务
 *
 * 全局下载队列用它实现，两个目的：
 *  1. 防风控——多任务并发用同一个 VIP cookie 高频请求易触发网易限流
 *  2. 防踩踏——不同任务下载同一首歌会共用同一个 .part 临时路径，串行后不再互写
 *
 * 任务自身负责错误上报（队列只保证"一个挂了继续下一个"），push 不返回 Promise。
 *
 * 取消语义（新增，不破坏原有 FIFO/串行）：
 *  - push(fn) 返回句柄 { id, signal, cancelled, cancel() }；fn 以 (signal) 被调用，
 *    协作式任务应在每首/每步边界检查 signal.throwIfAborted()（或 signal.aborted）
 *  - queued 取消：handle.cancel() 把条目从等待队列摘除并 abort，后续 pump 不再执行它
 *  - running 取消：handle.cancel() 只 abort + 置 cancelled，当前首不强杀，
 *    任务在下一个边界感知到 abort 后自行收尾（server 层把 job 置为 cancelled）
 */
function createSerialQueue() {
  const waiting = []
  let active = false
  let current = null
  let seq = 0

  async function pump() {
    if (active) return
    active = true
    try {
      while (waiting.length) {
        const entry = waiting.shift()
        // 取消的排队任务直接跳过，不执行（queued 取消的核心）
        if (entry.cancelled || (entry.signal && entry.signal.aborted)) continue
        current = entry
        try {
          await entry.fn(entry.signal)
        } catch { /* 任务失败不阻塞队列 */ }
        finally { if (current === entry) current = null }
      }
    } finally {
      active = false
    }
  }

  function cancelEntry(entry) {
    entry.cancelled = true
    try { entry.controller.abort() } catch { /* abort 不应抛 */ }
    const i = waiting.indexOf(entry)
    const wasQueued = i >= 0
    if (wasQueued) waiting.splice(i, 1)
    return wasQueued ? 'queued' : 'running'
  }

  return {
    push(jobFn) {
      const controller = new AbortController()
      const entry = {
        id: ++seq,
        fn: jobFn,
        cancelled: false,
        controller,
        signal: controller.signal,
        cancel() { return cancelEntry(entry) },
      }
      waiting.push(entry)
      // pump 本身不会拒绝（active 有 finally 复位、任务体自带 catch），但这层防御让"将来有人
      // 在 pump 里加了会抛的语句"不会变成逃出 push 的未处理拒绝（服务端只记日志、不崩）
      if (!active) void pump().catch(() => {})
      return entry
    },
    get pending() {
      return waiting.length
    },
    get active() {
      return active
    },
  }
}

module.exports = { createSerialQueue }
