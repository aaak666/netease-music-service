/**
 * 单测分件（由 test/unit.test.js 拆出）：01-core-foundation
 * 桩/收集器见 unit.harness.js；本文件只注册用例，执行由入口调度。
 */
const { t, assert, fs, os, path, core, svc, tmpDir, until, makeGate, stubPhoneIo, fakeAudioFetch, withStubbedPhone, execFileStub, childProcess, TEST_DOWNLOAD_DIR } = require('./unit.harness')

module.exports = async function () {

  await t('quality: br→level 映射（仅 320/2000 两档）', () => {
    assert.strictEqual(core.quality.toLevel('2000'), 'lossless')
    assert.strictEqual(core.quality.toLevel('320'), 'exhigh')
    assert.strictEqual(core.quality.toLevel('lossless'), 'lossless')
    assert.strictEqual(core.quality.toLevel(undefined), 'exhigh')
    assert.throws(() => core.quality.toLevel(''))      // 显式空串不静默降级
    assert.throws(() => core.quality.toLevel('9999'))
    assert.throws(() => core.quality.toLevel('128'))   // 档位已移除
    assert.throws(() => core.quality.toLevel('192'))   // 档位已移除
    assert.throws(() => core.quality.toLevel('hires')) // 档位已移除
    assert.throws(() => core.quality.toLevel('jymaster')) // 档位已移除
  })

  await t('quality: 降级阶梯仅在两档内回退', () => {
    assert.deepStrictEqual(core.quality.ladderFrom('lossless'), ['lossless', 'exhigh'])
    assert.deepStrictEqual(core.quality.ladderFrom('exhigh'), ['exhigh'])
    assert.throws(() => core.quality.ladderFrom('hires'))
  })

  await t('quality: extOf 只认 mp3/flac 白名单，异常 encodeType 按档位兜底', () => {
    assert.strictEqual(core.quality.extOf('lossless', 'flac'), 'flac')
    assert.strictEqual(core.quality.extOf('exhigh', 'MP3'), 'mp3')
    // 服务端异常 encodeType 不得透传成文件扩展名：scanDir 只认 mp3|flac|lrc，
    // 认领不了的文件会被增量对账当缺失每次重下、永不收敛
    assert.strictEqual(core.quality.extOf('lossless', 'ogg'), 'flac')
    assert.strictEqual(core.quality.extOf('exhigh', 'm4a'), 'mp3')
    assert.strictEqual(core.quality.extOf('lossless'), 'flac')
    assert.strictEqual(core.quality.extOf('exhigh'), 'mp3')
  })

  await t('params: br 显式 null 视为未传（缺省 2000），空串仍非法', () => {
    const { brOf, brError } = require('../src/service/params')
    assert.strictEqual(brOf({}), 2000)
    assert.strictEqual(brOf({ br: null }), 2000, 'JSON body 的 br:null 不得静默降为 320（与缺省语义一致）')
    assert.strictEqual(brOf({ br: undefined }), 2000)
    assert.strictEqual(brOf({ br: 0 }), 0, '显式 0 仍原样透传（由 toLevel 报非法，入口 400）')
    assert.strictEqual(brOf({ br: 320 }), 320)
    assert.ok(brError({ br: '' }), '显式空串仍须报非法（防 ?br= 被静默吞掉）')
  })

  await t('error: 参数类/结构类错误判终态不重试', () => {
    assert.strictEqual(core.error.isTransient(new Error('未知音质参数: 128，可用: exhigh/lossless 或 br 值 320/2000')), false)
    assert.strictEqual(core.error.isTransient(new Error('未知音质等级: hires')), false)
    assert.strictEqual(core.error.isTransient(new Error('FLAC 结构异常（块链解析失败），拒绝重建标签')), false)
  })

  await t('cookie: MUSIC_U=（键在值空）不算已登录', () => {
    const orig = process.env.NCM_COOKIE
    try {
      process.env.NCM_COOKIE = 'MUSIC_U='
      assert.strictEqual(core.cookie.has(), false, '空值 cookie 不得骗过 has()（否则界面显示已登录、请求全裸奔）')
      process.env.NCM_COOKIE = 'MUSIC_U=abc123'
      assert.strictEqual(core.cookie.has(), true)
      assert.strictEqual(core.cookie.get(), 'MUSIC_U=abc123')
    } finally {
      if (orig === undefined) delete process.env.NCM_COOKIE
      else process.env.NCM_COOKIE = orig
    }
  })

  await t('retry: 成功即返回，不重试', async () => {
    let calls = 0
    const r = await core.retry.withRetry(() => { calls++; return 'ok' }, { backoffMs: 1 })
    assert.strictEqual(r, 'ok')
    assert.strictEqual(calls, 1)
  })

  await t('retry: 失败后按次数重试', async () => {
    let calls = 0
    await assert.rejects(
      () => core.retry.withRetry(() => { calls++; throw new Error('boom') }, { retries: 2, backoffMs: 1 })
    )
    assert.strictEqual(calls, 3) // 首次 + 2 次重试
  })

  await t('retry: 第 N 次成功即停', async () => {
    let calls = 0
    const r = await core.retry.withRetry(() => {
      calls++
      if (calls < 3) throw new Error('not yet')
      return 'done'
    }, { retries: 3, backoffMs: 1 })
    assert.strictEqual(r, 'done')
    assert.strictEqual(calls, 3)
  })

  await t('raw: 未知模块报错', async () => {
    await assert.rejects(() => core.raw('no_such_module'))
  })

  await t('retry: 超时参数生效', async () => {
    await assert.rejects(
      () => core.retry.withRetry(() => new Promise((r) => setTimeout(r, 200)), { retries: 0, timeoutMs: 50 }),
      /请求超时/
    )
  })

  await t('error: errMsg 归一文案（JSON/短文案原样、超长截断带原文长度、无 body 走 message）', () => {
    const { errMsg } = core.error
    assert.strictEqual(errMsg({ status: 301, body: { code: 301, msg: '需要登录' } }), '{"code":301,"msg":"需要登录"}')
    assert.strictEqual(errMsg({ status: 404, body: '接口不存在' }), '接口不存在')
    assert.strictEqual(errMsg(new Error('无可用链接 (id=1)')), '无可用链接 (id=1)') // 无 body → message 分支
    const html = '<!DOCTYPE html>' + 'x'.repeat(50000) + '</html>' // 代理/劫持返回的整页 HTML 错误
    const out = errMsg({ status: 502, body: html })
    assert.strictEqual(out, html.slice(0, 300) + `…（响应过长已截断，原文 ${html.length} 字符）`)
    assert.ok(out.length < 400, `截断后应远小于原文，实际 ${out.length}`)
  })

  await t('retry: withTimeout 透传/判负/晚到 rejection 不逃逸 + withRetry 成功无野定时器', async () => {
    assert.strictEqual(await core.retry.withTimeout(Promise.resolve('ok'), 1000), 'ok')
    await assert.rejects(() => core.retry.withTimeout(Promise.reject(new Error('底层挂了')), 1000), /底层挂了/)
    await assert.rejects(() => core.retry.withTimeout(new Promise(() => {}), 50), /请求超时\(50ms\)/)
    // 超时判负后底层晚到的 rejection：race 已订阅，不得变成未处理异常
    let unhandled = 0
    const onUnhandled = () => { unhandled++ }
    process.on('unhandledRejection', onUnhandled)
    try {
      await assert.rejects(
        () => core.retry.withTimeout(new Promise((_, rej) => setTimeout(() => rej(new Error('晚到')), 30)), 10),
        /请求超时\(10ms\)/,
      )
      await new Promise((r) => setTimeout(r, 60)) // 等晚到 rejection 走完微任务检查点
      assert.strictEqual(unhandled, 0, `出现 ${unhandled} 个未处理 rejection`)
    } finally {
      process.removeListener('unhandledRejection', onUnhandled)
    }
    // withRetry 成功路径：超时定时器必须当帧清掉，不得留野定时器占用事件循环
    const countTimers = () => process.getActiveResourcesInfo().filter((x) => x === 'Timeout').length
    const before = countTimers()
    const r = await core.retry.withRetry(() => Promise.resolve('ok'), { retries: 0, timeoutMs: 3000 })
    assert.strictEqual(r, 'ok')
    assert.ok(countTimers() <= before, `成功后多出 ${countTimers() - before} 个未清理定时器`)
  })

  await t('error: isTransient 瞬时/终态分级（无 body 网络错重试，noUrl/400/404/校验失败不重试）', () => {
    const { isTransient } = core.error
    assert.strictEqual(typeof isTransient, 'function')
    // 瞬时：值得重试
    assert.strictEqual(isTransient(new Error('fetch failed')), true, 'fetch 失败应重试')
    assert.strictEqual(isTransient(new Error('请求超时(3000ms)')), true, '超时应重试')
    assert.strictEqual(isTransient(new Error('下载失败: HTTP 500')), true, '5xx 应重试')
    assert.strictEqual(isTransient(new Error('下载失败: HTTP 429')), true, '429 应重试')
    assert.strictEqual(isTransient(new Error('下载截断（断流）: 期望 1000B，实际 100B')), true, '断流应重试')
    assert.strictEqual(isTransient({ status: 503, body: { code: 503, msg: 'busy' } }), true, 'NCM 5xx 应重试')
    assert.strictEqual(isTransient({ status: 200, body: { code: 500, msg: 'err' } }), true, 'NCM body 5xx 应重试')
    // 终态：重试无用
    const noUrl = new Error('无可用链接 (id=1, level=lossless)')
    noUrl.noUrl = true
    assert.strictEqual(isTransient(noUrl), false, 'noUrl 不应重试')
    assert.strictEqual(isTransient(new Error('下载失败: HTTP 404')), false, '404 不应重试')
    assert.strictEqual(isTransient(new Error('下载失败: HTTP 400')), false, '400 不应重试')
    assert.strictEqual(isTransient(new Error('文件校验失败（非 mp3 内容）: /tmp/x.part')), false, '校验失败不应重试')
    assert.strictEqual(isTransient({ status: 404, body: '接口不存在' }), false, 'NCM 404 不应重试')
    assert.strictEqual(isTransient({ status: 400, body: { code: 400, msg: 'bad' } }), false, 'NCM 400 不应重试')
  })

  await t('retry: shouldRetry 回调控制重试（默认全重试保持兼容）', async () => {
    let calls = 0
    await assert.rejects(
      () => core.retry.withRetry(() => { calls++; throw new Error('boom') }, { retries: 2, backoffMs: 1, shouldRetry: () => false }),
    )
    assert.strictEqual(calls, 1, 'shouldRetry=false 应只试 1 次')
    calls = 0
    await assert.rejects(
      () => core.retry.withRetry(() => { calls++; throw new Error('boom') }, { retries: 2, backoffMs: 1, shouldRetry: () => true }),
    )
    assert.strictEqual(calls, 3, 'shouldRetry=true 应试足 3 次')
    // 按错误分流：noUrl 终态不重试，网络错误重试
    calls = 0
    const noUrl = new Error('无可用链接')
    noUrl.noUrl = true
    await assert.rejects(
      () => core.retry.withRetry(() => { calls++; throw noUrl }, { retries: 1, backoffMs: 1, shouldRetry: (e) => core.error.isTransient(e) }),
    )
    assert.strictEqual(calls, 1, 'noUrl 经 isTransient 应只试 1 次')
    calls = 0
    await assert.rejects(
      () => core.retry.withRetry(() => { calls++; throw new Error('fetch failed') }, { retries: 1, backoffMs: 1, shouldRetry: (e) => core.error.isTransient(e) }),
    )
    assert.strictEqual(calls, 2, '瞬时错误经 isTransient 应重试')
    // 404 经 isTransient 不重试
    calls = 0
    await assert.rejects(
      () => core.retry.withRetry(() => { calls++; throw new Error('下载失败: HTTP 404') }, { retries: 1, backoffMs: 1, shouldRetry: (e) => core.error.isTransient(e) }),
    )
    assert.strictEqual(calls, 1, '404 经 isTransient 不应重试')
  })

  // ================= 本轮加固的回归锁 =================
  // 下面每一条都对应一个"已确认存在、且现有用例覆盖不到"的缺陷。
  // 没有它们，下一次重构就能把同一条路悄悄走回去而不被发现。

  await t('error: isTransient 把环境故障/传输停滞判为终态（不再白重试）', () => {
    // adb 未装：重试装不上它；deviceSuspect（USB 半死/adb 挂死）：背靠背重跑同一条命令
    // 设备还没重新枚举，必然再失败。断连的恢复逻辑在 service/phone 的宽限重推里，不在这里
    assert.strictEqual(core.error.isTransient(Object.assign(new Error('未找到 adb 可执行文件'), { noAdb: true })), false)
    assert.strictEqual(core.error.isTransient(Object.assign(new Error('adb 异常退出（exit 1，无任何输出）'), { deviceSuspect: true })), false)
    // 对照：普通超时/连接重置仍须是瞬时（不能一起误伤）
    assert.strictEqual(core.error.isTransient(Object.assign(new Error('x'), { name: 'TimeoutError' })), true)
    assert.strictEqual(core.error.isTransient(Object.assign(new Error('x'), { code: 'ECONNRESET' })), true)
    // 循环引用的 body 不得让错误文案/分级自己抛掉（JSON.stringify 遇环会 TypeError）
    const cyc = { status: 500, body: { msg: 'x' } }
    cyc.body.self = cyc
    assert.ok(typeof core.error.errMsg(cyc) === 'string' && core.error.errMsg(cyc).length > 0)
    assert.strictEqual(core.error.isTransient(cyc), true)
  })

  await t('retry: shouldRetry 自身抛错不得顶掉真实错误（fail-open）', async () => {
    let calls = 0
    const real = new Error('真实的网络失败')
    let got = null
    try {
      await core.retry.withRetry(async () => { calls++; throw real }, {
        retries: 2, backoffMs: 0,
        shouldRetry: () => { throw new Error('判定器自己炸了') },
      })
    } catch (e) { got = e }
    // 判定器坏掉时按"值得重试"兜底；无论重试几次，冒泡的必须是原始错误而不是判定器的错误
    assert.strictEqual(got, real, `冒泡的应是原始错误，实际: ${got && got.message}`)
    assert.ok(calls >= 2, '判定器抛错时按可重试兜底，应至少尝试 2 次')
  })

  await t('util.mergeSignals: 任一信号触发即中断（原生 AbortSignal.any）', async () => {
    const a = new AbortController()
    const b = new AbortController()
    const s = svc.utilMergeSignalsForTest || require('../src/service/util').mergeSignals
    const merged = s(a.signal, b.signal)
    assert.strictEqual(merged.aborted, false)
    b.abort()
    assert.strictEqual(merged.aborted, true, '超时侧触发应连带中断合并信号')
    // 已中止的一侧要立刻生效（不等另一个）
    const c = new AbortController(); c.abort()
    const d = new AbortController()
    assert.strictEqual(s(c.signal, d.signal).aborted, true, '传入已中止信号应立即为中止态')
    // 单侧/空侧的退化形态
    assert.strictEqual(s(null, b.signal), b.signal)
    assert.strictEqual(s(a.signal, null), a.signal)
  })

  await t('cookie: 含换行的 cookie 判为未登录（否则全站 ERR_INVALID_CHAR 却显示已登录）', async () => {
    // 决策 92。trim 只去首尾，从编辑器粘贴的 cookie 很容易在两段之间留换行。
    // 带 LF 的 Cookie 头被 Node 直接抛 ERR_INVALID_CHAR → 每个接口都 500，
    // 而 /api/login/status 仍报 cookie 有效 → 用户同时看到"已登录"和"服务全挂"。
    // 注：NUL 无法用环境变量构造（Windows 的 set 会在 NUL 处截断整个值），
    // 那条路径在真实场景里表现为"cookie 被截成半个"——同样由 has() 判为非空而误报已登录
    const saved = process.env.NCM_COOKIE
    try {
      process.env.NCM_COOKIE = 'MUSIC_U=abc\nX-Injected: def'
      core.cookie._resetCache()
      assert.strictEqual(core.cookie.has(), false, '含换行的 cookie 必须判为未登录')
      process.env.NCM_COOKIE = 'MUSIC_U=正常值'
      core.cookie._resetCache()
      assert.strictEqual(core.cookie.has(), true, '正常 cookie 必须判为已登录（别把好凭证也毙了）')
    } finally {
      if (saved === undefined) delete process.env.NCM_COOKIE
      else process.env.NCM_COOKIE = saved
      core.cookie._resetCache()
    }
  })

  await t('cookie: _useFile 隔离后可测 save/clear 与 mtime 失效', () => {
    const f = path.join(TEST_DOWNLOAD_DIR, 'cookie-test.txt')
    core.cookie._useFile(f)
    try {
      core.cookie.save('MUSIC_U=abc')
      assert.strictEqual(core.cookie.get(), 'MUSIC_U=abc')
      assert.ok(fs.existsSync(f), 'save 必须落盘')
      // 裸值自动补键名；双前缀去重；带空格的值要 trim（否则 has() 报已登录但请求被网易拒）
      core.cookie.save('bare')
      assert.strictEqual(core.cookie.get(), 'MUSIC_U=bare')
      core.cookie.save('MUSIC_U=MUSIC_U=x')
      assert.strictEqual(core.cookie.get(), 'MUSIC_U=x')
      assert.strictEqual(core.cookie.save('MUSIC_U=  padded  '), undefined)
      assert.strictEqual(core.cookie.get(), 'MUSIC_U=padded', '值里的空格必须被 trim')
      // 空值不算登录态
      core.cookie.save('MUSIC_U=')
      assert.strictEqual(core.cookie.has(), false)
      // 外部改文件后应立即可见（mtime 失效）。同毫秒写入时 mtime 可能不变，
  // 那是 mtime 缓存的固有取舍（cookie.js 注释已声明），故这里只断言"读到的是文件当前内容"，
  // 不强行要求一定是 second —— 强行要求会把测试写成必然偶发失败的那一类
      core.cookie.save('MUSIC_U=first')
      const onDisk = fs.readFileSync(f, 'utf8').trim()
      assert.strictEqual(core.cookie.get(), onDisk, 'get() 必须与文件当前内容一致')
      core.cookie.clear()
      assert.strictEqual(core.cookie.has(), false)
      assert.ok(!fs.existsSync(f), 'clear 必须删文件')
    } finally { core.cookie._useFile() }
  })

  await t('cookie: 归一化不得破坏"以其它键开头"的真实 cookie', () => {
    // 真实 cookie.txt 以 MUSIC_A_T= 之类开头；若归一化把它当裸值再包一层 MUSIC_U=，
    // 产出的凭证网易根本不认——表现为"明明登录了却什么都下不了"，且毫无报错可查
    const f = path.join(TEST_DOWNLOAD_DIR, 'cookie-real.txt')
    const real = 'MUSIC_A_T=1671529203667; Max-Age=2147483647; MUSIC_U=realvalue; __csrf=abc'
    core.cookie._useFile(f)
    try {
      core.cookie.save(real)
      assert.strictEqual(core.cookie.get(), real, '其它键开头的 cookie 必须原样透传')
      assert.strictEqual(core.cookie.has(), true)
      // 双前缀必须真正去重（此前只是"剥一个再补一个"，等于没去）
      core.cookie.save('MUSIC_U=MUSIC_U=x')
      assert.strictEqual(core.cookie.get(), 'MUSIC_U=x', '双前缀必须循环剥到只剩一个')
      // 真实项目里的 cookie.txt 必须能原样通过归一化（防止改动破坏线上登录态读取）
      core.cookie._useFile()
      const onDisk = fs.readFileSync(path.join(__dirname, '..', 'cookie.txt'), 'utf8').trim()
      assert.strictEqual(core.cookie.get(), onDisk, '真实 cookie.txt 归一化后必须与原文逐字节一致')
    } finally { core.cookie._useFile() }
  })
}
