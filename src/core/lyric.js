/**
 * 歌词核心模块：取歌词原语 + 翻译合并纯函数
 */
const cookie = require('./cookie')
const { lyric } = require('NeteaseCloudMusicApi')

/** 返回 { lrc, tlyric(翻译), hasLrc }；无歌词时 lrc 为空串 */
async function get(id) {
  const { body } = await lyric({ id, cookie: cookie.get() })
  return {
    lrc: (body.lrc && body.lrc.lyric) || '',
    tlyric: (body.tlyric && body.tlyric.lyric) || '',
    hasLrc: Boolean(body.lrc && body.lrc.lyric && !/^$/.test(body.lrc.lyric.trim())),
  }
}

// [mm:ss] / [mm:ss.x] / [mm:ss.xx] / [mm:ss.xxx]，捕获组：分、秒、毫秒小数、文本
const TIME_LINE = /^\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\](.*)$/

/** 时间戳 → 毫秒：小数按位补到 3 位（.5 = 500ms 与 .50 = 500ms 视为同一时刻） */
function stampMs(m) {
  const ms = m[3] ? Number(m[3].padEnd(3, '0')) : 0
  return (Number(m[1]) * 60 + Number(m[2])) * 1000 + ms
}

/** 行内多时间戳拆对：'[00:01.00][00:30.00]词' → [{stamp,text},...]；无时间戳行返回 [] */
function stampsOf(line) {
  const pairs = []
  let rest = line
  for (;;) {
    const m = rest.match(TIME_LINE)
    if (!m) break
    pairs.push({ stamp: stampMs(m), text: m[4] })
    rest = m[4]
  }
  return pairs
}

/**
 * 纯函数：把翻译行按时间戳合并进原文——翻译行紧跟在对应原文行之后
 *  - 无时间戳行（[ti:] 等元数据）原样保留
 *  - 对不上任何原文时间戳的翻译行丢弃（无法定位落点）
 *  - 原文同一时间戳出现多次（重复段落）时，每处都补翻译
 *  - 行内多时间戳（[00:01][00:30]词，网易翻译源偶见）逐对处理，不丢第二对
 * @returns 合并后的 lrc 文本；lrc 为空返回空串，无翻译原样返回
 */
function mergeTranslation(lrc, tlyric) {
  if (!lrc) return ''
  if (!tlyric) return lrc
  const trans = new Map()
  for (const line of tlyric.split(/\r\n|\r|\n/)) {
    const pairs = stampsOf(line)
    if (!pairs.length) continue
    // 正文 = 最后一个时间戳之后的剩余文本（前面所有时间戳都被逐个剥掉）
    const text = pairs[pairs.length - 1].text.trim()
    if (!text) continue
    for (const { stamp } of pairs) {
      // 同一时间戳多行翻译只保留首行：后行多为重复回写，静默覆盖会让结果取决于行序
      if (!trans.has(stamp)) trans.set(stamp, text)
    }
  }
  if (!trans.size) return lrc
  const out = []
  for (const line of lrc.split(/\r\n|\r|\n/)) {
    out.push(line)
    const pairs = stampsOf(line)
    for (const { stamp, text } of pairs) {
      const t = trans.get(stamp)
      // 时间戳复用原文行的书写形式，保证合并后两行完全对齐
      if (t && text) out.push(line.slice(0, line.length - text.length) + t)
    }
  }
  return out.join('\n')
}

module.exports = { get, mergeTranslation }
