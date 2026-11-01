require('./wx-shim.js')
const { test, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
let app, user, store, auth, runtime, pages, definition

function deferred() {
  const task = {}
  task.promise = new Promise((resolve, reject) => { task.resolve = resolve; task.reject = reject })
  return task
}

beforeEach(() => {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(path.join(root, 'utils') + path.sep) || key.startsWith(path.join(root, 'pages') + path.sep) || key === path.join(root, 'app.js')) delete require.cache[key]
  }
  __wxStorage.clearAll()
  wx.setStorageSync('exam_quiz_session_v1', { logged: true, openid: 'A', token: 'tok', loginAt: Date.now() })
  auth = deferred()
  runtime = deferred()
  pages = []
  wx.showModal = () => {}
  wx.navigateTo = () => {}
  wx.login = ({ success }) => success({ code: 'code' })
  wx.cloud = {
    init() {},
    callFunction(opts) {
      if (opts.name === 'userProfile') return opts.data.action === 'config' ? runtime.promise : auth.promise
      const result = { ok: true, stats: null, bank: null, attempts: [], hasMore: false }
      if (opts.success) opts.success({ result })
      return Promise.resolve({ result })
    }
  }
  global.getCurrentPages = () => pages
  global.App = (value) => { app = Object.assign({}, value, { globalData: JSON.parse(JSON.stringify(value.globalData)) }) }
  global.getApp = () => app
  global.Page = (value) => { definition = value }
  require('../app.js')
  user = require('../utils/user.js')
  store = require('../utils/store.js')
  app.onLaunch()
})

afterEach(() => {
  pages.forEach((page) => { if (page.onUnload) page.onUnload() })
  store.__clearFlushTimer()
  wx.__cloudReady = false
})

function home() {
  require('../pages/index/index.js')
  const page = Object.assign({}, definition, { route: 'pages/index/index' })
  page.data = JSON.parse(JSON.stringify(definition.data))
  page.setData = (patch) => Object.assign(page.data, patch)
  const refresh = page.refresh
  page.refreshCount = 0
  page.refresh = function () { this.refreshCount += 1; return refresh.call(this) }
  pages.push(page)
  page.onLoad()
  page.onShow()
  return page
}

async function settle() { await new Promise((resolve) => setImmediate(resolve)) }
const config = { noticeEnabled: true, notice: '重要运营公告', features: { aiAdvice: false } }

test('认证先完成、运营配置后到达时，当前首页立即刷新公告与功能开关', async () => {
  const page = home()
  auth.resolve({ result: { ok: true, profile: {} } })
  await settle()
  assert.equal(page.data.notice, '')
  assert.equal(page.data.showAiAdvice, true)
  runtime.resolve({ result: { ok: true, config } })
  await settle()
  assert.equal(page.data.notice, config.notice)
  assert.equal(page.data.showAiAdvice, false)
})

test('配置先到达、认证后完成时只初始化一次，并读取最新配置', async () => {
  const page = home()
  runtime.resolve({ result: { ok: true, config } })
  await settle()
  assert.equal(page.refreshCount, 0)
  auth.resolve({ result: { ok: true, profile: {} } })
  await settle()
  assert.equal(page.refreshCount, 1)
  assert.equal(page.data.notice, config.notice)
  assert.equal(page.data.showAiAdvice, false)
})

test('隐藏首页不响应配置通知，返回时使用最新配置，销毁后解除订阅', async () => {
  const page = home()
  auth.resolve({ result: { ok: true, profile: {} } })
  await settle()
  const count = page.refreshCount
  page.onHide()
  runtime.resolve({ result: { ok: true, config } })
  await settle()
  assert.equal(page.refreshCount, count)
  page.onShow()
  assert.equal(page.data.notice, config.notice)
  assert.equal(page.data.showAiAdvice, false)
  const afterShow = page.refreshCount
  page.onUnload()
  app._applyRuntimeConfig({ noticeEnabled: true, notice: '新公告' })
  assert.equal(page.refreshCount, afterShow)
})

test('配置拉取失败不能清除已经应用的配置或触发假成功刷新', async () => {
  const page = home()
  auth.resolve({ result: { ok: true, profile: {} } })
  await settle()
  app._applyRuntimeConfig(config)
  const count = page.refreshCount
  runtime.reject(new Error('config timeout'))
  await settle()
  assert.equal(page.data.notice, config.notice)
  assert.equal(page.data.showAiAdvice, false)
  assert.equal(page.refreshCount, count)
})

test('版本阻断先解除、认证后完成时，首页不会遗漏初始化', async () => {
  user.markUnsupportedVersion()
  const page = home()
  runtime.resolve({ result: { ok: true, config } })
  await settle()
  auth.resolve({ result: { ok: true, profile: {} } })
  await settle()
  assert.equal(page.refreshCount, 1)
  assert.equal(page.data.notice, config.notice)
})
