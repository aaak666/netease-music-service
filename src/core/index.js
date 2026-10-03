/**
 * 底层模块统一出口：只含原子能力（单次请求 / 纯映射 / 单文件流操作）
 * 编排与策略（重试降级、循环拉批、批量、格式组装）在 ../service
 *
 * 分块豁免清单（已评审的例外，新例外须在此登记）：
 *  - song.getDetail 的 500/批分页循环——批量 ID 查询是网易接口的硬性形态，属"单次外部交互"的变体而非编排
 */
module.exports = {
  cookie: require('./cookie'),
  quality: require('./quality'),
  raw: require('./raw'), // 注意：函数本体而非命名空间（调用形态 core.raw('album', {...})），见 raw.js 尾注
  retry: require('./retry'),
  song: require('./song'),
  playlist: require('./playlist'),
  lyric: require('./lyric'),
  url: require('./url'),
  download: require('./download'),
  tag: require('./tag'),
  adb: require('./adb'),
  login: require('./login'),
  dialog: require('./dialog'),
  recommend: require('./recommend'),
  chart: require('./chart'),
  error: require('./error'),
}
