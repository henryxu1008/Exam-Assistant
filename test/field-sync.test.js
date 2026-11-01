const { withCommit } = require('./support/commit-response.js')
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { freshStore, q } = require('./helpers.js')
const { mockDate, restoreDate } = require('./date-mock.js')
const { mergeStats } = require('../shared/stats-merge.js')
const clone = (value) => JSON.parse(JSON.stringify(value))

function mutate(seed, time, action) {
  wx.__cloudReady = false
  const store = freshStore(seed)
  mockDate(time)
  action(store)
  const snapshot = clone(store.load())
  store.__clearFlushTimer()
  return snapshot
}

test('没有版本的历史配置优先于新设备默认值，不把默认值当成编辑', () => {
  wx.__cloudReady = false
  const store = freshStore()
  const defaults = clone(store.load())
  const legacy = { settings: { dailyGoal: 60, autoNext: false, aiExplain: false } }
  for (const merged of [mergeStats(defaults, legacy), mergeStats(legacy, defaults)]) {
    assert.equal(merged.settings.dailyGoal, 60)
    assert.equal(merged.settings.autoNext, false)
    assert.equal(merged.settings.aiExplain, false)
  }
})

test('不同设备各改一个设置项，按字段合并而非整对象选胜者', (t) => {
  t.after(restoreDate)
  const a = mutate(null, 1000, (s) => s.saveSettings({ dailyGoal: 50 }))
  const b = mutate(null, 2000, (s) => s.saveSettings({ autoNext: false }))
  for (const merged of [mergeStats(a, b), mergeStats(b, a)]) {
    assert.equal(merged.settings.dailyGoal, 50)
    assert.equal(merged.settings.autoNext, false)
    assert.deepEqual(mergeStats(merged, b).settings, merged.settings)
  }
})

test('同设置按修改版本决胜，重放、重启与时钟回退都不回滚新值', (t) => {
  t.after(restoreDate)
  const a = mutate(null, 1000, (s) => s.saveSettings({ dailyGoal: 50 }))
  const b = mutate(a, 2000, (s) => s.saveSettings({ dailyGoal: 70 }))
  const merged = mergeStats(a, b)
  assert.equal(merged.settings.dailyGoal, 70)
  const c = mutate(merged, 500, (s) => s.saveSettings({ dailyGoal: 80 }))
  assert.equal(mergeStats(c, b).settings.dailyGoal, 80)
  const again = mutate(c, 3000, (s) => s.saveSettings({ dailyGoal: 80 }))
  assert.deepEqual(again.settingsVersions, c.settingsVersions, '同值保存不制造新修改版本')
})

test('离线修改设置后重启，旧云端配置不得覆盖待上传的新值', async (t) => {
  wx.__cloudReady = false
  let store = freshStore()
  store.setUserScope('o1')
  wx.setStorageSync('exam_quiz_session_v1', { logged: true, openid: 'o1', token: 'tok' })
  const old = clone(store.load())
  const otherSubject = require('../utils/questions.js').getSubjects()[1].name
  store.saveSettings({ dailyGoal: 90, autoNext: false, aiExplain: false })
  store.setCurrentSubject(otherSubject)
  store.flush()
  const persisted = wx.getStorageSync('exam_quiz_data_v1__o1')
  store.__clearFlushTimer()

  store = freshStore()
  wx.setStorageSync('exam_quiz_session_v1', { logged: true, openid: 'o1', token: 'tok' })
  wx.setStorageSync('exam_quiz_data_v1__o1', persisted)
  wx.setStorageSync('exam_quiz_pending_push_v1__o1', true)
  store.setUserScope('o1')
  const calls = []
  wx.__cloudReady = true
  wx.cloud = { callFunction(opts) {
    calls.push(opts)
    const result = opts.data.action === 'get'
      ? { ok: true, stats: old, attempts: [], hasMore: false }
      : { ok: true }
    opts.success({ result: withCommit(opts, result) })
    return Promise.resolve({ result })
  } }
  t.after(() => { store.__clearFlushTimer(); wx.__cloudReady = false; wx.cloud = undefined })
  store.load()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(store.getSettings(), persisted.settings)
  assert.equal(store.getCurrentSubject(), otherSubject)
  assert.deepEqual(wx.getStorageSync('exam_quiz_data_v1__o1').settings, persisted.settings)
  const upload = calls.find((c) => c.data.action === 'commitAttempts')
  assert.ok(upload)
  assert.deepEqual(upload.data.stats.settings, persisted.settings)
  assert.deepEqual(upload.data.stats.settingsVersions, persisted.settingsVersions)
})

test('晚到的收藏只改变收藏，不能回滚另一端较新的作答和复习状态', (t) => {
  t.after(restoreDate)
  const baseline = mutate(null, 1000, (s) => s.recordAnswer(q('q1'), false, 10))
  delete baseline.records.q1.fieldVersions // 模拟升级前没有字段版本的已有记录
  const answered = mutate(baseline, 2000, (s) => s.recordAnswer(q('q1'), true, 10))
  const starred = mutate(baseline, 3000, (s) => s.toggleStar('q1'))
  for (const merged of [mergeStats(answered, starred), mergeStats(starred, answered)]) {
    const r = merged.records.q1
    assert.equal(r.starred, true)
    for (const field of ['lastAt', 'level', 'streak', 'bestStreak', 'nextReviewAt', 'rightDays', 'wrongLogs']) {
      assert.deepEqual(r[field], answered.records.q1[field], field)
    }
    assert.equal(r.attempts, 2)
    assert.deepEqual(mergeStats(merged, starred).records, merged.records)
  }
})

test('手动掌握、收藏与真实作答各自保留修改范围，跨分组合并仍一致', (t) => {
  t.after(restoreDate)
  const baseline = mutate(null, 1000, (s) => s.recordAnswer(q('q1'), false, 10))
  const answered = mutate(baseline, 2000, (s) => s.recordAnswer(q('q1'), true, 10))
  const mastered = mutate(baseline, 3000, (s) => s.resetWrong('q1'))
  const starred = mutate(baseline, 4000, (s) => s.toggleStar('q1'))
  const merged = mergeStats(mergeStats(answered, mastered), starred)
  assert.deepEqual(merged.records, mergeStats(answered, mergeStats(mastered, starred)).records)
  assert.equal(merged.records.q1.lastAt, 2000)
  assert.equal(merged.records.q1.level, 5)
  assert.equal(merged.records.q1.mastered, true)
  assert.equal(merged.records.q1.starred, true)
  assert.equal(merged.records.q1.nextReviewAt, mastered.records.q1.nextReviewAt)
  const wrong = mutate(merged, 5000, (s) => s.recordAnswer(q('q1'), false, 10))
  const restored = mergeStats(wrong, starred)
  assert.equal(restored.records.q1.mastered, false)
  assert.equal(restored.records.q1.level, 3)
  assert.equal(restored.records.q1.lastWrongAt, 5000)
  assert.equal(restored.records.q1.starred, true)
})
