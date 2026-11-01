/** 清空入口必须传播真实仓储的持久化失败，不能显示成功。 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { freshStore, q } = require('./helpers.js')

function profile(store) {
  let page, modal
  const toasts = []
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages/profile/profile.js'), 'utf8'), {
    getApp: () => ({ globalData: {} }),
    Page: value => { page = value },
    wx: { showModal: value => { modal = value }, showToast: value => toasts.push(value) },
    require: name => name === '../../utils/store.js' ? store : {}
  })
  let refreshed = 0
  page.refresh = () => { refreshed += 1 }
  return { page, toasts, confirm: () => modal.success({ confirm: true }), refreshed: () => refreshed }
}

for (const failed of [true, false]) {
  test(`个人页清空：删除意图写盘${failed ? '失败提示保留原数据' : '成功后刷新清空结果'}`, t => {
    wx.__cloudReady = false
    const store = freshStore()
    store.setUserScope('alice')
    store.recordAnswer(q('keep'), true, 100)
    store.flush()
    const original = wx.setStorageSync
    if (failed) t.mock.method(wx, 'setStorageSync', (key, value) => {
      if (key.startsWith('exam_quiz_pending_delete_v1__')) throw new Error('storage full')
      return original(key, value)
    })
    const ui = profile(store)
    ui.page.onClearData()
    ui.confirm()
    assert.equal(ui.toasts.length, 1)
    if (failed) {
      assert.equal(ui.toasts[0].title, '清空失败，原数据已保留')
      assert.ok(store.getRecord('keep'))
      assert.equal(ui.refreshed(), 0)
    } else {
      assert.equal(ui.toasts[0].title, '已清空')
      assert.equal(store.getRecord('keep'), null)
      assert.equal(ui.refreshed(), 1)
    }
    store.__clearFlushTimer()
  })
}
