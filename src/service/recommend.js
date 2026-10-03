/**
 * 推荐服务：无限流电台的循环拉批/去重策略（fm）与相似歌曲链式扩展（simi）
 * 单批原语来自 core.recommend
 */
const core = require('../core')
const { sleep } = require('./util')

/** 批间延迟（util.sleep）：防连续拉批直打网易触发 502 限流 */
function batchDelayMs() {
  return 250 + Math.random() * 150 + Math.random() * 150
}

/** 纯函数：按 id 去重合并 */
function dedupe(existing, incoming) {
  const seen = new Set(existing.map((s) => s.id))
  const added = []
  for (const s of incoming) {
    if (!seen.has(s.id)) {
      seen.add(s.id)
      added.push(s)
    }
  }
  return added
}

/**
 * 私人FM/私人雷达(FAMILIAR)/私人漫游(EXPLORE)：循环拉批累计到 total 首
 * 连续 3 批无新歌自动停止（电台池可能枯竭）
 * 批间延迟：非首批且未达 total 时 sleep（防限流 502），opts.noDelay=true 跳过（单测用）
 * @returns { songs, batches }
 */
async function fm({ mode, submode, total = 30, maxBatches = 100, noDelay = false } = {}) {
  const songs = []
  let batches = 0
  let dryRounds = 0
  while (songs.length < total && batches < maxBatches && dryRounds < 3) {
    if (batches > 0 && !noDelay && songs.length < total) await sleep(batchDelayMs())
    batches++
    const before = songs.length
    const page = await core.recommend.fetchFmPage({ mode, submode })
    songs.push(...dedupe(songs, page))
    if (songs.length === before) dryRounds++
    else dryRounds = 0
  }
  return { songs: songs.slice(0, total), batches }
}

/**
 * 相似歌曲：以结果为种子继续扩展（广度优先），直到凑够 total 首
 * 批间延迟：非首批且未达 total 时 sleep（防限流 502），opts.noDelay=true 跳过（单测用）
 * @returns { songs, batches, exhausted }
 */
async function simi(id, { total = 30, maxBatches = 60, noDelay = false } = {}) {
  const seed = String(id)
  const songs = []
  let batches = 0
  let queue = [seed]
  const visited = new Set([seed])
  let exhausted = false

  while (songs.length < total && batches < maxBatches && queue.length) {
    if (batches > 0 && !noDelay && songs.length < total) await sleep(batchDelayMs())
    batches++
    const current = queue.shift()
    const page = await core.recommend.fetchSimiPage(current)
    const fresh = dedupe(songs, page)
    songs.push(...fresh)
    for (const s of fresh) {
      if (!visited.has(String(s.id))) {
        visited.add(String(s.id))
        queue.push(String(s.id))
      }
    }
    if (!page.length && !queue.length) exhausted = true
  }
  return { songs: songs.slice(0, total), batches, exhausted }
}

/** 便捷透传（单请求能力） */
const daily = () => core.recommend.fetchDaily()
const heartMode = (pid, id, opts) => core.recommend.fetchHeartMode(pid, id, opts)

module.exports = { fm, simi, daily, heartMode }
