/**
 * 能力层（编排/策略）统一出口
 * 职责：基于 core 原子能力做组合与策略——重试降级、循环拉批、批量容错、格式组装、缓存、任务排队
 * 不含 HTTP 语义；HTTP 门面（server.js）只做路由与参数解析
 */
module.exports = {
  resolve: require('./resolve'),
  download: require('./download'),
  naming: require('./naming'),       // 命名/歌词/封面规则唯一出处（两条管线与增量共用）
  pipeline: require('./pipeline'),   // 批量下载统一骨架（本地 fs 与手机 adb 共用）
  incremental: require('./incremental'),
  storage: require('./storage'),
  playlist: require('./playlist'),
  recommend: require('./recommend'),
  chart: require('./chart'),
  meting: require('./meting'),
  login: require('./login'),
  queue: require('./queue'),
  adb: require('./adb'),
  dest: require('./dest'),
  phone: require('./phone'),
  job: require('./job'),
  params: require('./params'),
  httputil: require('./httputil'),
  instance: require('./instance'),
  logger: require('./logger'),
  core: require('../core'), // 底层能力同样从此可达，方便上层自由组合
}
