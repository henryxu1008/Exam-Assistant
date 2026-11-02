const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { freshStore } = require('./helpers.js')
const { getDefaultState } = require('../shared/stats-merge.js')
const history = () => ({ ...getDefaultState(), attempts: [{ id: 'confirmed' }], attemptOutbox: { version: 1, pending: [] } })
function profile(store) {
  let page
  const toasts = []
  const file = path.join(__dirname, '../pages/profile/profile.js')
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    Page: value => { page = value }, getApp: () => ({}),
    wx: { showToast: value => toasts.push(value), stopPullDownRefresh() {} },
    require: name => name === '../../utils/store.js' ? store : name === '../../utils/user.js'
      ? { requireLogin(cb) { if (cb) cb(); return true }, getProfile: () => ({ logged: true }), initial: () => '合' }
      : require(path.resolve(path.dirname(file), name))
  })
  page.setData = patch => Object.assign(page.data, patch)
  page.onLoad(); page.onShow()
  return { page, toasts }
}
test('个人页实时显示迁移延期，释放空间后重试显示结果，隐藏/卸载后不更新', t => {
  const store = freshStore(history()); wx.__cloudReady = false
  const inventory = wx.getStorageInfoSync
  t.mock.method(wx, 'getStorageInfoSync', () => ({ ...inventory(), currentSize: 0, limitSize: 1 }))
  const ui = profile(store)
  store.saveSettings({ dailyGoal: 50 }); store.flush()
  assert.equal(ui.page.data.localStorage.title, '存储优化已延期')
  assert.equal(store.exportLocalSnapshot().settings.dailyGoal, 50)
  ui.page.onRetryStorage()
  assert.equal(ui.toasts.at(-1).title, '存储优化仍需延期')
  t.mock.restoreAll(); ui.page.onRetryStorage()
  assert.equal(ui.toasts.at(-1).title, '本地保存检查完成')
  assert.equal(ui.page.data.localStorage.tone, 'ready')
  ui.page.onHide()
  const title = ui.page.data.localStorage.title
  t.mock.method(wx, 'setStorageSync', () => { throw new Error('save failed') })
  t.mock.method(console, 'error', () => {})
  store.saveSettings({ dailyGoal: 80 }); store.flush()
  assert.equal(ui.page.data.localStorage.title, title)
  ui.page.onUnload(); store.__clearFlushTimer()
})
test('读取失败显示保留现场提示，修复介质后可本地重试；该入口不发起云端恢复', t => {
  let store = freshStore(); wx.__cloudReady = false
  store.setUserScope('alice')
  wx.setStorageSync('exam_quiz_data_v1__alice', history()); store.saveSettings({ dailyGoal: 50 }); store.flush(); store.__clearFlushTimer()
  const entries = wx.getStorageInfoSync().keys.map(k => [k, wx.getStorageSync(k)])
  const pageEntry = entries.find(([k]) => k.startsWith('exam_quiz_history_v1__'))
  store = freshStore()
  entries.forEach(([k, v]) => wx.setStorageSync(k, v))
  wx.removeStorageSync(pageEntry[0]); store.setUserScope('alice')
  const ui = profile(store)
  assert.equal(ui.page.data.storageReadable, false)
  assert.equal(ui.page.data.localStorage.title, '学习档案暂时无法读取')
  wx.setStorageSync(...pageEntry)
  let calls = 0
  wx.setStorageSync('exam_quiz_session_v1', { logged: true, openid: 'alice', token: 'test' })
  wx.__cloudReady = true; wx.cloud = { callFunction() { calls++ } }
  t.after(() => { ui.page.onUnload(); store.__clearFlushTimer(); wx.__cloudReady = false; wx.cloud = undefined })
  ui.page.onRetryStorage()
  assert.equal(calls, 0)
  assert.equal(ui.page.data.storageReadable, true)
  assert.equal(ui.toasts.at(-1).title, '本地保存检查完成')
})
