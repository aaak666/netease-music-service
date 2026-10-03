/**
 * 底层纯函数单测（无网络，毫秒级）入口：node test/unit.test.js
 * 用例按领域拆在同目录 unit.*.js 分件（下方数组顺序 = 执行顺序）；桩/收集器/清场在 unit.harness.js。
 * 默认文件系统=内存（memfs）：全程零真实磁盘写入；node test/unit.test.js --io 切换真实落盘（结束照样清场）。
 */
const harness = require('./unit.harness')

const parts = [
  require('./unit.01-core-foundation.js'),
  require('./unit.02-tag-lyric.js'),
  require('./unit.03-fetchers.js'),
  require('./unit.04-platform.js'),
  require('./unit.05-download.js'),
  require('./unit.06-storage.js'),
  require('./unit.07-incremental.js'),
  require('./unit.08-queue.js'),
  require('./unit.09-phone-adb.js'),
  require('./unit.10-job.js'),
  require('./unit.11-server.js'),
]

async function main() {
  harness.begin()
  for (const run of parts) await run()
  harness.finish()
}

main()
