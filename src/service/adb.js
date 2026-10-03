/**
 * ADB 状态策略层：设备可用性判定 + 目标目录可写探测（基础操作验证）
 * 原子能力在 core/adb；本层只做"状态归一、缓存、探测"的策略编排
 */
const core = require('../core')
const logger = require('./logger')
const adb = core.adb

const PROBE_NAME = '.ncm-write-probe'
const CACHE_MS = 5 * 1000       // 就绪状态缓存：UI 灯与建任务入口共用，避免每次轮询都起 adb 进程
const CACHE_FAIL_MS = 1 * 1000  // 非就绪短缓存：插上手机后最多 1s 就能从"未连接"翻绿，
                                // 不然用户"插上→立刻点添加手机文件夹"会撞上 5s 旧态误报

let cache = { at: 0, result: null }

/**
 * 设备可用性（就绪缓存 5s / 非就绪缓存 1s）：
 *  - ready         就绪：adb 可用且至少一台设备处于授权（device）状态
 *  - unauthorized  有设备但未授权（需在手机上允许 USB 调试）
 *  - no-device     adb 可用但无设备连接（或全部 offline）
 *  - no-adb        未找到 adb 可执行文件
 *  - error         adb 存在但命令执行失败（驱动/服务异常等）
 */
function status() {
  if (cache.result && Date.now() - cache.at < (cache.result.state === 'ready' ? CACHE_MS : CACHE_FAIL_MS)) {
    return cache.result
  }
  const prev = cache.result
  const result = probe()
  // 状态翻转落日志（边缘触发，前端 3s 轮询也不会刷屏）："手机什么时候掉的、什么时候回来的"
  // 是排查"这批为什么只下了一半"的头号线索，此前只在 UI 灯上一闪而过、零持久痕迹
  if (prev && prev.state !== result.state) {
    if (result.state === 'ready') logger.log('adb', `手机已连接就绪${result.device && result.device.model ? `（${result.device.model}）` : ''}`)
    else logger.error('adb', `手机连接状态变化: ${prev.state} → ${result.state}（${result.message}）`)
  }
  cache = { at: Date.now(), result }
  return result
}

function probe() {
  try {
    const list = adb.devices()
    const ready = list.find((d) => d.state === 'device')
    if (ready) {
      return { state: 'ready', device: ready, message: ready.model ? `设备已连接（${ready.model}）` : '设备已连接' }
    }
    if (list.some((d) => d.state === 'unauthorized')) {
      return { state: 'unauthorized', device: null, message: '设备未授权：请在手机屏幕上允许「USB 调试」授权弹窗（没有弹窗时，把手机「USB 用途」改为"管理文件/传输文件"后重新插拔）' }
    }
    // 线插着却探不到设备，最常见原因是手机端 USB 用途停在"仅充电"——不提示用户永远不知道要去手机上选
    return { state: 'no-device', device: null, message: '未检测到 ADB 设备（手机已插 USB 线时：手机屏幕的「USB 用途」请选择"管理文件/传输文件"（仅充电不行），并确认已开启"USB 调试"）' }
  } catch (e) {
    if (e && (e.noAdb || e.code === 'ENOENT')) {
      return { state: 'no-adb', device: null, message: '未找到 adb（手机直写不可用）' }
    }
    return { state: 'error', device: null, message: 'adb 命令执行失败: ' + core.error.errMsg(e) }
  }
}

/** 失效缓存：addPhone / 用户主动刷新时立即重探 */
function invalidate() {
  cache = { at: 0, result: null }
}

/**
 * 可写探测（基础操作验证）：建目录 → 写探针文件（md5 校验）→ 读回 → 删除
 * 全链路走一遍手机目的地要用到的每一类操作，任一步失败即报"目标目录不可写"（裸 adb stderr
 * 对用户是语境断裂的文案）；探测结束顺手失效状态缓存——探测成功即设备已就绪
 */
function probeWritable(base) {
  const probePath = `${base.replace(/\/+$/, '')}/${PROBE_NAME}`
  try {
    adb.mkdirP(base)
    adb.pushBuffer(Buffer.from('ok'), probePath, { timeoutMs: 30 * 1000 })
    const back = adb.readText(probePath)
    if (back.trim() !== 'ok') throw new Error('探针文件读回内容不符')
    adb.rm(probePath)
  } catch (e) {
    try { adb.rm(probePath) } catch { /* 读不到就谈不上删 */ }
    throw new Error('目标目录不可写（' + core.error.errMsg(e) + '）')
  }
  invalidate()
  return { ok: true }
}

module.exports = { status, invalidate, probeWritable, PROBE_NAME }
