const $ = (id) => document.getElementById(id)
const v = (id) => $(id).value.trim()

// ---- 在线试听（加载即播放；试听走网易临时地址，不产生下载） ----
let playMode = 'song'
let tracks = []
let curIdx = -1
let trackSeq = 0 // 加载请求序号：丢弃过期的加载结果
const audio = $('plAudio')

// 按当前试听模式切换输入控件：单曲/歌单用输入框，榜单用榜单下拉，每日推荐都不用
function syncPlayRow() {
  const isChart = playMode === 'chart'
  const needInput = playMode === 'song' || playMode === 'playlist'
  const inp = $('playInput')
  // 占位浮层已经把输入框包起来了：必须整层隐藏。只藏 input 的话，空浮层仍按 flex:1 吃掉半行宽度，
  // 榜单下拉会被挤到左边半格，右侧留一条空白
  const shell = inp.closest('.ph-wrap') || inp
  shell.style.display = needInput ? '' : 'none'
  const pick = $('playChartSel').closest('.nsel')
  if (pick) pick.style.display = isChart ? '' : 'none'
  if (playMode === 'playlist') setPlaceholder($('playInput'), 'https://music.163.com/playlist?id=… 或 歌单ID')
  else if (playMode === 'song') setPlaceholder($('playInput'), 'https://music.163.com/song?id=… 或 歌曲ID')
}

$('playTabs').addEventListener('click', (e) => {
  if (!e.target.dataset.m) return
  if (e.target.dataset.m === playMode) return // 点当前页签：不改状态，也不作废在途加载
  playMode = e.target.dataset.m
  trackSeq++ // 加载口径变了，在途的旧模式结果作废（否则歌单结果会落进榜单页签）
  document.querySelectorAll('#playTabs button').forEach((b) => {
    const on = b === e.target
    b.classList.toggle('on', on)
    b.setAttribute('aria-selected', String(on))
  })
  syncPlayRow()
})

async function loadTracks() {
  let url
  if (playMode === 'song') {
    if (!v('playInput')) return toast('请先填写歌曲 ID 或链接')
    url = `/meting?type=song&id=${encodeURIComponent(pid(v('playInput')))}`
  } else if (playMode === 'playlist') {
    if (!v('playInput')) return toast('请先填写歌单 ID 或链接')
    url = `/meting?type=playlist&id=${encodeURIComponent(pid(v('playInput')))}`
  } else if (playMode === 'chart') {
    const cid = $('playChartSel').value
    // 与下载卡同口径：下拉没就绪多半是加载失败，不能暗示"是你没选"
    if (!cid) return toast(chartsFailed ? '榜单加载失败，请点开榜单下拉重试' : '请先选择榜单')
    url = `/chart/${encodeURIComponent(cid)}`
  } else {
    url = '/recommend/daily'
  }
  const seq = ++trackSeq // 校验全过了才占号：空输入直接 return 不该作废在途的合法加载
  try {
    const list = await api(url)
    if (seq !== trackSeq) return // 已有更新的加载，丢弃
    if (!Array.isArray(list) || !list.length) throw new Error('没有取到歌曲')
    tracks = list
    curIdx = -1
    renderTracks()
    $('playerBox').style.display = ''
    playAt(0) // "加载"是用户手势，浏览器允许随即播放
  } catch (e) {
    if (seq === trackSeq) toast('加载失败：' + e.message)
  }
}

function renderTracks() {
  const box = $('plList')
  box.textContent = ''
  tracks.forEach((t, i) => {
    const row = document.createElement('div')
    row.className = 'track-item'
    row.dataset.i = String(i)
    const n = document.createElement('span'); n.className = 'tn'; n.textContent = String(i + 1)
    const tt = document.createElement('span'); tt.className = 'tt'; tt.textContent = t.name
    const ta = document.createElement('span'); ta.className = 'ta'; ta.textContent = t.artist
    row.append(n, tt, ta)
    row.addEventListener('click', () => playAt(i))
    box.appendChild(row)
  })
}

function markCurrent() {
  document.querySelectorAll('#plList .track-item').forEach((el) => {
    el.classList.toggle('on', Number(el.dataset.i) === curIdx)
  })
}

function playAt(i) {
  if (i < 0 || i >= tracks.length) return
  curIdx = i
  const t = tracks[i]
  $('plTitle').textContent = t.name || '未知歌曲'
  $('plArtist').textContent = t.artist || ''
  // 封面同样要剥成同源：meting 的 pic 是绝对 URL（供外部播放器用），而 SELF_BASE 缺省是
  // http://127.0.0.1:3000/meting。以 HOST=0.0.0.0 从手机/别的机器打开界面时，
  // 音频与歌词都剥了源（能播），唯独封面用绝对地址指向 127.0.0.1（指向手机自己）→ 整片封面裂图
  $('plCover').src = (t.pic || '').replace(/^https?:\/\/[^/]+/, '')
  // meting 地址是绝对 URL（供外部播放器用），这里剥成同源路径，换端口/局域网访问也能播
  const src = (t.url || '').replace(/^https?:\/\/[^/]+/, '')
  if (!src) {
    // 没取到播放地址就别动 audio.src：置成 '' 会触发 error 事件连锁切歌，把"这一首没地址"
    // 放大成"整张列表疯狂跳歌"。但必须暂停——否则上一首继续响，界面标题/歌词却已是这一首，
    // syncLyrics 还会拿上一首的播放进度去高亮这一首的歌词
    try { audio.pause() } catch { /* 尚未开始播放则无事 */ }
    toast(`「${t.name || '未知歌曲'}」暂无可播放地址`)
    markCurrent()
    loadLyrics(t)
    return
  }
  audio.src = src
  // 播放令牌：改 src 会让上一次未决的 play() 以 AbortError 拒绝，连点 5 首就是 5 条假"播放失败"
  const tok = ++playToken
  audio.play().catch((e) => {
    if (tok !== playToken) return // 已被更新的播放取代，不是失败
    if (e && e.name === 'NotAllowedError') toast('浏览器拦截了自动播放，点一下播放键即可')
    else if (e && e.name !== 'AbortError') toast('播放失败，点歌曲重试')
  })
  markCurrent()
  loadLyrics(t)
}

// ---- 歌词：解析 LRC，按播放进度高亮并自动滚动到当前行 ----
let lyricLines = []
let lyricIdx = -1
let lyricAutoCenter = true   // 用户滚动歌词时暂停自动居中，停止滚动 3 秒后恢复
let lyricScrollTimer = null
let autoScrollingLyrics = false
// 播放令牌：连点歌曲时，前一次 play() 的 Promise 会被 src 变更以 AbortError 拒绝，
// 不做令牌判别就会连珠炮似的弹"播放失败"（决策 84）
let playToken = 0
let lyricSeq = 0             // 请求序号：切歌时丢弃过期响应，避免旧歌词覆盖新歌词
const lyricBox = $('plLyrics')

function lyricScrollTo(top) {
  // scroll 事件是异步触发，rAF 复位太快会把程序滚动误判为手动；用 120ms 延时覆盖滚动事件
  autoScrollingLyrics = true
  lyricBox.scrollTop = top
  clearTimeout(lyricScrollTo._h)
  lyricScrollTo._h = setTimeout(() => { autoScrollingLyrics = false }, 120)
}

lyricBox.addEventListener('scroll', () => {
  if (autoScrollingLyrics) return // 程序设置的滚动，忽略
  lyricAutoCenter = false
  clearTimeout(lyricScrollTimer)
  lyricScrollTimer = setTimeout(() => {
    lyricAutoCenter = true
    centerCurrentLyric()
  }, 3000)
})

function parseLrc(text) {
  const out = []
  for (const raw of String(text).split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g)]
    if (!stamps.length) continue
    const content = raw.replace(/\[[^\]]*\]/g, '').trim()
    if (!content) continue
    for (const m of stamps) {
      const t = Number(m[1]) * 60 + Number(m[2]) + (m[3] ? Number('0.' + m[3]) : 0)
      out.push({ t, text: content })
    }
  }
  return out.sort((a, b) => a.t - b.t)
}

function setLyricPlaceholder(text) {
  lyricLines = [] // 占位时同时清空歌词状态，避免 DOM 与状态不一致（高亮/居中错位）
  lyricIdx = -1
  const box = $('plLyrics')
  box.textContent = ''
  const d = document.createElement('div')
  d.className = 'lyric-line placeholder'
  d.textContent = text
  box.appendChild(d)
}

async function loadLyrics(t) {
  const seq = ++lyricSeq // 请求序号，用于丢弃过期响应
  const box = $('plLyrics')
  box.style.display = 'block' // 面板固定高度常驻，切歌时不塌陷
  lyricAutoCenter = true      // 换歌重置：恢复自动居中
  clearTimeout(lyricScrollTimer)
  setLyricPlaceholder('歌词加载中…')
  lyricScrollTo(0)
  const path = (t.lrc || '').replace(/^https?:\/\/[^/]+/, '') // 剥成同源路径，换端口/局域网也能取
  if (!path) { setLyricPlaceholder('暂无歌词'); return }
  try {
    const resp = await fetch(path, { signal: AbortSignal.timeout(30000) })
    // 必须看状态码：404/500 的响应体是 HTML 或 JSON 错误，parseLrc 解析出 0 行，
    // 于是所有真实故障都显示成"暂无歌词"——用户以为歌本来就没词，不会去查服务
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const text = await resp.text()
    if (seq !== lyricSeq) return // 已被更新的歌曲取代，丢弃
    lyricLines = parseLrc(text)
    if (!lyricLines.length) { setLyricPlaceholder('暂无歌词'); return }
    box.textContent = ''
    lyricLines.forEach((l) => {
      const d = document.createElement('div')
      d.className = 'lyric-line'
      d.textContent = l.text
      box.appendChild(d)
    })
    syncLyrics(audio.currentTime)
  } catch (e) {
    // 区分"取失败"与"本来就没词"：前者多半是 cookie 过期或服务异常，值得一句提示
    if (seq === lyricSeq) setLyricPlaceholder(e && /^HTTP/.test(e.message) ? '歌词获取失败' : '暂无歌词')
  }
}

function centerCurrentLyric() {
  if (lyricIdx < 0) return
  const line = lyricBox.children[lyricIdx]
  if (line) lyricScrollTo(line.offsetTop - (lyricBox.clientHeight - line.offsetHeight) / 2)
}

function syncLyrics(cur) {
  if (!lyricLines.length) return
  let idx = -1
  for (let i = 0; i < lyricLines.length; i++) {
    if (lyricLines[i].t <= cur + 0.15) idx = i
    else break
  }
  if (idx === lyricIdx) return
  lyricIdx = idx
  const lines = lyricBox.children
  for (let i = 0; i < lines.length; i++) lines[i].classList.toggle('on', i === idx)
  if (lyricAutoCenter) centerCurrentLyric() // 用户正在翻阅时不打断，仅高亮
}

const fmtTime = (s) => (isFinite(s) && s >= 0
  ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
  : '0:00')

/**
 * 数值夹紧成有限非负数（决策 83）。**必须放在模块作用域**：原先它定义在
 * refreshJobs 的 job.result 分支里，而"进行中"分支与进度条宽度都看不到它，
 * 于是 processed 为 NaN 时进度条宽度被写成 "NaN%"（CSSOM 静默拒绝）、
 * 摘要打出 "进行中 NaN/1 · 当前: undefined (NaN/NaN MB)"
 */
const nz = (v) => (typeof v === 'number' && isFinite(v) && v > 0 ? v : 0)

function playToggle() {
  if (audio.paused) {
    const tok = ++playToken
    audio.play().catch((e) => {
      if (tok !== playToken) return // 已被更新的播放取代，不是失败
      // NotAllowedError = 浏览器拦截自动播放（不是歌坏了）：加载大歌单超过用户手势有效期后
      // 必然发生，此前一律报"播放失败"让用户以为歌有问题
      if (e && e.name === 'NotAllowedError') toast('浏览器拦截了自动播放，点一下播放键即可')
      else if (e && e.name !== 'AbortError') toast('播放失败，点歌曲重试')
    })
  } else audio.pause()
}
function playNext() { playAt(curIdx + 1 >= tracks.length ? 0 : curIdx + 1) }
function playPrev() { playAt(curIdx - 1 < 0 ? tracks.length - 1 : curIdx - 1) }

audio.addEventListener('play', () => { $('plToggle').textContent = '⏸' })
audio.addEventListener('pause', () => { $('plToggle').textContent = '▶' })
audio.addEventListener('ended', () => { if (curIdx + 1 < tracks.length) playAt(curIdx + 1) })
audio.addEventListener('timeupdate', () => {
  $('plCur').textContent = fmtTime(audio.currentTime)
  $('plDur').textContent = fmtTime(audio.duration)
  if (audio.duration) $('plSeek').value = String(Math.floor((audio.currentTime / audio.duration) * 1000))
  syncLyrics(audio.currentTime)
})
audio.addEventListener('error', () => {
  if (!audio.src) return
  toast('播放失败（临时地址可能过期，已自动切下一首）')
  // 与 ended 同口径：停在末尾不循环，避免全坏歌单无限循环刷 toast
  if (curIdx + 1 < tracks.length) playAt(curIdx + 1)
})
$('plSeek').addEventListener('input', () => {
  if (audio.duration) audio.currentTime = ($('plSeek').value / 1000) * audio.duration
})

// ---- 音量控制（滑块 + 静音开关；audio 元素跨曲目保留音量） ----
let lastVol = 1
function updateVolUI() {
  const eff = audio.muted ? 0 : audio.volume
  $('plVol').value = String(Math.round(eff * 100))
  $('plMute').classList.toggle('muted', eff === 0)
  $('plMute').setAttribute('aria-label', eff === 0 ? '取消静音' : '静音')
}
$('plVol').addEventListener('input', () => {
  const val = Number($('plVol').value) / 100
  audio.volume = val
  audio.muted = false
  if (val > 0) lastVol = val
  updateVolUI()
})
function toggleMute() {
  if (audio.muted || audio.volume === 0) {
    audio.muted = false
    audio.volume = lastVol > 0 ? lastVol : 0.6
  } else {
    lastVol = audio.volume
    audio.muted = true
  }
  updateVolUI()
}
updateVolUI()

function toast(msg) {
  const t = $('toast')
  t.textContent = msg; t.style.display = 'block'
  clearTimeout(t._h); t._h = setTimeout(() => t.style.display = 'none', 2600)
}

// 从链接里抠 ID：music.163.com/playlist?id=xxx / song?id=xxx 或纯数字
function pid(s) {
  const m = String(s).match(/[?&]id=(\d+)/) || String(s).match(/^(\d+)$/)
  return m ? m[1] : s
}

// 所有 fetch 必须带超时（决策 85）：请求一旦建立而服务端不回应，Promise 永不 settle。
// 后果最严重的是 refreshJobs —— 它在整个请求期间持有 jobsBusy=true，于是此后每一次轮询
// 都在第一行 return，任务面板永久停止更新（进度条、取消按钮、日志全冻结），
// 而且既不报错也不提示，只有刷新页面能恢复。服务端一次同步 adb 调用（spawnSync 最长 20s）
// 或一次网络盘扫盘就能触发
const FETCH_TIMEOUT = 30000
const withTimeout = () => AbortSignal.timeout(FETCH_TIMEOUT)

async function api(path) {
  const r = await fetch(path, { signal: withTimeout() })
  let j = null
  try { j = await r.json() } catch { /* 非 JSON：可能是错误页 HTML */ }
  if (!r.ok) throw new Error((j && j.error) || r.statusText || `HTTP ${r.status}`)
  // 2xx 但不是 JSON 必须报错，不能把占位对象当数据返回：
  // 原实现 .catch(() => ({error:'响应异常'})) 在这里返回了"看似成功的假数据"，
  // 调用方拿到 undefined 长度后 for...of 直接抛 TypeError，
  // 而 refreshJobs 的异常会逃出 setInterval 回调 —— 任务面板就此永久停止更新（无提示）
  if (j === null || typeof j !== 'object') throw new Error('服务响应异常（非 JSON）')
  return j
}

// POST JSON 的统一入口（与 api 同一套错误口径）：此前 downloadJob/startSongQueue/setDest/pickFolder/
// addPhoneDest 各写一份 fetch+json+报错，文案与容错已经漂移（有的漏"服务响应异常"兜底）
async function apiPost(path, body) {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: withTimeout(),
  })
  let j = null
  try { j = await r.json() } catch { /* 非 JSON：可能是错误页 HTML */ }
  if (!r.ok) throw new Error((j && j.error) || r.statusText || `HTTP ${r.status}`)
  if (j === null || typeof j !== 'object') throw new Error('服务响应异常（非 JSON）')
  return j
}

// 提交期按钮防重入的统一包装：禁用 → 执行 → 完成后 800ms 复原（留出 toast 反馈时间）。
// 各提交按钮此前复制了同一段 disabled/finally，漏一处就是双击重复任务
async function withButton(btn, fn) {
  if (btn) btn.disabled = true
  try {
    return await fn()
  } finally { if (btn) setTimeout(() => { btn.disabled = false }, 800) }
}

// ---- 过长的占位提示自动滚动：自建浮层替代原生 placeholder，溢出时才滚动 ----
// 浮层只在输入框为空时显示；一旦用户输入内容就隐藏，输入文字保持原生行为，不受滚动影响
function measureTextWidth(text, el) {
  const cs = getComputedStyle(el)
  const cv = measureTextWidth._cv || (measureTextWidth._cv = document.createElement('canvas'))
  const ctx = cv.getContext('2d')
  ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
  return ctx.measureText(text).width
}

const phRecords = new Map()

function setupScrollingPlaceholder(input) {
  if (phRecords.has(input) || !input.placeholder) return
  const wrap = document.createElement('span')
  wrap.className = 'ph-wrap'
  input.parentNode.insertBefore(wrap, input)
  wrap.appendChild(input)
  const ph = document.createElement('span')
  ph.className = 'ph-marquee'
  ph.setAttribute('aria-hidden', 'true')
  const inner = document.createElement('span')
  inner.textContent = input.placeholder
  ph.appendChild(inner)
  wrap.appendChild(ph)
  input.setAttribute('aria-label', input.placeholder) // 浮层替代原生 placeholder 后补可访问名
  input.placeholder = '' // 用浮层替代原生 placeholder，避免两处重复显示

  const sync = () => {
    if (input.getClientRects().length === 0) { ph.style.display = 'none'; return } // 输入框被隐藏（如切到每日推荐）
    if (!inner.textContent || input.value !== '') { ph.style.display = 'none'; return }
    ph.style.display = ''
    const avail = input.clientWidth - 28 // 左右各 14px 内边距
    if (avail <= 0) { ph.classList.remove('run'); return }
    const tw = measureTextWidth(inner.textContent, input)
    if (tw > avail) {
      const shift = Math.ceil(tw - avail + 24)
      ph.style.setProperty('--ph-shift', shift + 'px')
      ph.style.setProperty('--ph-dur', Math.min(16, Math.max(6, shift / 16)).toFixed(1) + 's')
      ph.classList.add('run')
    } else {
      ph.classList.remove('run')
    }
  }

  phRecords.set(input, { inner, sync })
  input.addEventListener('input', sync)
  if (window.ResizeObserver) new ResizeObserver(sync).observe(input)
  else window.addEventListener('resize', sync)
  sync()
}

function setPlaceholder(input, text) {
  const rec = phRecords.get(input)
  if (rec) { rec.inner.textContent = text; input.setAttribute('aria-label', text); rec.sync() }
  else input.placeholder = text
}

document.querySelectorAll('.row input[placeholder]:not([type=number])').forEach(setupScrollingPlaceholder)

// ---- 自定义下拉：把原生 <select> 换成同风格组件（原生 select 隐藏但保留 .value，兼容既有取值代码）----
function enhanceSelect(select) {
  const box = document.createElement('span')
  box.className = 'nsel'
  select.parentNode.insertBefore(box, select)
  box.appendChild(select)

  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'nsel-btn'
  btn.setAttribute('aria-haspopup', 'listbox')
  btn.setAttribute('aria-expanded', 'false')
  const label = document.createElement('span')
  label.className = 'nsel-label'
  btn.appendChild(label)
  btn.insertAdjacentHTML('beforeend',
    '<svg class="caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>')
  box.appendChild(btn)

  const menu = document.createElement('div')
  menu.className = 'nsel-menu'
  menu.setAttribute('role', 'listbox')
  box.appendChild(menu)

  const close = () => { box.classList.remove('open'); btn.setAttribute('aria-expanded', 'false') }
  const open = () => {
    // 同时只允许一个下拉展开
    document.querySelectorAll('.nsel.open').forEach((n) => { if (n !== box) n.classList.remove('open') })
    box.classList.add('open')
    btn.setAttribute('aria-expanded', 'true')
  }
  const choose = (i) => {
    const o = select.options[i]
    if (!o) return
    select.selectedIndex = i
    select.value = o.value
    select.dispatchEvent(new Event('change', { bubbles: true }))
    close()
    render()
  }

  const render = () => {
    const cur = select.options[select.selectedIndex]
    label.textContent = cur ? cur.textContent : ''
    btn.disabled = select.disabled
    menu.textContent = ''
    Array.from(select.options).forEach((o, i) => {
      const it = document.createElement('div')
      it.className = 'nsel-opt' + (i === select.selectedIndex ? ' on' : '')
      it.setAttribute('role', 'option')
      it.setAttribute('aria-selected', String(i === select.selectedIndex))
      it.textContent = o.textContent
      it.addEventListener('click', () => { if (!select.disabled) choose(i) })
      menu.appendChild(it)
    })
  }

  btn.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    if (select.disabled) return
    box.classList.contains('open') ? close() : open()
  })
  // select 被 <label> 包着时（音质下拉），点 label 文字只会按原生语义往隐藏的 select 上派发一次
  // click，自绘下拉不会开 —— 把文字点击转发成按钮点击。e.target === lab 才转，避免递归（btn 自带 stopPropagation）
  const lab = select.closest('label')
  // 必须 stopPropagation：lab 自己的 click 事件在转发后仍会冒泡到 document 的关闭器，
  // 而 lab 不在 box 内（box 是 lab 的后代）→ 关闭器立即 close()，净效果=打开后被关掉。
  // 互斥（open() 关其它下拉）由 btn.click() 内部保证，不依赖冒泡
  if (lab) lab.addEventListener('click', (e) => { if (e.target === lab) { e.stopPropagation(); btn.click() } })
  // 键盘：上下键**浏览**（只移动高亮），Enter/Space 才提交（决策 87）
  // 原实现每按一次方向键就 choose(i) —— 即立刻改 select.value 并派发 change，
  // 于是"按一下方向键看看有哪些选项"这个纯浏览动作会**永久且全局地切换下载位置**
  // （目的地是全局开关，写进 destinations.json，此后每个任务都受影响）。
  // 连按 5 次还会并发 5 个 POST，服务端 last-write-wins，最终生效哪一项不确定
  let hl = -1 // 高亮下标；-1 = 未开始浏览（跟随当前选中项）
  const paintHighlight = () => {
    const cur = select.options[hl >= 0 ? hl : select.selectedIndex]
    label.textContent = cur ? cur.textContent : ''
    Array.from(menu.children).forEach((n, i) => {
      const on = i === (hl >= 0 ? hl : select.selectedIndex)
      n.className = 'nsel-opt' + (on ? ' on' : '')
      n.setAttribute('aria-selected', String(on))
    })
  }
  btn.addEventListener('keydown', (e) => {
    if (select.disabled || select.options.length === 0) return
    const last = select.options.length - 1
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!box.classList.contains('open')) { open(); hl = -1; paintHighlight(); return }
      if (hl < 0) hl = select.selectedIndex
      hl = e.key === 'ArrowDown' ? Math.min(hl + 1, last) : Math.max(hl - 1, 0)
      paintHighlight() // 只移动高亮，不改 value、不派发 change
    } else if (e.key === 'Enter' || e.key === ' ') {
      if (!box.classList.contains('open')) return // 未展开时交给按钮的原生 click
      e.preventDefault()
      if (hl >= 0 && hl !== select.selectedIndex) choose(hl)
      else close()
      hl = -1
    } else if (e.key === 'Escape') {
      if (box.classList.contains('open')) { close(); hl = -1; render() }
    }
    btn.focus()
  })
  document.addEventListener('click', (e) => { if (!box.contains(e.target)) close() })
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close() })
  new MutationObserver(render).observe(select, { childList: true, subtree: true, attributes: true })
  render()
}

document.querySelectorAll('select').forEach(enhanceSelect)

async function downloadJob(btn, source, params) {
  // 空输入前置校验，不往服务端发无效请求
  if (params.id !== undefined && !params.id) {
    // 榜单卡没有输入框，空 id 只可能是下拉没就绪（多为加载失败），不能提示"填写 ID 或链接"
    if (source === 'chart') return toast(chartsFailed ? '榜单加载失败，请点开榜单下拉重试' : '请先选择榜单')
    return toast('请先填写 ID 或链接')
  }
  // 数量校验必须要求整数：服务端 createTask 认的是 Number.isInteger(lim) && lim >= 1，
  // 0.5 / 1.5 这类小数在前端原写法（Number(x) > 0）里放行，服务端却当"没传"→ **全量下载**。
  // 用户填了"0.5 首"拿到 500 首，且界面上毫无提示
  const badCount = (v) => {
    const n = Number(v)
    return !Number.isFinite(n) || n < 1 || !Number.isInteger(n)
  }
  if (params.limit !== undefined && badCount(params.limit)) return toast('请填写大于 0 的整数')
  if (params.total !== undefined && badCount(params.total)) return toast('请填写大于 0 的整数')
  await withButton(btn, async () => {
    try {
      // 封面不再由 UI 传：服务端默认内嵌封面（网页只保留"同时保存歌词"开关）
      // fillQuality：歌单增量时同基础名已有别的音质也照样补下目标音质（旧音质保留、已有歌词不重写）
      const j = await apiPost('/api/download', { source, ...params, br: $('quality').value, lyrics: $('optLrc').checked, fillQuality: $('optRefill').checked })
      // already=true 表示"并入了进行中的同批次任务，什么都没新开始"。此前一律播报
      // "任务已开始（500 首）"，用户会以为 500 首正在下、机器可以放着 overnight，
      // 实际上首都没开始下（决策 82）
      if (j.already) toast(`已并入进行中的任务 #${j.jobId}（${j.count} 首），不重复下载`)
      else toast(`任务已开始：${j.label}（${j.count} 首）`)
      refreshJobs()
    } catch (e) { syncAdbIfPhoneError(e); toast('失败：' + e.message) }
  })
}

// ---- 单曲批量排队：多链接 → 队列 → 一键按顺序下载（落盘到以启动时间命名的独立文件夹） ----
let songQueue = [] // [{ id, name }]

function parseLinks(text) {
  return String(text).split(/[\s,，]+/).map((s) => pid(s)).filter((x) => x && /^\d+$/.test(x))
}

function renderSongQueue() {
  const box = $('songQueue')
  box.textContent = ''
  songQueue.forEach((s, i) => {
    const row = document.createElement('div')
    row.className = 'track-item'
    const n = document.createElement('span'); n.className = 'tn'; n.textContent = String(i + 1)
    const tt = document.createElement('span'); tt.className = 'tt'; tt.textContent = s.name || `ID ${s.id}`
    const rm = document.createElement('button'); rm.className = 'qrm'; rm.type = 'button'; rm.textContent = '移除'
    rm.addEventListener('click', () => { songQueue.splice(i, 1); renderSongQueue() })
    row.append(n, tt, rm)
    box.appendChild(row)
  })
  $('queueCount').textContent = songQueue.length ? `队列中 ${songQueue.length} 首` : ''
}

async function enqueueSongs() {
  const ids = [...new Set(parseLinks(v('songLinks')))] // 同一批内也去重
  if (!ids.length) return toast('请先粘贴歌曲链接或 ID')
  const fresh = ids.filter((id) => !songQueue.some((s) => s.id === id))
  fresh.forEach((id) => songQueue.push({ id, name: '' }))
  $('songLinks').value = ''
  renderSongQueue()
  const dup = ids.length - fresh.length
  toast(fresh.length
    ? `已加入 ${fresh.length} 首${dup ? `（跳过 ${dup} 首重复）` : ''}`
    : `队列里已有这些歌曲，跳过 ${dup} 首`)
  if (fresh.length) resolveQueueNames()
}

/** 批量取歌名（一次请求，getDetail 支持逗号分隔），失败就只显示 ID */
async function resolveQueueNames() {
  const unknown = songQueue.filter((s) => !s.name)
  if (!unknown.length) return
  try {
    const list = await api(`/meting?type=song&id=${unknown.map((s) => s.id).join(',')}`)
    if (Array.isArray(list)) {
      // meting 项不含 id 字段，id 在 url 里（…&id=123），从这里抠回来做匹配
      list.forEach((t) => {
        const m = String(t.url || '').match(/[?&]id=(\d+)/)
        const it = m && songQueue.find((s) => s.id === m[1])
        if (it && t.name) it.name = t.name
      })
      renderSongQueue()
    }
  } catch { /* 取不到名字就显示 ID */ }
}

function clearSongQueue() {
  if (!songQueue.length) return
  songQueue = []
  renderSongQueue()
}

async function startSongQueue(btn) {
  if (!songQueue.length) return toast('队列为空，请先加入歌曲')
  const ids = songQueue.map((s) => s.id)
  await withButton(btn, async () => {
    try {
      const j = await apiPost('/api/download', { source: 'songs', ids, br: $('quality').value, lyrics: $('optLrc').checked })
      toast(`队列任务已开始：${j.count} 首 → ${j.folder}`)
      songQueue = []
      renderSongQueue()
      refreshJobs()
    } catch (e) { syncAdbIfPhoneError(e); toast('失败：' + e.message) }
  })
}

$('songLinks').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); enqueueSongs() }
})

const jobEls = new Map()
let pollFails = 0
// 轮询序号：定时器 / 切回前台 / 开任务 / 点取消会并发触发 refreshJobs。
// 注意比对基准是"已落地的最新响应"（jobsApplied）而不是"已发出的最新请求"（jobSeq）：
// 原实现只认 jobSeq，于是只要单次往返超过轮询间隔（1.5s），每一个响应都在下一发发出后到达、
// 全被判为过期丢弃——不抛错、不计失败、无任何提示，任务面板静默永久停止刷新。
// 这个阈值在手机管线里很容易达到：adb 走同步 spawnSync（USB 半死时单条命令可阻塞 20s），
// sweepDownloads 是整棵树的同步递归，大批次 /api/jobs 的载荷本身也很大
let jobSeq = 0
let jobsApplied = 0
let jobsBusy = false

// ---- 日志滚动：贴底跟随（聊天框惯例）----
// 只有用户本来就贴在底部时，新日志才把它滚到底；翻历史时保持原位，永远不会被拽走。
// 歌词面板是另一套"手动滚动暂停 3 秒后恢复居中"的策略，两者有意分叉，不要互相复用。

async function refreshJobs() {
  if (document.hidden) return // 切后台时跳过网络轮询，切回由 visibilitychange 补拉
  // 同一时刻只允许一个在途请求：服务端被 adb 阻塞时，每 1.5s 再叠一发只会让队列越来越长，
  // 恢复后要一次性处理十几份过期响应
  if (jobsBusy) return
  jobsBusy = true
  const seq = ++jobSeq
  let jobs
  try { jobs = await api('/api/jobs') } catch (e) {
    // 过期响应（期间已有更新的一轮落地）：不污染连续失败计数
    if (seq >= jobsApplied) {
      // 连续失败到第 3 次才提示；之后每 40 次（约 1 分钟）再提示一次，
      // 让"服务恢复"这类长时中断也有提示，而不会因为计数只增不减导致第二次故障永远静默
      if (++pollFails === 3) toast('服务无响应，任务状态可能不准确')
      else if (pollFails > 3 && pollFails % 40 === 0) toast('服务仍未恢复，请检查服务窗口是否还在运行')
      console.warn('刷新任务列表失败', e)
    }
    jobsBusy = false
    return
  } finally { if (seq === jobSeq) jobsBusy = false }
  // 只丢弃比已落地响应更旧的：同序号的失败路径已在此之前 return，不会走到这里
  if (seq < jobsApplied) return
  jobsApplied = seq
  jobsBusy = false
  if (!Array.isArray(jobs)) { toast('服务响应异常，任务列表未更新'); return }
  pollFails = 0
  const list = $('jobList')
  if (!jobs.length) {
    // 服务重启会清空任务：清掉旧卡片，恢复空态
    list.innerHTML = '<div class="empty">还没有任务</div>'
    jobEls.clear()
    return
  }
  if (list.querySelector('.empty')) list.innerHTML = ''
  const seen = new Set()
  for (const job of jobs) {
    // 逐条隔离（决策 86）：renderJobCards 的调用不在任何 try 里，一条形状异常的任务记录
    // 抛出的 TypeError 会逃出 setInterval 回调 —— 面板此后每 1.5s 在同一处崩一次，
    // 且既不计入 pollFails 也不弹提示（服务其实完全正常）。用户看到的是任务面板无声无息
    // 冻结在最后一帧，只有刷新页面才能恢复。宁可跳过这一条，也不能拖垮整批
    try {
      renderOneJobCard(job, seen, list)
    } catch (e) {
      console.warn('跳过异常的任务记录', job && job.id, e)
      if (job && job.id != null) seen.add(job.id) // 仍标记已见，否则末尾的清理会删掉别人的卡片
    }
  }
  finishJobCards(seen, jobs)
}

/** 单张任务卡片（从 refreshJobs 拆出，便于逐条 try/catch 隔离）；list 由调用方传入——
 *  拆函数时 list/jobs 仍是 refreshJobs 的局部变量，模块层没有同名声明，漏传就是 ReferenceError */
function renderOneJobCard(job, seen, list) {
  {
    seen.add(job.id)
    let el = jobEls.get(job.id)
    if (!el) {
      el = document.createElement('div')
      el.className = 'job'
      el.innerHTML = `<div class="head"><span class="pulse" style="display:none"></span>
        <span class="name"></span><span class="state"></span></div>
        <div class="dir"></div>
        <div class="track"><div class="fill"></div></div>
        <div class="sum"></div><div class="log"></div>`
      jobEls.set(job.id, el)
      list.appendChild(el)
    }
    el.querySelector('.name').textContent = job.label
    const dirEl = el.querySelector('.dir')
    const dirKey = (job.folder || '') + '|' + (job.destKind || 'default') + '|' + (job.destId || '')
    if (dirEl.dataset.f !== dirKey) {
      dirEl.dataset.f = dirKey
      dirEl.textContent = ''
      if (job.folder) {
        if (job.destKind === 'phone') {
          // 手机目的地没有电脑端可打开的路径：只展示目录名，不给打开按钮。
          // 独立类 dir-plain（复用 dir-link 观感但无指针/悬停下划线），不再借按钮类名 + 内联样式
          const s = document.createElement('span')
          s.className = 'dir-plain'
          s.textContent = '手机目录：' + job.folder
          dirEl.appendChild(s)
        } else {
          const a = document.createElement('button')
          a.className = 'dir-link'
          a.textContent = '打开文件夹：' + job.folder
          a.addEventListener('click', () => openFolder(job.folder, job.destId))
          dirEl.appendChild(a)
        }
      }
    }
    const state = el.querySelector('.state')
    state.textContent = { running: '进行中', queued: '排队中', done: '已完成', error: '出错', cancelled: '已取消' }[job.status] || '出错'
    state.className = 'state ' + job.status
    el.querySelector('.pulse').style.display = job.status === 'running' ? '' : 'none'
    let cancelBtn = el.querySelector('.cancel-btn')
    if ((job.status === 'queued' || job.status === 'running') && !cancelBtn) {
      cancelBtn = document.createElement('button')
      cancelBtn.className = 'cancel-btn'
      cancelBtn.textContent = '取消'
      cancelBtn.addEventListener('click', async () => {
        cancelBtn.disabled = true
        try {
          const r = await fetch('/api/job/' + job.id, { method: 'DELETE', signal: AbortSignal.timeout(30000) })
          const j = await r.json().catch(() => ({}))
          if (!r.ok) toast('取消失败：' + (j.error || r.status))
          refreshJobs()
        } catch (e) { toast('取消失败：' + e.message) }
        cancelBtn.disabled = false
      })
      el.querySelector('.head').appendChild(cancelBtn)
    }
    if (cancelBtn && job.status !== 'queued' && job.status !== 'running') cancelBtn.remove()
    // 进度分母 = 全部歌数；分子 = 服务端真实已处理计数（job.processed：跳过/完成/失败/补词都算处理完一首）。
    // 不能用日志行数——终态任务日志被服务端瘦身截到末 100 行，600 首的任务完成后进度条会永远停在 ~16%
    // 全部数值必须夹紧：CSSOM 对非法 width（"NaN%" / "-5.0%"）是**静默拒绝**——赋值成为空操作，
    // 进度条冻结在上一个值上，既不报错也没有任何提示，用户只看到进度条不动（决策 83）
    const done = nz(job.processed) || nz(Array.isArray(job.log) ? job.log.length : 0)
    const total = nz(job.total) > 0 ? nz(job.total) : (done > 0 ? done : 1)
    // 进度 = 已完成首数 + 当前文件的字节进度
    const cur = job.current
    const fileFrac = (cur && nz(cur.total) > 0) ? Math.max(0, Math.min(1, nz(cur.received) / nz(cur.total))) : 0
    el.querySelector('.fill').style.width = Math.max(0, Math.min(100, (done + fileFrac) / total * 100)).toFixed(1) + '%'
    if (job.result) {
      // 每个字段都取默认值而不是裸访问：这是界面上最热的一行代码，一条形状异常的任务记录
      // 就会抛 TypeError，而异常会逃出 setInterval 回调 —— 进度条、取消按钮、日志、
      // 卡片重排、以及末尾的旧卡片清理全部停摆，整个面板直到刷新页面才恢复
      const r = job.result
      const num = nz
      // 分桶口径与服务端完成日志/批次报告一致：非零桶才出现，各桶之和 = 总数
      const parts = [`下载 ${num(r.ok)}`]
      if (r.existed) parts.push(`同音质已存在 ${num(r.existed)}`)
      if (r.filled) parts.push(`补歌词 ${num(r.filled)}`)
      if (r.noLyric) parts.push(`暂无歌词 ${num(r.noLyric)}`)
      if (r.skipped) parts.push(`跳过 ${num(r.skipped)}`)
      parts.push(`失败 ${Array.isArray(r.failed) ? r.failed.length : 0}`)
      el.querySelector('.sum').textContent = `共 ${num(r.total)} 首：${parts.join('，')}`
    } else if (job.status === 'cancelled') {
      el.querySelector('.sum').textContent = '已取消'
    } else if (job.error) {
      el.querySelector('.sum').textContent = job.error
    } else if (job.status === 'queued') {
      el.querySelector('.sum').textContent = '排队中：等待前面的任务完成'
    } else {
      // total 为 0（分块传输拿不到 content-length）时 MB 数是 0/0，只报歌名不报字节
      // name/received/total 都要兜底：缺一个就是 "当前: undefined (NaN/NaN MB)" 给用户看（决策 83）
      const curText = cur
        ? ` · 当前: ${cur.name || '未知歌曲'}${nz(cur.total) > 0 ? ` (${(nz(cur.received) / 1048576).toFixed(1)}/${(nz(cur.total) / 1048576).toFixed(1)} MB)` : ''}`
        : ''
      el.querySelector('.sum').textContent = `进行中 ${done}/${total}${curText}`
    }
    const log = el.querySelector('.log')
    // log 未必是数组（服务端形状漂移会给出字符串/null）：lines.forEach 抛错会掀掉整轮渲染
    const lines = Array.isArray(job.log) ? job.log : []
    if (log.dataset.n !== String(lines.length)) {
      log.dataset.n = String(lines.length)
      // 贴底判断必须在清空之前读：用当前内容算"用户视角是否贴底"（含上一轮刚追加的新行）
      const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 4
      const keep = log.scrollTop // 翻历史时的位置，重建后原样恢复（被浏览器钳位也无害）
      // 第三方歌曲名可能含 HTML 字符，必须 textContent 插入，不能用 innerHTML
      log.textContent = ''
      lines.forEach((raw) => {
        const l = String(raw) // 非字符串条目会让人为的 startsWith 抛错
        const d = document.createElement('div')
        if (l.startsWith('失败')) d.className = 'fail'
        else if (l.startsWith('跳过') || l.startsWith('已取消')) d.className = 'skip'
        else if (l.startsWith('补歌词')) d.className = 'fill-lrc'
        d.textContent = l
        log.appendChild(d)
      })
      // 贴底跟随：重建前贴着底部 → 继续跟最新一行；翻历史中 → 保持原位不拽走
      log.scrollTop = atBottom ? log.scrollHeight : keep
    }
  }
}

/** 卡片重排 + 清理本次没出现的旧卡片（拆出以便与逐条渲染的 try 隔离配套）；jobs 由调用方传入 */
function finishJobCards(seen, jobs) {
  const list = $('jobList')
  // 任务卡片按 API 顺序（最新在前）重排——只在顺序真的变化时才动 DOM：
  // append 会把节点 detach 再插回，.log 的滚动位置随之清零（跳回顶部），
  // 所以重排前后记账回填，用户滚动到哪就停在哪
  const desired = jobs.map((j) => jobEls.get(j.id)).filter(Boolean)
  const dom = Array.from(list.children)
  if (desired.length !== dom.length || desired.some((e, i) => e !== dom[i])) {
    const keeps = desired.map((e) => e.querySelector('.log').scrollTop)
    desired.forEach((e) => list.appendChild(e))
    desired.forEach((e, i) => { e.querySelector('.log').scrollTop = keeps[i] })
  }
  // 服务端已驱逐的任务，清掉对应卡片
  for (const [id, el] of jobEls) {
    if (!seen.has(id)) { el.remove(); jobEls.delete(id) }
  }
}

async function refreshStatus() {
  if (document.hidden) return // 后台不刷状态灯
  try {
    const s = await api('/api/status')
    $('dot').className = 'dot ' + (s.cookie === 'valid' ? 'ok' : 'bad')
    $('loginText').textContent = { valid: '已登录', expired: '登录已过期，请重新扫码', missing: '未登录（请扫码）' }[s.cookie] || '状态未知'
  } catch { $('dot').className = 'dot bad'; $('loginText').textContent = '服务未响应' }
}

let qrTimer = null
let qrCloseTimer = null // 登录成功后延迟关弹窗的定时器：新一轮登录必须一起清，否则它会关掉新弹窗
// /api/login/status 连续失败计数：与 /api/jobs 轮询同规则（抖 1 次继续，连丢 3 次才停）
let qrPollFails = 0
// 收拾上一轮登录留下的所有定时器：重复点"重新扫码"、手动关弹窗、成功收尾，三条路都走这里
function stopLoginTimers() {
  if (qrTimer) { clearInterval(qrTimer); qrTimer = null }
  if (qrCloseTimer) { clearTimeout(qrCloseTimer); qrCloseTimer = null }
}
async function startLogin() {
  stopLoginTimers() // 防止重复打开叠加多个轮询
  qrPollFails = 0 // 新一轮登录从零计
  try {
    await api('/api/login/start')
  } catch (e) {
    toast(e.message) // 启动失败：只提示错误，不打开二维码窗口（避免展示空/旧二维码）
    return
  }
  $('qrDialog').open || $('qrDialog').showModal()
  $('qrImg').src = '/api/login/qr?' + Date.now()
  $('qrStatus').textContent = '等待扫码…（用手机网易云音乐 App 扫描）'
  // 入口那次清理在 await 之前：连点两次"重新扫码"时，两次都在等 /api/login/start，
  // 谁都没装上轮询谁也清不到 —— 装自己的前再清一次，保证全局最多一个轮询
  stopLoginTimers()
  const myTimer = setInterval(async () => {
    // 回调里 await 会跨越"新一轮登录 / 关弹窗"，每一步都要确认自己仍是当前那轮，
    // 否则旧轮询会 clear 掉新轮询的 qrTimer（新弹窗从此不再刷新）
    if (qrTimer !== myTimer) return
    if (document.hidden) return // 后台只跳过本轮，不计失败也不停轮询
    try {
      const s = await api('/api/login/status')
      if (qrTimer !== myTimer) return
      qrPollFails = 0 // 通一轮就清零：只在连续失败时才停（对齐 refreshJobs 的 pollFails）
      $('qrStatus').textContent = { running: '等待扫码…（用手机网易云音乐 App 扫描）', waiting: '等待扫码…', scanned: '已扫码，请在手机上确认', ok: '登录成功！', error: '出错: ' + (s.error || '') }[s.status] || s.status
      // 生成中（running）时图片可能还没落盘：那一次 GET /api/login/qr 会 404，
      // 而这里原来只在启动时设一次 src、没有 onerror 也没有重试 —— 弹窗就此显示一张裂图，
      // 用户只能手动重来。每轮补一次 src：服务端是整轮结束后才删文件，重试只会拿到图或又 404
      if (s.status === 'running') $('qrImg').src = '/api/login/qr?' + Date.now()
      if (s.status === 'ok' || s.status === 'error') {
        clearInterval(myTimer); qrTimer = null
        if (s.status === 'ok') qrCloseTimer = setTimeout(() => { $('qrDialog').close(); refreshStatus(); toast('登录成功') }, 800)
      }
    } catch {
      // 单次抖动不中断：服务端 pollQr 独立在跑，用户此刻扫码可能已经成功；
      // 连续 3 次失败才停止轮询，且必须写进弹窗里（模态弹窗挡住整页，页面别处的 toast 看不见）
      if (qrTimer !== myTimer) return
      if (++qrPollFails === 3) {
        clearInterval(myTimer); qrTimer = null
        $('qrStatus').textContent = '轮询已停止：服务无响应，可关闭弹窗后重试'
      }
    }
  }, 1500)
  qrTimer = myTimer
}
$('qrDialog').addEventListener('close', stopLoginTimers)

function openFolder(name, destId) {
  const q = name ? '?name=' + encodeURIComponent(name) : ''
  // 节流命中服务端也如实回 throttled（此前只看 ok:false，节流被当成功吞掉，用户以为打开了）
  api('/api/open-folder' + q + (destId ? (q ? '&' : '?') + 'dest=' + encodeURIComponent(destId) : ''))
    .then((r) => { if (r && r.throttled) toast('打开太频繁，请稍候 3 秒再试') })
    .catch((e) => toast(e.message))
}

// ---- 下载位置（目的地）：全局开关，切换后所有下载落到所选文件夹（本地/手机） ----
let activeDestId = '' // 当前激活目的地（null=默认 downloads）：头部"打开下载目录"按钮据此路由
let destList = []     // 最近一次 /api/dest 的目的地清单：头部按钮据此判断激活项是不是手机目录

// 头部"打开下载目录"按钮跟随激活目的地：手机目录电脑端打不开（服务端会 400），直接禁用并改文案，
// 不让用户点了才吃一句报错；activeDestId 指向已删除的目的地时也走默认分支（服务端 resolve 自愈回默认）
function syncOpenDestBtn() {
  const btn = $('openDestBtn')
  if (!btn) return
  const act = destList.find((x) => x.id === activeDestId)
  if (act && act.kind === 'phone') {
    btn.disabled = true
    btn.textContent = '手机目录（电脑端不可打开）'
  } else {
    btn.disabled = false
    btn.textContent = '打开下载目录'
  }
}

async function loadDests() {
  try {
    const d = await api('/api/dest')
    const sel = $('destSel')
    const active = d.active || ''
    activeDestId = active
    destList = d.list || []
    sel.textContent = ''
    const def = document.createElement('option')
    def.value = ''
    def.textContent = '默认（项目 downloads）'
    sel.appendChild(def)
    destList.forEach((x) => {
      const o = document.createElement('option')
      o.value = x.id
      o.textContent = (x.kind === 'phone' ? '手机 · ' : '') + x.name
      sel.appendChild(o)
    })
    sel.value = active
    if (sel.value !== active) {
      // 激活项已被删除/不存在时回默认，本地状态同步归位（否则 openFolder 还会带着死 id 去请求）
      sel.value = ''
      activeDestId = ''
    }
    syncOpenDestBtn()
  } catch { /* 状态灯已提示服务未响应，这里静默 */ }
}

// 切换即落库（全局生效），失败回读重渲。请求期间禁用下拉：连续切换会产生并发 POST，
// 后发的先到时下拉显示与实际激活项颠倒，直到下一次 loadDests 才自愈
async function setDest(v) {
  const sel = $('destSel')
  sel.disabled = true
  try {
    await apiPost('/api/dest/active', { id: v || null })
    activeDestId = v || ''
    syncOpenDestBtn()
    toast(v ? '下载位置已切换' : '已切回默认下载目录')
  } catch (e) {
    toast('切换失败：' + e.message)
    loadDests()
  } finally { sel.disabled = false }
}

// 原生文件夹选择对话框（服务端弹 PowerShell FolderBrowserDialog），选完即添加并激活
async function pickFolder(btn) {
  await withButton(btn, async () => {
    try {
      const j = await apiPost('/api/dest', { action: 'pick' })
      toast('下载位置已切换：' + j.dest.name)
      await loadDests()
    } catch (e) {
      toast(e.message === '已取消选择' ? '已取消选择' : '失败：' + e.message)
    }
  })
}

// 添加手机文件夹：先看 ADB 基础可用性（未装/未连接/未授权都不盲试），再探测目录可写
async function addPhoneDest(btn) {
  await withButton(btn, async () => {
    try {
      const st = await api('/api/adb')
      if (st.state !== 'ready') { refreshAdb(); toast('手机不可用：' + st.message); return }
      // trim：带尾随空格/换行的路径在 adb 侧 mkdir 会建出带空格的目录，与下次输入的净路径对不上
      const p = (prompt('手机上的目标文件夹（设备内路径）', '/sdcard/Music') || '').trim()
      if (!p) return
      const j = await apiPost('/api/dest', { action: 'addPhone', path: p })
      toast('下载位置已切换：手机 · ' + j.dest.name)
      await loadDests()
      refreshAdb()
    } catch (e) { toast('失败：' + e.message) }
  })
}

// ADB 状态灯：四态文案（就绪/未授权/无设备/未安装），检测失败同样红灯
async function refreshAdb() {
  if (document.hidden) return
  try {
    const s = await api('/api/adb')
    const map = {
      ready: ['ok', 'ADB 就绪' + (s.device && s.device.model ? `（${s.device.model}）` : '')],
      unauthorized: ['bad', 'ADB 未授权：在手机上允许 USB 调试'],
      'no-device': ['bad', 'ADB 未检测到设备（手机端 USB 用途选「管理文件」）'],
      'no-adb': ['bad', '未检测到 ADB（手机直写不可用）'],
      error: ['bad', 'ADB 检测失败'],
    }
    const [cls, text] = map[s.state] || ['bad', 'ADB 状态未知']
    $('adbDot').className = 'dot ' + cls
    $('adbText').textContent = text
  } catch { $('adbDot').className = 'dot bad'; $('adbText').textContent = 'ADB 检测失败' }
}

// 手机相关报错（建任务 400 / 断连中止）说明灯上的状态已经过时——立刻重探把灯翻过来，
// 别让用户看着"就绪"绿灯却一直报"手机不可用"
function syncAdbIfPhoneError(e) {
  if (e && /手机不可用|手机已断开/.test(e.message || '')) refreshAdb()
}

// 填充榜单下拉（下载卡 + 在线试听卡共用）；榜单名是第三方数据，用 DOM API 插入避免注入
function fillChartSelect(sel, charts) {
  sel.textContent = ''
  charts.forEach((c) => {
    const opt = document.createElement('option')
    opt.value = c.id
    opt.textContent = c.name
    sel.appendChild(opt)
  })
  sel.disabled = false
}

let chartsFailed = false // 最近一次榜单加载是否失败：只用来给排行榜下载按钮一句不误导的提示

async function loadCharts() {
  const sels = [$('chartSel'), $('playChartSel')]
  try {
    const charts = await api('/api/charts')
    chartsFailed = false
    sels.forEach((s) => fillChartSelect(s, charts))
  } catch {
    chartsFailed = true
    sels.forEach((s) => {
      s.textContent = ''
      const opt = document.createElement('option')
      opt.value = '' // 置空，避免把"榜单加载失败"当成合法 id 提交
      opt.textContent = '榜单加载失败，点击重试'
      s.appendChild(opt)
      s.disabled = false // 保持可点：这个占位项就是重试入口（value 恒为空，提交时仍被空值校验拦住）
    })
  }
}

// 失败态恢复入口。选型说明（读过 enhanceSelect 才定的）：
// - 失败态下失败占位项本身就是当前选中项，用户再点它值不变——原生 select 语义下不产生 change，
//   不能再把恢复挂在"值变化"上；自绘组件虽然在 choose() 里无条件合成派发 change，但那依赖
//   用户必须先点开菜单再点唯一那条，且一旦走原生语义路径就断，不够稳。
// - 自绘下拉按钮的 click 自带 stopPropagation（冒泡监听收不到），所以用捕获阶段委托到 .nsel 上：
//   点开下拉、点占位项都能触发重拉，且不依赖任何值变化。
// - chartsFailed 为 false（已恢复/从未失败）一律不触发；chartRetrying 挡住在途重复点击。
// - 只认"点开菜单"与"点中选项"两种点击：捕获阶段挂在整个 .nsel 上，而下拉按钮自身的 click
//   带 stopPropagation 但捕获阶段照样先到 —— 于是"点按钮收起菜单"也会触发重拉，
//   失败态下每开合一次就发一轮 /api/charts，且 loadCharts 会重置 select、选中项弹回首项
let chartRetrying = false // 榜单重拉在途：一次点击连点只发一个请求
function retryCharts() {
  if (!chartsFailed || chartRetrying) return
  chartRetrying = true
  loadCharts().finally(() => { chartRetrying = false })
}
;[$('chartSel'), $('playChartSel')].forEach((s) => {
  const box = s.closest('.nsel')
  if (!box) return
  box.addEventListener('click', (e) => {
    // 菜单已展开时的点击 = 在收起它，不重拉；未展开时的点击 = 想打开它，重拉
    if (box.classList.contains('open') && !e.target.closest('.nsel-menu')) return
    retryCharts()
  }, true)
})

// 回车提交：输入框在 .row 里按 Enter = 点击同行的提交按钮
document.querySelectorAll('.row input').forEach((i) => {
  i.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const btn = i.closest('.row').querySelector('button.primary')
      if (btn && !btn.disabled) btn.click()
    }
  })
})

renderSongQueue()
syncPlayRow()
refreshStatus()
refreshJobs()
refreshAdb()
loadDests()
loadCharts()
setInterval(refreshJobs, 1500)
// 状态灯定时复查：cookie 中途过期也能在 1 分钟内变红（服务端探测有 5 分钟缓存，不打爆接口）
setInterval(refreshStatus, 60000)
// ADB 灯 3s 复查：手机中途插拔/授权变化要及时翻灯（服务端就绪态有 5s 缓存挡着，
// 实际 adb 进程最多 5s 起一次，3s 轮询只是打缓存接口）——拔线后灯最迟 ~8s 变红
setInterval(refreshAdb, 3000)
// 下载位置下拉：切换即全局生效（服务端落 destinations.json，重启不丢）
$('destSel').addEventListener('change', () => setDest($('destSel').value))
// 切回前台立即补拉：任务、状态灯、ADB 灯之外，目的地也可能在后台被另一个页面/进程改动
// （如另一处用 login.js 登录、或用户在别处切了下载位置），一并重拉才能如实反映
document.addEventListener('visibilitychange', () => { if (!document.hidden) { refreshJobs(); refreshStatus(); refreshAdb(); loadDests() } })
