/**
 * cookie 核心模块：加载 / 保存 / 状态查询
 * 来源优先级：NCM_COOKIE > MUSIC_U(环境变量) > cookie.txt 文件
 *
 * 文件读取带内存缓存 + mtime 失效：环境变量每次直读（无缓存，改即生效）；
 * 只有文件分支走缓存——命中时只做一次 stat 确认 mtime，不读文件内容；
 * 文件 mtime 变化 / save / clear 即失效，保证外部改 cookie.txt 立即可见。
 */
const fs = require('fs')
const path = require('path')

const DEFAULT_FILE = path.join(__dirname, '../../cookie.txt')
let FILE = DEFAULT_FILE

// 文件分支缓存：{ mtimeMs, value, initialized }，只缓存文件内容本身
let _fileCache = { mtimeMs: -1, value: '', initialized: false }

function _resetCache() {
  _fileCache = { mtimeMs: -1, value: '', initialized: false }
}

function readFileCached() {
  let mtimeMs
  try {
    // stat 一次搞定"存在 + mtime"：文件不存在抛 ENOENT，与旧 readRaw 语义一致走空串
    mtimeMs = fs.statSync(FILE).mtimeMs
  } catch {
    // stat 失败（如不存在、竞态删除）按无文件处理
    _resetCache()
    return ''
  }
  if (_fileCache.initialized && _fileCache.mtimeMs === mtimeMs) return _fileCache.value
  let v
  try {
    v = fs.readFileSync(FILE, 'utf8').trim()
  } catch (e) {
    // stat 与 read 之间的竞态删除只认 ENOENT（其余如 EACCES/EISDIR 照旧上抛，不吞错）
    if (!e || e.code !== 'ENOENT') throw e
    _resetCache()
    return ''
  }
  _fileCache = { mtimeMs, value: v, initialized: true }
  return v
}

function readRaw() {
  if (process.env.NCM_COOKIE) return process.env.NCM_COOKIE
  if (process.env.MUSIC_U) return `MUSIC_U=${process.env.MUSIC_U}`
  return readFileCached()
}

/**
 * 归一化：确保以 MUSIC_U= 键值对形式存在（裸值自动补键名；双前缀循环剥离；其他键值对形式原样透传）
 * 注意"其他键值对原样透传"这条分支不可省：真实的 cookie.txt 往往以 MUSIC_A_T= 等其它键开头，
 * 把它当裸值再包一层 MUSIC_U= 会产出网易根本不认的凭证。
 */
function normalize(raw) {
  const s = String(raw == null ? '' : raw).trim()
  if (!s) return ''
  let v
  if (/^MUSIC_U=/i.test(s)) {
    // 防手滑双前缀：注释声称过这件事，但原实现只是"剥掉第一个 MUSIC_U= 再补一个"，
    // 对 'MUSIC_U=MUSIC_U=x' 恰好又拼回原样，等于没防。循环剥到不再以此开头为止
    // （真实 cookie 只会以它开头一次，不会误伤）
    let rest = s
    while (/^MUSIC_U=/i.test(rest)) rest = rest.slice('MUSIC_U='.length)
    // 值还要 trim：环境变量里很容易留空格（"MUSIC_U= abc"），不去的话 has() 报已登录、
    // 实际每个请求都带着前导空格的凭证被网易拒掉——表现为"明明登录了却什么都下不了"，
    // 且没有任何报错可查
    v = `MUSIC_U=${rest.trim()}`
  } else if (s.includes('=')) {
    v = s
  } else {
    v = `MUSIC_U=${s}`
  }
  // "MUSIC_U="（键在值空）不是有效登录态：has() 会被空值骗成"已登录"，实际每个请求都裸奔
  const m = v.match(/MUSIC_U=([^;]*)/i)
  if (m && !m[1].trim()) return ''
  // 内部控制字符必须当空处理（决策 92）：trim 只去首尾，从编辑器粘贴的 cookie 很容易在两段之间
  // 留下换行（"MUSIC_U=abc<LF>X-Token: def"）。带 LF 的 Cookie 头会被 Node 直接抛
  // ERR_INVALID_CHAR，于是**每一个** /meting、/chart、/download 都 500，而 /api/login/status
  // 仍然报 cookie 有效（has() 只看非空）—— 用户同时看到"已登录"和"服务全挂"，毫无线索。
  // 判为未登录会立刻在登录框给出可行动的信息，比全站 500 加上一个绿色状态灯好得多
  if (/[\u0000-\u001f\u007f]/.test(v)) return ''
  return v
}

function get() {
  return normalize(readRaw())
}

function has() {
  return Boolean(get())
}

function save(cookieStr) {
  const v = normalize(cookieStr)
  // 临时文件 + rename：写一半被杀不会留下半截 cookie.txt 被静默当坏 cookie 用
  const tmp = FILE + '.tmp'
  fs.writeFileSync(tmp, v)
  try {
    fs.renameSync(tmp, FILE)
  } catch (e) {
    // rename 失败（Windows 下目标被占用等）清掉 .tmp 残留再上抛，别留垃圾
    try { fs.unlinkSync(tmp) } catch { /* 被占用则留着，下次 save 覆盖 */ }
    throw e
  }
  // 写后直接更新缓存：同毫秒内 mtime 可能不变，先刷新值避免读到旧内容；
  // stat 失败则失效缓存，下次读重新加载
  try {
    _fileCache = { mtimeMs: fs.statSync(FILE).mtimeMs, value: v.trim(), initialized: true }
  } catch {
    _resetCache()
  }
}

function clear() {
  if (fs.existsSync(FILE)) fs.unlinkSync(FILE)
  _resetCache()
}

// 测试注入用：把 cookie 文件指向临时路径。FILE 是模块加载时由 __dirname 定下的常量，
// 没有这个钩子就无法在不碰用户真实 cookie.txt 的前提下测 save/clear（写坏了就是账号掉登录）
function _useFile(p) {
  FILE = p || DEFAULT_FILE
  _resetCache()
}

module.exports = { get, has, save, clear, FILE: () => FILE, _useFile, _resetCache }
