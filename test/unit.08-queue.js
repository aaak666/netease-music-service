/**
 * 单测分件（由 test/unit.test.js 拆出）：08-queue
 * 桩/收集器见 unit.harness.js；本文件只注册用例，执行由入口调度。
 */
const { t, assert, fs, os, path, core, svc, tmpDir, until, makeGate, stubPhoneIo, fakeAudioFetch, withStubbedPhone, execFileStub, childProcess, TEST_DOWNLOAD_DIR } = require('./unit.harness')

module.exports = async function () {

  await t('queue: 串行执行 + FIFO 顺序 + 最大并发 1', async () => {
    const q = svc.queue.createSerialQueue()
    const order = []
    let concurrent = 0
    let maxConcurrent = 0
    const task = (name, ms) => () => new Promise((resolve) => {
      concurrent++
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      order.push(name)
      setTimeout(() => { concurrent--; resolve() }, ms)
    })
    q.push(task('a', 30))
    q.push(task('b', 5))
    q.push(task('c', 1))
    await until(() => q.pending === 0 && !q.active)
    assert.deepStrictEqual(order, ['a', 'b', 'c'])
    assert.strictEqual(maxConcurrent, 1, `出现并发: ${maxConcurrent}`)
  })

  await t('queue: 任务抛错不阻塞后续', async () => {
    const q = svc.queue.createSerialQueue()
    const seen = []
    q.push(() => { throw new Error('boom') })
    q.push(() => { seen.push('after') })
    await until(() => q.pending === 0 && !q.active)
    assert.deepStrictEqual(seen, ['after'])
  })

  await t('queue: 运行中追加的任务排到队尾', async () => {
    const q = svc.queue.createSerialQueue()
    const order = []
    let firstStarted = false
    // first 由门闩持有：追加 third 的时机由"first 确认在运行"这个条件保证，
    // 不再 sleep 10ms 赌 first(40ms) 还没跑完的时间窗
    const gate = makeGate()
    q.push(() => { firstStarted = true; order.push('first'); return gate.wait })
    q.push(() => { order.push('second') })
    await until(() => firstStarted)
    q.push(() => { order.push('third') })
    assert.deepStrictEqual(order, ['first'], 'first 未放行时后续任务不得并行执行（追加的 third 应在队尾等待）')
    gate.open()
    await until(() => q.pending === 0 && !q.active)
    assert.deepStrictEqual(order, ['first', 'second', 'third'])
  })

  await t('queue: queued 取消跳过执行（push 返回 handle.cancel）', async () => {
    const q = svc.queue.createSerialQueue()
    const order = []
    let blockerStarted = false
    // 门闩替代"blocker 跑 60ms、等 10ms 就 cancel"的定时器竞速：事件循环一卡，
    // 10ms 等待可能整个越过 blocker → 被取消的任务先执行 → 用例偶发翻车
    const gate = makeGate()
    const blocker = q.push(() => { blockerStarted = true; order.push('blocker'); return gate.wait })
    assert.ok(blocker && typeof blocker.cancel === 'function' && blocker.signal, 'push 应返回 {id,cancel,signal}')
    const h2 = q.push(() => { order.push('cancelled-should-not-run') })
    const h3 = q.push(() => { order.push('third') })
    // 等 blocker 确认已在执行（条件成立）才取消，再放行——不赌任何时间窗
    await until(() => blockerStarted)
    h2.cancel()
    assert.strictEqual(h2.cancelled, true, 'cancel 后句柄应标记 cancelled')
    assert.deepStrictEqual(order, ['blocker'], '放行前不得有排队任务被执行')
    gate.open()
    await until(() => q.pending === 0 && !q.active)
    assert.deepStrictEqual(order, ['blocker', 'third'], `被取消的任务不应执行，实际 ${order.join(',')}`)
  })

  await t('queue: running 协作式取消（signal abort 后下一个边界停）', async () => {
    const q = svc.queue.createSerialQueue()
    let secondRan = false
    const h1 = q.push(async (signal) => {
      for (let i = 0; i < 10; i++) {
        if (signal.aborted) { const e = new Error('任务已取消'); e.name = 'AbortError'; throw e }
        await new Promise((r) => setTimeout(r, 10))
        if (i === 1) h1.cancel() // 模拟 running 取消：abort 当前任务的 signal
      }
    })
    q.push(() => { secondRan = true })
    await until(() => q.pending === 0 && !q.active)
    assert.strictEqual(secondRan, true, 'running 取消不应阻塞后续排队任务')
  })

  await t('queue: pump 的意外拒绝不会逃成未处理拒绝', async () => {
    // 结构保证：active 由 finally 复位、任务体自带 catch。这里只锁"push 不抛"
    const q = svc.queue.createSerialQueue()
    const handle = q.push(() => { throw new Error('任务体抛错') })
    assert.ok(handle && typeof handle.id === 'number')
    await until(() => !q.active && q.pending === 0, 2000)
    assert.ok(true, '任务体抛错后队列必须照常排空（不得卡在 active）')
  })
}
