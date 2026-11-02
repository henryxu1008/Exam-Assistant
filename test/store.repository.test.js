const { test } = require('node:test')
const assert = require('node:assert/strict')
const { freshStore, q } = require('./helpers.js')
const { getDefaultState } = require('../shared/stats-merge.js')
function history() { return { ...getDefaultState(), attempts: [{ id: 'confirmed', selected: ['A'] }], attemptOutbox: { version: 1, pending: [] } } }
const saved = () => wx.getStorageInfoSync().keys.map(key => [key, wx.getStorageSync(key)])
const restore = entries => entries.forEach(([key, value]) => wx.setStorageSync(key, value))

test('分段不可读时 store 不回落默认档案、不上传、不允许保存覆盖，状态可查询', t => {
  let store = freshStore(history()); store.saveSettings({ dailyGoal: 32 }); store.flush(); store.__clearFlushTimer()
  const entries = saved().filter(([key]) => !key.startsWith('exam_quiz_history'))
  store = freshStore(); restore(entries)
  let writes = 0
  const write = wx.setStorageSync
  t.mock.method(wx, 'setStorageSync', (key, value) => { writes++; return write(key, value) })
  assert.throws(() => store.load(), /LOCAL_HISTORY_UNAVAILABLE/)
  assert.throws(() => store.saveSettings({ dailyGoal: 50 }), /LOCAL_HISTORY_UNAVAILABLE/)
  assert.equal(writes, 0); assert.equal(store.getLocalStorageStatus().state, 'read_error')
})

test('匿名整体清空检查点失败返回失败，重启仍可读旧完整档案而非报告成功', t => {
  let store = freshStore(history()); store.saveSettings({ dailyGoal: 32 }); store.flush(); store.__clearFlushTimer()
  const write = wx.setStorageSync
  t.mock.method(wx, 'setStorageSync', (key, value) => { if (key === 'exam_quiz_data_v1__anon') throw new Error('quota'); return write(key, value) })
  const result = store.clearAll()
  assert.equal(result.ok, false); assert.equal(result.error, 'PERSIST_CLEAR_FAILED')
  store.__clearFlushTimer(); t.mock.restoreAll()
  const entries = saved(); store = freshStore(); restore(entries)
  assert.equal(store.getAttempts()[0].id, 'confirmed')
  store.__clearFlushTimer()
})

test('store 回滚要求离线且无待落盘/在途任务，成功只导出最新检查点并要求重启', t => {
  const store = freshStore(history())
  t.after(() => { store.__clearFlushTimer(); wx.__cloudReady = false; wx.cloud = undefined })
  store.saveSettings({ dailyGoal: 32 })
  assert.equal(store.rollbackLocalStorage().error, 'ROLLBACK_REQUIRES_OFFLINE_QUIESCENCE')
  store.flush(); wx.__cloudReady = true; wx.cloud = { callFunction() {} }
  assert.equal(store.rollbackLocalStorage().error, 'ROLLBACK_REQUIRES_OFFLINE_QUIESCENCE')
  wx.__cloudReady = false
  const result = store.rollbackLocalStorage()
  assert.equal(result.ok, true); assert.equal(result.restartRequired, true)
  assert.equal(wx.getStorageSync('exam_quiz_data_v1__anon').version, 3)
  assert.equal(store.exportLocalSnapshot().attempts[0].id, 'confirmed')
})

test('保存结果不确定时通用重试不得用旧内存覆盖实际已提交作答，重启后同操作幂等', t => {
  let store = freshStore(history()); wx.__cloudReady = false
  store.createPracticeSession({ questionIds: ['pending'] }); store.flush(); store.__clearFlushTimer()
  const write = wx.setStorageSync
  t.mock.method(wx, 'setStorageSync', (key, value) => {
    write(key, value)
    if (key === 'exam_quiz_data_v1__anon') throw new Error('result lost')
  })
  const question = q('pending')
  assert.equal(store.submitAttempt(question, ['A'], true, 100, 'same').ok, false)
  const before = saved()
  assert.equal(store.retryLocalStorage().error, 'LOCAL_RESTART_REQUIRED')
  assert.deepEqual(saved(), before)
  store.__clearFlushTimer(); t.mock.restoreAll()
  store = freshStore(); restore(before)
  assert.equal(store.exportLocalSnapshot().attempts.length, 2)
  assert.equal(store.exportLocalSnapshot().attemptOutbox.pending.length, 1)
  assert.equal(store.submitAttempt(question, ['A'], true, 100, 'same').dup, true)
  assert.equal(store.getAttempts().length, 2)
  store.__clearFlushTimer()
})

test('匿名清空因旧根缺页校验失败时仍报告失败，不能把 read_error 当成保存成功', t => {
  const store = freshStore(history()); wx.__cloudReady = false
  store.saveSettings({ dailyGoal: 32 }); store.flush(); store.__clearFlushTimer()
  t.mock.method(console, 'error', () => {})
  t.after(() => store.__clearFlushTimer())
  const root = wx.getStorageSync('exam_quiz_data_v1__anon')
  const key = wx.getStorageInfoSync().keys.find(k => k.startsWith('exam_quiz_history_v1__'))
  wx.removeStorageSync(key)
  assert.equal(store.clearAll().ok, false)
  assert.equal(store.getLocalStorageStatus().state, 'read_error')
  assert.deepEqual(wx.getStorageSync('exam_quiz_data_v1__anon'), root)
})
