/**
 * 测试用 wx API 内存适配器（Issue 4）
 *
 * 目标：让依赖 wx 存储的纯逻辑（store / analytics）在没有微信运行时的情况下可测试。
 * 这里只实现单测所需的最小子集：同步 Storage 接口 + 可选 cloud 占位。
 * 真实小程序运行时仍由微信提供 wx，本 shim 仅在 `node --test` 下注入 global.wx。
 */

const mem = new Map()

function clone(v) {
  if (v === undefined) return ''
  try {
    return JSON.parse(JSON.stringify(v))
  } catch (e) {
    return v
  }
}

function getStorageSync(key) {
  return mem.has(key) ? clone(mem.get(key)) : ''
}

function setStorageSync(key, data) {
  mem.set(key, clone(data))
  return true
}

function setStorage(opts) {
  if (!opts || !opts.key) {
    if (opts && opts.fail) opts.fail(new Error('key required'))
    return
  }
  try {
    mem.set(opts.key, clone(opts.data))
    if (opts.success) opts.success({ data: clone(opts.data) })
  } catch (e) {
    if (opts.fail) opts.fail(e)
  }
}

function getStorage(opts) {
  if (!opts || !opts.key) {
    if (opts && opts.fail) opts.fail(new Error('key required'))
    return
  }
  if (mem.has(opts.key)) {
    if (opts.success) opts.success({ data: clone(mem.get(opts.key)) })
  } else if (opts.fail) {
    opts.fail(new Error('not found: ' + opts.key))
  }
}

function removeStorageSync(key) {
  mem.delete(key)
}

function clearStorage() {
  mem.clear()
}

/** 测试专用：直接塞入原始数据（用于迁移 / 隔离用例） */
function setRaw(key, obj) {
  mem.set(key, clone(obj))
}

global.wx = {
  getStorageSync,
  setStorageSync,
  setStorage,
  getStorage,
  removeStorageSync,
  // 导航栏标题设置：单测无 UI，设为无操作
  setNavigationBarTitle: () => {}
}

global.__wxStorage = {
  clearAll: clearStorage,
  setRaw
}

module.exports = { clearStorage, setRaw }
