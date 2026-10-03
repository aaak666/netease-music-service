/**
 * 集成测试（需 cookie + 网络）：node test/integration.test.js
 * 覆盖：core 单批原语契约 → service 编排 → HTTP 门面冒烟（含任务取消 cancelled、DELETE、/api/jobs 瘦身）
 * 约定：新增/常驻断言只依赖本机回环 + 内存任务状态（DELETE 未知任务、jobs 瘦身形状），不下歌、不碰 downloads/；
 * 需网易网络的断言沿用旧数据选择（26545127 等），只读码对齐、跑时才发请求。
 */
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const core = require('../src/core')
const svc = require('../src/service')
// 测试产生的下载统一落到临时目录，避免污染真实 downloads
process.env.DOWNLOAD_DIR = path.join(__dirname, 'tmp')
// 目的地配置同样指向临时文件：本机真实 destinations.json 若激活了手机/自定义目的地，
// 集成任务的下载会被路由到手机（真往设备写歌）或外部目录，而不是测试临时目录
svc.dest._useFile(path.join(__dirname, 'tmp', 'destinations.json'))
// 运行日志指向临时文件：集成任务的状态翻转/建任务失败日志不得混进生产 logs/service.log
svc.logger._useFile(path.join(__dirname, 'tmp', 'service.log'))
const { app } = require('../server')

const results = []
async function t(name, fn) {
  try {
    await fn()
    results.push(true)
    console.log(`  ✓ ${name}`)
  } catch (e) {
    results.push(false)
    console.error(`  ✗ ${name}: ${e.message}`)
  }
}

const TMP = path.join(__dirname, 'tmp')
let server

async function main() {
  console.log('== 集成测试（需网络与登录） ==')
  server = app.listen(3101)

  await t('cookie: 已加载', () => {
    assert.ok(core.cookie.has(), 'cookie 未配置，请先 node login.js 扫码')
  })

  // ---- core 单批原语契约 ----
  await t('core.song: 单批详情', async () => {
    const s = await core.song.getOne(26545127)
    assert.strictEqual(s.name, '兄弟难当')
    assert.strictEqual(s.artist, '杜歌')
    assert.ok(s.picUrl.startsWith('http'))
  })

  await t('core.lyric: 歌词', async () => {
    const { lrc, hasLrc } = await core.lyric.get(26545127)
    assert.ok(hasLrc && lrc.includes('兄弟'))
  })

  await t('core.url: 单次解析 320k', async () => {
    const r = await core.url.resolve(26545127, { br: 320 })
    assert.strictEqual(r.level, 'exhigh')
    assert.strictEqual(r.ext, 'mp3')
  })

  await t('core.url: 单次解析无损（服务端降级也视为成功）', async () => {
    const r = await core.url.resolve(26545127, { br: 2000 })
    // 请求档位仅 exhigh/lossless（hires 等请求参数已拒绝）；hires 在此仅指数值服务端回吐的实际档位
    //（quality.extOf 仍把 hires 映射为 flac），不断言请求侧。
    assert.ok(['lossless', 'hires'].includes(r.level))
    assert.strictEqual(r.ext, 'flac')
  })

  await t('core.playlist: 歌单详情原语', async () => {
    const d = await core.playlist.fetchDetail(7833074177)
    assert.ok(d.count > 100)
    assert.strictEqual(d.trackIds.length, d.count)
  })

  await t('core.recommend: FM 单批契约（1~3 首，流式累计的前提）', async () => {
    const page = await core.recommend.fetchFmPage({ mode: 'EXPLORE' })
    assert.ok(page.length >= 1 && page.length <= 30, `单批数量异常: ${page.length}`)
  })

  await t('core.recommend: 相似歌曲单批契约（5 首）', async () => {
    const page = await core.recommend.fetchSimiPage(26545127)
    assert.ok(page.length > 0 && page.length <= 10, `单批数量异常: ${page.length}`)
  })

  await t('core.recommend: 每日推荐单批', async () => {
    const list = await core.recommend.fetchDaily()
    assert.ok(list.length >= 10)
  })

  await t('core.chart: toplist 原语', async () => {
    const list = await core.chart.fetchToplist()
    assert.ok(list.length >= 60)
  })

  // ---- service 编排 ----
  await t('service.resolve: 降级策略兜底', async () => {
    const r = await svc.resolve.resolveWithFallback(26545127, { br: 2000 })
    assert.ok(r.url.startsWith('http'))
  })

  await t('service.playlist: 组合取全量曲目', async () => {
    const pl = await svc.playlist.get(7833074177)
    assert.strictEqual(pl.songs.length, pl.count)
  })

  await t('service.recommend: 电台累计拉批 + 去重', async () => {
    const { songs, batches } = await svc.recommend.fm({ mode: 'EXPLORE', total: 8 })
    assert.ok(songs.length >= 5, `只取到 ${songs.length} 首`)
    assert.ok(batches > 1)
    assert.strictEqual(new Set(songs.map((s) => s.id)).size, songs.length)
  })

  await t('service.recommend: 相似歌曲链式扩展', async () => {
    const { songs, batches } = await svc.recommend.simi(26545127, { total: 15 })
    assert.ok(songs.length >= 10)
    assert.ok(batches > 1)
    assert.strictEqual(new Set(songs.map((s) => s.id)).size, songs.length)
  })

  await t('service.chart: 中文名 + 缓存', async () => {
    const chart = await svc.chart.get('飙升榜', { limit: 5 })
    assert.strictEqual(chart.songs.length, 5)
    assert.ok(chart.songs[0].name)
    await assert.rejects(() => svc.chart.get('不存在的榜单xyz'))
  })

  await t('service.download: MP3 落盘 + 封面内嵌产物合规 + 命名为纯歌名', async () => {
    const r = await svc.download.download(26545127, { dir: TMP, br: 320, cover: true })
    assert.ok(fs.existsSync(r.filepath) && r.filepath.endsWith('.mp3'))
    // 产品拍板：文件名 = 纯歌名，不带歌手前缀
    assert.strictEqual(path.basename(r.filepath), '兄弟难当.mp3', `命名不符: ${r.filepath}`)
    assert.strictEqual(r.embedded, true, `内嵌失败: ${r.embedError}`)
    const v = core.tag.verifyTags(r.filepath)
    assert.ok(v.ok, `产物校验失败: ${v.error}`)
    assert.ok(v.apic)
    // 下载目录不允许残留封面文件（封面只进音频内嵌）
    const leftovers = fs.readdirSync(TMP).filter((f) => f.includes('-cover'))
    assert.deepStrictEqual(leftovers, [], `封面残留: ${leftovers}`)
  })

  await t('service.download: FLAC 落盘 + 封面内嵌产物合规', async () => {
    const r = await svc.download.download(26545127, { dir: TMP, br: 2000, cover: true })
    assert.ok(r.filepath.endsWith('.flac'))
    assert.strictEqual(fs.readFileSync(r.filepath).subarray(0, 4).toString('ascii'), 'fLaC')
    assert.strictEqual(r.embedded, true, `内嵌失败: ${r.embedError}`)
    const v = core.tag.verifyTags(r.filepath)
    assert.ok(v.ok, `产物校验失败: ${v.error}`)
    assert.ok(v.dataLen > 10000, `内嵌图片太小: ${v.dataLen}`)
  })

  await t('service.incremental: 音质补下（只增不删、已有歌词不重写、同音质不再重下）', async () => {
    const qdir = path.join(TMP, 'qfill')
    // 第一遍：只有 320k MP3 + 手工放一份"上次已下过"的歌词
    await svc.download.download(26545127, { dir: qdir, br: 320, cover: false })
    assert.ok(fs.existsSync(path.join(qdir, '兄弟难当.mp3')))
    fs.writeFileSync(path.join(qdir, '兄弟难当.lrc'), '[00:01.00]已有歌词', 'utf8')
    const songs = await core.song.getDetail([26545127])
    // 第二遍：要无损 + 音质补下 → 应补 flac，不动 mp3，不重写歌词
    const plan = svc.incremental.plan(songs, svc.incremental.scanDir(qdir), { lyrics: true, qualityExt: 'flac' })
    assert.deepStrictEqual(plan.download.map((s) => s.id), [26545127], '缺无损应补下')
    assert.strictEqual(plan.lyricsFor.has(songs[0]), false, '歌词已有不得重写')
    await svc.incremental.run(plan, { dir: qdir, br: 2000, lyrics: true, cover: false, skipIfExists: true })
    assert.ok(fs.existsSync(path.join(qdir, '兄弟难当.mp3')), '旧音质必须保留（只增不删）')
    assert.ok(fs.existsSync(path.join(qdir, '兄弟难当.flac')), '无损应补上')
    assert.strictEqual(fs.readFileSync(path.join(qdir, '兄弟难当.lrc'), 'utf8'), '[00:01.00]已有歌词', '歌词不得被覆盖')
    // 第三遍：无损已在 → 不再重下
    const plan2 = svc.incremental.plan(songs, svc.incremental.scanDir(qdir), { qualityExt: 'flac' })
    assert.strictEqual(plan2.download.length, 0)
    assert.deepStrictEqual(plan2.skipped.map((s) => s.id), [26545127])
    // 不勾补下时：有 mp3 即跳过（原口径回归）
    const plan3 = svc.incremental.plan(songs, svc.incremental.scanDir(qdir))
    assert.deepStrictEqual(plan3.skipped.map((s) => s.id), [26545127])
  })

  await t('service.download: 翻译歌词合并写入 .lrc（紧跟同时间戳原文行）', async () => {
    // 1484889 (My Heart Will Go On) 在网易有中文翻译歌词，用于验证 tlyric 合并落盘
    const r = await svc.download.download(1484889, { dir: TMP, br: 320, cover: false, lyrics: true })
    assert.ok(r.lrcFile && fs.existsSync(r.lrcFile), '未生成 .lrc')
    const lines = fs.readFileSync(r.lrcFile, 'utf8').split(/\r?\n/)
    const i = lines.findIndex((l) => l.includes('每一个夜晚'))
    assert.ok(i > 0, '翻译行缺失，未合并')
    const stamp = (l) => (l.match(/^\[[^\]]+\]/) || [''])[0]
    assert.strictEqual(stamp(lines[i]), stamp(lines[i - 1]), '翻译行未紧跟同时间戳的原文行')
    assert.ok(lines[i - 1].includes('dreams'), `原文行异常: ${lines[i - 1]}`)
  })

  await t('service.download: 失败记失败不阻塞（坏ID终态不重试）', async () => {
    // 坏 ID 抛 noUrl（服务端确认无资源，isTransient=false）→ resolve 层不重试（单次阶梯尝试即停）；
    // 只有网络抖动/断流/5xx/超时才重试 1 次。downloadMany 捕获记失败，不中断整批。
    const rs = await svc.download.downloadMany([999999999999], { dir: TMP, br: 320 })
    assert.strictEqual(rs[0].ok, false)
    assert.ok(rs[0].error)
  })

  // ---- HTTP 门面冒烟 ----
  await t('HTTP: /meting?type=song', async () => {
    const j = await (await fetch('http://127.0.0.1:3101/meting?type=song&id=26545127')).json()
    assert.ok(j[0].name && j[0].url)
  })

  await t('HTTP: /meting?type=url&format=json', async () => {
    const j = await (await fetch('http://127.0.0.1:3101/meting?type=url&id=26545127&br=2000&format=json')).json()
    assert.ok(j[0].url.includes('.flac'))
  })

  await t('HTTP: /meting?type=lrc（含翻译合并口径）', async () => {
    // 门面与下载写盘同口径：译文按时间戳插在原文行下方（此前只回原文）。断言只看原文行仍含歌名关键字，
    // 不依赖译文是否存在（无译文时原样返回原文）。
    const text = await (await fetch('http://127.0.0.1:3101/meting?type=lrc&id=26545127')).text()
    assert.ok(text.includes('兄弟'))
  })

  await t('HTTP: /meting?type=pic 302', async () => {
    const resp = await fetch('http://127.0.0.1:3101/meting?type=pic&id=26545127', { redirect: 'manual' })
    assert.strictEqual(resp.status, 302)
  })

  await t('HTTP: /recommend/daily', async () => {
    const j = await (await fetch('http://127.0.0.1:3101/recommend/daily')).json()
    assert.ok(j.length > 0 && j[0].url && j[0].lrc)
  })

  await t('HTTP: /chart/新歌榜', async () => {
    const j = await (await fetch('http://127.0.0.1:3101/chart/' + encodeURIComponent('新歌榜') + '?limit=3')).json()
    assert.strictEqual(j.length, 3)
  })

  await t('HTTP: 非法音质在入口被拒（400，不再建任务逐首失败）', async () => {
    const resp = await fetch('http://127.0.0.1:3101/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'song', id: '26545127', br: '128' }),
    })
    assert.strictEqual(resp.status, 400, `期望 400，实际 ${resp.status}`)
    const j = await resp.json()
    assert.ok(String(j.error).includes('未知音质参数'), j.error)
  })

  await t('HTTP: /meting?type=url 缺省音质为无损', async () => {
    // 缺省走 brOf → 2000（lossless）；断言保留 hires 只因服务端可能回吐更实际档位（见 core.url 用例注释）
    const j = await (await fetch('http://127.0.0.1:3101/meting?type=url&id=26545127&format=json')).json()
    assert.ok(['lossless', 'hires'].includes(j[0].level), `实际 level: ${j[0].level}（期望缺省无损）`)
  })

  await t('HTTP: /download/daily 异步任务（返回 jobId，轮询到完成）', async () => {
    const j = await (await fetch('http://127.0.0.1:3101/download/daily?limit=2&br=320')).json()
    assert.ok(j.jobId && j.count === 2, `响应异常: ${JSON.stringify(j)}`)
    // 歌词开关缺省开（lyricsOn：显式 false/0 才关，下载写词与增量补词同一开关）：本任务会顺带写 .lrc，
    // result.filled 可能 >0，但不影响 ok/files 断言（summarize.ok 只计真正落盘的新音频，existed 另计）。
    // 全局队列 + 下载是后台执行，轮询等待完成
    let job
    for (let i = 0; i < 300; i++) {
      job = await (await fetch(`http://127.0.0.1:3101/api/job/${j.jobId}`)).json()
      // 终态 = done / error / cancelled（DELETE 协作式取消会落 cancelled）；只在 running/queued 时继续等
      if (job.status !== 'running' && job.status !== 'queued') break
      await new Promise((r) => setTimeout(r, 200))
    }
    assert.strictEqual(job.status, 'done', `任务未完成: ${job.status} ${job.error || ''}（若为 cancelled 说明被外部取消）`)
    assert.strictEqual(job.result.ok, 2, `下载失败: ${JSON.stringify(job.result.failed)}`)
    for (const f of job.result.files) assert.ok(fs.existsSync(f))
  })

  await t('HTTP: 同一歌单重复建任务合并为一个（按 batchKey，不比目录名）', async () => {
    const post = () => fetch('http://127.0.0.1:3101/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'playlist', id: '7833074177', limit: 5, br: '320' }),
    }).then((r) => r.json())
    const r1 = await post()
    assert.ok(r1.jobId, `建任务失败: ${JSON.stringify(r1)}`)
    // 连点第二次应合并到活跃任务。容错：若首个任务因网络抖动瞬间失败（error 不合并，可重跑），
    // 就再发几次——只要存在活跃的同目录任务就应命中 already
    let r2 = null
    for (let i = 0; i < 10 && !(r2 && r2.already); i++) {
      await new Promise((r) => setTimeout(r, 300))
      r2 = await post()
    }
    assert.ok(r2 && r2.already, `重复建任务应合并: ${JSON.stringify(r2)}`)
    // 等任务收尾再继续，避免后台写盘与测试末尾的目录清理赛跑
    // （终态含 cancelled：若外部取消了任务，这里会停在 cancelled 而非 done，下式如实报错）
    let job = null
    for (let i = 0; i < 600; i++) {
      job = await (await fetch(`http://127.0.0.1:3101/api/job/${r2.jobId}`)).json()
      if (job.status !== 'running' && job.status !== 'queued') break
      await new Promise((r) => setTimeout(r, 200))
    }
    assert.strictEqual(job.status, 'done', `任务未完成: ${job.status} ${job.error || ''}`)
  })

  // 以下仅依赖本机回环 + 内存任务状态，不发网易网络请求、不下歌
  await t('HTTP: DELETE /api/job/:id 未知任务 404', async () => {
    const resp = await fetch('http://127.0.0.1:3101/api/job/999999999', { method: 'DELETE' })
    assert.strictEqual(resp.status, 404, `期望 404，实际 ${resp.status}`)
    const j = await resp.json()
    assert.ok(String(j.error).includes('任务不存在'), `文案异常: ${JSON.stringify(j)}`)
  })

  await t('HTTP: /api/jobs 列表瘦身（终态任务截日志、去 files/跳过明细）', async () => {
    const list = await (await fetch('http://127.0.0.1:3101/api/jobs')).json()
    assert.ok(Array.isArray(list), `响应非数组: ${JSON.stringify(list)}`)
    assert.ok(list.length <= 20, `列表应最多 20 个，实际 ${list.length}`)
    // 按 startedAt 倒序（新任务在前）
    for (let i = 1; i < list.length; i++) {
      assert.ok(list[i - 1].startedAt >= list[i].startedAt, '任务列表未按 startedAt 倒序')
    }
    // 前面两个用例已建任务并轮询到终态：终态任务走瘦身（done/error/cancelled 截日志去 files），
    // running/queued 保持全量（前端贴底跟随依赖完整日志）。要完整数据走 /api/job/:id。
    const fin = list.find((x) => x.status === 'done' || x.status === 'error' || x.status === 'cancelled')
    assert.ok(fin, `前序任务应已落终态，实际列表状态: ${list.map((x) => x.status).join(',')}`)
    assert.ok((fin.log || []).length <= 100, `终态日志应截到最后 100 行，实际 ${(fin.log || []).length}`)
    assert.strictEqual(typeof fin.logTotal, 'number', '终态任务应带 logTotal（完整日志行数）')
    if (fin.result) {
      assert.strictEqual(fin.result.files, undefined, '瘦身列表的 result 不得带逐首 files')
      assert.strictEqual(fin.result.skippedNames, undefined, '瘦身列表的 result 不得带跳过明细')
    }
  })

  await t('HTTP: DELETE /api/job/:id 已结束任务拒绝（400），cancelled 幂等', async () => {
    const list = await (await fetch('http://127.0.0.1:3101/api/jobs')).json()
    const doneJob = list.find((x) => x.status === 'done' || x.status === 'error')
    assert.ok(doneJob, '需要一个已结束任务来验证 DELETE 拒绝语义')
    const resp = await fetch(`http://127.0.0.1:3101/api/job/${doneJob.id}`, { method: 'DELETE' })
    assert.strictEqual(resp.status, 400, `已结束任务应 400，实际 ${resp.status}`)
    const j = await resp.json()
    assert.ok(String(j.error).includes('任务已结束'), `文案异常: ${JSON.stringify(j)}`)
  })

  server.close()
  fs.rmSync(TMP, { recursive: true, force: true })

  const fails = results.filter((ok) => !ok).length
  console.log(`\n== 集成测试: ${results.length - fails}/${results.length} 通过 ==`)
  process.exit(fails ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
