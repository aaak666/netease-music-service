/**
 * 下载目的地配置：把"下载文件夹"从固定的 downloads\ 扩展成任意资源管理器可达的位置
 *  - local：本地/网络盘任意目录——现有下载管线原样工作（storage 全部函数以 base 为参数）
 *  - phone：Android 设备目录（ADB 直写，零本地磁盘）——管线在 service/phone
 * 配置持久化在项目根 destinations.json（gitignore：含本机路径）；缺省（active=null）即项目 downloads\
 */
const fs = require('fs')
const path = require('path')
const core = require('../core')
const adbSvc = require('./adb')
const logger = require('./logger')

let FILE = path.join(__dirname, '..', '..', 'destinations.json')
let cache = null

/**
 * 读配置（无/坏文件视为空配置——与批次标记的向后兼容口径一致）
 * mtime 失效：文件是手工可编辑的（注释里就建议用户手改 next/删条目），服务运行期间改动应当立即生效，
 * 否则用户改完发现没反应，只能重启服务。与 core/cookie 的 mtime 缓存同一策略（只 stat 不读内容）
 */
function load() {
  let mtimeMs = -1
  try { mtimeMs = fs.statSync(FILE).mtimeMs } catch { /* 无文件：走下面的空配置 */ }
  if (cache && cache.mtimeMs === mtimeMs) return cache.cfg
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const list = Array.isArray(raw.list) ? raw.list : []
      // 手工编辑必须与 addLocal/addPhone 走**同一道闸**（决策 91）：文件注释里就建议用户手改，
      // 而 addLocal 会拒绝盘根/不可写目录 —— 但手改绕过了全部校验，于是
      // {"kind":"local","path":"C:\\"} 能过 load()，随后建任务时 storage.sweepDownloads("C:\\")
      // 递归遍历整块磁盘，把别家软件的 *.part / *.tagtmp 全删了（不可恢复、无记录）。
      // 这里对每条做形状与合法性核对，不合格的丢弃并大声告警（保留其余条目）
      const kept = []
      for (const d of list) {
        if (!d || typeof d !== 'object' || Array.isArray(d)) { warnBad(d, '不是对象'); continue }
        if (typeof d.id !== 'string' || !d.id) { warnBad(d, '缺 id'); continue }
        if (typeof d.path !== 'string' || !d.path.trim()) { warnBad(d, '缺路径'); continue }
        if (d.kind !== 'local' && d.kind !== 'phone') { warnBad(d, `未知类型 ${JSON.stringify(d.kind)}`); continue }
        if (d.kind === 'local') {
          // 盘根/用户目录这类"整棵子树"目标会让清扫与批次目录创建失控，必须拒
          const root = path.parse(path.resolve(d.path)).root
          if (path.resolve(d.path) === root) { warnBad(d, '不能是磁盘根目录（会让半成品清扫遍历整块盘）'); continue }
        }
        kept.push(d)
      }
      // next 与现有 id 校对：手工编辑/旧版配置缺 next 或 next 落后时会发出重复 id，
      // get 恒命中第一条、remove 的 filter 会把两条一起删——这里取 max(next, 最大已有 id + 1)
      const maxId = kept.reduce((m, d) => Math.max(m, Number(String(d && d.id || '').replace(/^d/, '')) || 0), 0)
      const activeKept = kept.some((d) => d.id === raw.active) ? raw.active : null
      cache = { mtimeMs, cfg: { active: typeof raw.active === 'string' ? (activeKept) : null, next: Math.max(Number(raw.next) || 1, maxId + 1), list: kept } }
      return cache.cfg
    }
  } catch (e) {
    if (e instanceof SyntaxError) {
      // 坏 JSON 不能只是"当空配置用"：随后任何一次 save 都会用空列表覆盖原文件，
      // 用户的全部目的地配置无声丢失——先把原文件留个 .bak 底
      try { fs.renameSync(FILE, FILE + '.bak') } catch { /* 留不住就算了 */ }
    }
  }
  cache = { mtimeMs: -1, cfg: { active: null, next: 1, list: [] } }
  return cache.cfg
}

/** 手改配置里出现非法条目时的告警：必须出声 —— 静默丢弃等于用户的配置"自己改了" */
function warnBad(d, why) {
  try { logger.error('dest', `destinations.json 里的条目已忽略（${why}）: ${JSON.stringify(d)}`) } catch { /* logger 自身失败不阻断加载 */ }
}

function save(cfg) {
  // 临时文件 + rename：写一半被杀不会留下半截 JSON（与批次标记同思路，但这里目录必然可写）
  const tmp = FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8')
  fs.renameSync(tmp, FILE)
  // 写完直接记下当前 mtime：同毫秒内 mtime 可能不变，复用旧缓存会让本次写入"看不见"
  try { cache = { mtimeMs: fs.statSync(FILE).mtimeMs, cfg } } catch { cache = { mtimeMs: -1, cfg } }
}

const sameLocalPath = (a, b) => {
  // Windows 路径大小写不敏感：C:\Music 与 c:\music 是同一个目录，不得重复入列
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/** 目录可写探针：accessSync 在 Windows 目录上不可靠（目录常恒真），用真写+删验证 */
function assertLocalWritable(p) {
  const probe = path.join(p, '.ncm-dest-probe')
  fs.writeFileSync(probe, 'ok')
  fs.unlinkSync(probe)
}

/** 添加本地目录（校验存在且可写），并立即激活 */
function addLocal(p) {
  // 空串防线：path.resolve('') = 进程 cwd（项目根），不拦的话项目根会被当下载目的地
  const trimmed = String(p || '').trim()
  if (!trimmed) throw new Error('请提供有效的文件夹路径')
  const resolved = path.resolve(trimmed)
  if (resolved === path.parse(resolved).root) throw new Error('请选择具体的文件夹（不能是盘符根目录）')
  let st
  try { st = fs.statSync(resolved) } catch { throw new Error('目录不存在: ' + resolved) }
  if (!st.isDirectory()) throw new Error('不是文件夹: ' + resolved)
  assertLocalWritable(resolved)
  const cfg = load()
  const existed = cfg.list.find((d) => d.kind === 'local' && sameLocalPath(path.resolve(d.path), resolved))
  if (existed) {
    logger.log('dest', `切回已有下载位置「${existed.name}」（${existed.path}）`)
    return activate(cfg, existed)
  }
  const entry = { id: 'd' + cfg.next++, kind: 'local', name: path.basename(resolved) || resolved, path: resolved, addedAt: new Date().toISOString() }
  logger.log('dest', `新增本地下载位置「${entry.name}」（${entry.path}）并已激活`)
  return activate(cfg, entry, true)
}

/** 添加手机目录（校验 adb 就绪 + 目录可写全链路探测），并立即激活 */
function addPhone(p) {
  // 先失效再查状态：插上手机后立刻添加，5s 旧缓存里的 no-device 会误报"手机不可用"
  adbSvc.invalidate()
  const st = adbSvc.status()
  if (st.state !== 'ready') throw new Error('手机不可用：' + st.message)
  // 归一：掐头去尾斜杠 + 内部连续斜杠折叠（/sdcard//Music → /sdcard/Music），
  // 否则同一目录两种写法会入列两条、互不认领；
  // 再解掉 . 与 .. 段（/sdcard/Music/.. 与 /sdcard/./Music 必须收敛到同一串，
  // 否则它们入列成两个条目，而实际都落在 /sdcard，UI 显示的路径与真实落点对不上）
  let dir = String(p || '').trim().replace(/\/{2,}/g, '/')
  dir = '/' + path.posix.normalize(dir).replace(/^\/+|\/+$/g, '')
  if (!dir || dir === '/') throw new Error('请提供设备内的文件夹路径（如 /sdcard/Music）')
  // 控制字符一律拒绝（不"转义"而是拒绝）：NUL 会让 Windows argv 在子进程里被截断，
  // 于是 mkdir -p "…/Music\0/../x" 实际作用在 /sdcard/Music —— 探针"成功"了，
  // 存进配置的却是另一条路径，之后每首 find/md5sum/base64 都在同一位置被截断，
  // 歌落在 /sdcard/Music 而界面显示别的目录。src/core/adb.shq 的转义对此无能为力
  if (/[\u0000-\u001f\u007f]/.test(dir)) throw new Error('设备路径含非法控制字符')
  adbSvc.probeWritable(dir)
  const cfg = load()
  const existed = cfg.list.find((d) => d.kind === 'phone' && d.path === dir)
  if (existed) {
    logger.log('dest', `切回已有下载位置「${existed.name}」（手机 ${existed.path}）`)
    return activate(cfg, existed)
  }
  const entry = { id: 'd' + cfg.next++, kind: 'phone', name: path.posix.basename(dir) || dir, path: dir, addedAt: new Date().toISOString() }
  logger.log('dest', `新增手机下载位置「${entry.name}」（${entry.path}）并已激活`)
  return activate(cfg, entry, true)
}

/**
 * 激活并持久化（addLocal/addPhone 共用收尾）：先 save 成功再让新条目进入内存缓存——
 * 反过来（先 mutate 后 save）一旦落盘失败（目标盘只读等），cache 里会留下未持久化的幽灵条目
 */
function activate(cfg, entry, push = false) {
  const next = { ...cfg, list: push ? [...cfg.list, entry] : cfg.list, active: entry.id }
  save(next)
  return entry
}

function get(id) {
  return load().list.find((d) => d.id === id) || null
}

function list() {
  return load().list
}

function activeId() {
  return load().active
}

function setActive(id) {
  const cfg = load()
  if (id === null || id === undefined || id === '') {
    logger.log('dest', '切换下载位置 → 默认下载目录（downloads）')
    save({ ...cfg, active: null })
    return null
  }
  if (!cfg.list.some((d) => d.id === id)) throw new Error('下载位置不存在: ' + id)
  const d = cfg.list.find((x) => x.id === id)
  logger.log('dest', `切换下载位置 → 「${d.name}」（${d.kind === 'phone' ? '手机 ' : ''}${d.path}）`)
  save({ ...cfg, active: id })
  return id
}

function remove(id) {
  const cfg = load()
  const removed = cfg.list.find((d) => d.id === id)
  const before = cfg.list.length
  const list = cfg.list.filter((d) => d.id !== id)
  if (list.length === before) throw new Error('下载位置不存在: ' + id)
  if (removed) logger.log('dest', `删除下载位置「${removed.name}」（${removed.kind === 'phone' ? '手机 ' : ''}${removed.path}）`)
  save({ ...cfg, list, active: cfg.active === id ? null : cfg.active })
  return true
}

// 目的地失效回退告警去重：/api/status 每分钟都会调 resolve，同一目的地只告警一次，
// 恢复可访问时清零并补一条恢复日志（静默换目录 = 用户找不到歌还以为丢了）
let fallbackWarnedId = null

/**
 * 当前生效目的地：server 建任务时唯一入口
 * @param defaultBase 缺省下载根（server 的 DOWNLOAD_DIR，含环境变量口径）
 * @returns {kind:'default'|'local'|'phone', id, name, base}
 */
function resolve(defaultBase) {
  const d = get(load().active)
  if (!d) {
    fallbackWarnedId = null
    return { kind: 'default', id: null, name: '默认下载目录', base: defaultBase }
  }
  if (d.kind === 'local' && !fs.existsSync(d.path)) {
    // 目的地被拔盘/删除时如实回退缺省，不让建任务直接炸掉
    if (fallbackWarnedId !== d.id) {
      logger.error('dest', `下载位置「${d.name}」（${d.path}）现在不可访问（盘被拔/目录被删？），本次将下载到默认目录 downloads`)
      fallbackWarnedId = d.id
    }
    return { kind: 'default', id: null, name: '默认下载目录', base: defaultBase, fallbackFrom: d.id }
  }
  if (fallbackWarnedId === d.id) logger.log('dest', `下载位置「${d.name}」已恢复可访问`)
  fallbackWarnedId = null
  return { kind: d.kind, id: d.id, name: d.name, base: d.path }
}

// ---- 测试钩子：单测把配置文件指到临时目录，不碰真实 destinations.json ----
function _useFile(f) {
  FILE = f
  cache = null
}
function _reset() {
  FILE = path.join(__dirname, '..', '..', 'destinations.json')
  cache = null
}

module.exports = { addLocal, addPhone, get, list, activeId, setActive, remove, resolve, _useFile, _reset }
