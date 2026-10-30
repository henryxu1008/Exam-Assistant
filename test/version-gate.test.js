/**
 * 版本阻断（forceUpdate）守卫回归测试（PR #10 评审 4422339109 / 4425408864）
 *
 * 两条一起看才完整：
 *  - 阻断态必须持久化，并在入口拦截（只弹可关闭提示等于没拦）；
 *  - 但鉴权必须与入口限制解耦，否则解除阻断后会话再也不会初始化。
 */

require('./wx-shim.js')
const { test, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const root = path.resolve(__dirname, '..')

let app
let user
let verify

function clearModules() {
  // Windows 上 require.cache 的 key 用反斜杠，用 '/' 拼接做 startsWith 比较永远不成立，
  // 会导致模块无法清理、用例间共享实例（会话缓存 / waiters 泄漏）。统一用 path 处理。
  const utilsDir = path.join(root, 'utils')
  const pagesDir = path.join(root, 'pages')
  const appPath = path.join(root, 'app.js')
  Object.keys(require.cache).forEach((key) => {
    const normalized = path.normalize(key)
    if (normalized.startsWith(utilsDir + path.sep) || normalized.startsWith(pagesDir + path.sep) || normalized === appPath) {
      delete require.cache[key]
    }
  })
}

beforeEach(() => {
  clearModules()
  global.__wxStorage.clearAll()
  wx.setStorageSync('exam_quiz_session_v1', {
    logged: true, openid: 'A', token: 'OLD', loginAt: Date.now()
  })

  verify = {}
  verify.promise = new Promise((resolve, reject) => {
    verify.resolve = resolve
    verify.reject = reject
  })

  wx.cloud = {
    init() {},
    callFunction: ({ name }) => (name === 'userProfile' ? verify.promise : Promise.resolve({ result: {} }))
  }
  wx.login = ({ success }) => success({ code: 'code' })
  wx.showModal = (options) => { if (options && options.success) options.success({ confirm: false }) }
  global.getCurrentPages = () => []

  app = null
  global.App = (value) => {
    app = Object.assign({}, value, { globalData: JSON.parse(JSON.stringify(value.globalData)) })
  }
  global.getApp = () => app
  global.Page = () => {}
})

async function finish(result) {
  if (result instanceof Error) verify.reject(result)
  else verify.resolve({ result })
  for (let i = 0; i < 40 && !app.globalData.sessionReady; i++) await Promise.resolve()
}

/* ------------------------------------------------------------------ *
 * P1 4425408864：鉴权必须与入口限制解耦
 * ------------------------------------------------------------------ */

test('阻断态下会话仍会完成校验，不会永久挂起（评审 P1 4425408864）', async () => {
  // 模拟上一次启动留下了阻断态（运营当时要求强制更新）
  user = require('../utils/user.js')
  user.markUnsupportedVersion()
  assert.equal(user.isVersionBlocked(), true)

  require('../app.js')
  app.onLaunch()

  // 若 _checkSession 被入口守卫拦截，这里会一直等不到 sessionReady
  await finish({ ok: true, profile: {} })
  assert.equal(app.globalData.sessionReady, true, '会话初始化不得被入口限制阻塞')
  assert.equal(app.globalData.logged, true)
})

test('解除强制更新后阻断态清除且入口恢复正常', async () => {
  user = require('../utils/user.js')
  user.markUnsupportedVersion()
  require('../app.js')
  app.onLaunch()

  assert.equal(app.guardEntry(), true, '阻断时应拦截入口')

  // 运营解除强制更新
  app._applyRuntimeConfig({ version: 1 })
  assert.equal(user.isVersionBlocked(), false, '解除后阻断态应清除')
  assert.equal(app.guardEntry(), false, '解除后入口应恢复')
})

test('离线下阻断态仍持久化（重启后依然拦截）', () => {
  user = require('../utils/user.js')
  user.markUnsupportedVersion()

  // 重新加载模块，模拟重启
  clearModules()
  user = require('../utils/user.js')
  assert.equal(user.isVersionBlocked(), true, '阻断态应持久化到存储')
})
