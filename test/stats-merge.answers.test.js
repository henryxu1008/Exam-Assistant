const { test } = require('node:test')
const assert = require('node:assert/strict')
const { freshStore, q } = require('./helpers.js')
const { mergeStats } = require('../shared/stats-merge.js')
const clone = (value) => JSON.parse(JSON.stringify(value))

function answerOnDevice(writer, correct, seed) {
  wx.__cloudReady = false
  const store = freshStore(seed)
  wx.setStorageSync('exam_quiz_writer_v1', writer)
  store.recordAnswer(q('q1', 'chapter'), correct, 100)
  const snapshot = clone(store.load())
  store.__clearFlushTimer()
  return snapshot
}

test('同题两端独立作答累计贡献，收藏等可编辑字段独立决胜', () => {
  const a = answerOnDevice('A', false)
  const b = answerOnDevice('B', true)
  b.records.q1.starred = true
  b.records.q1.updatedAt = a.records.q1.updatedAt + 100
  for (const merged of [mergeStats(a, b), mergeStats(b, a)]) {
    assert.equal(merged.records.q1.attempts, 2)
    assert.equal(merged.records.q1.right, 1)
    assert.equal(merged.records.q1.wrong, 1)
    assert.equal(merged.records.q1.starred, true)
    assert.ok(merged.records.q1.lastWrongAt > 0)
    assert.deepEqual(mergeStats(merged, a).records, merged.records, '重放上传不能重复计数')
    const restored = freshStore(merged)
    const analytics = require('../utils/analytics.js')
    const overview = analytics.overview()
    assert.equal(overview.total, 2)
    assert.equal(overview.correct, 1)
    assert.equal(overview.rate, 50)
    assert.equal(restored.getWrongRecords().length, 1)
    restored.__clearFlushTimer()
  }
})

test('共享历史只计一次，新贡献在三端合并和再次作答后仍收敛', () => {
  const seed = {
    version: 3, records: { q1: { id: 'q1', attempts: 5, right: 3, wrong: 2 } }
  }
  const a = answerOnDevice('A', false, seed)
  const b = answerOnDevice('B', true, seed)
  const c = answerOnDevice('C', true, seed)
  const left = mergeStats(mergeStats(a, b), c)
  const right = mergeStats(a, mergeStats(b, c))
  assert.deepEqual(left.records, right.records, '分组次序不影响结果')
  assert.equal(left.records.q1.attempts, 8)
  assert.equal(left.records.q1.right, 5)
  assert.equal(left.records.q1.wrong, 3)
  const next = answerOnDevice('A', true, left)
  const repeated = mergeStats(next, left)
  assert.equal(repeated.records.q1.attempts, 9)
  assert.equal(repeated.records.q1.right, 6)
})

test('同版本元数据决胜不受写入者标识、累计计数或合并分组影响', () => {
  const snapshot = (writer, starred) => ({ records: { q1: {
    id: 'q1', updatedAt: 1, lastAt: 1, starred,
    attempts: 1, right: 1, wrong: 0, answerBy: { [writer]: { attempts: 1, right: 1, wrong: 0 } }
  } } })
  const a = snapshot('A', true)
  const b = snapshot('Z', false)
  const c = snapshot('M', false)
  assert.equal(mergeStats(a, b).records.q1.starred, true)
  assert.deepEqual(mergeStats(mergeStats(a, b), c).records, mergeStats(a, mergeStats(b, c)).records)
  assert.equal(a.records.q1.attempts, 1, '纯合并不得改动输入快照')
})

function sessionPart(questionId, score, time) {
  const id = 'a-' + questionId
  return {
    practiceSession: {
      id: 'session', questionIds: ['q1', 'q2'], status: 'in_progress', createdAt: 1,
      updatedAt: time, submitted: { [questionId]: { attemptId: id } },
      sessionTotal: 1, sessionCorrect: score, errorIds: score ? [] : [questionId]
    },
    attempts: [{ id, sessionId: 'session', questionId, score, createdAt: time }]
  }
}

test('同会话合并后立即重算总题数、正确数与错题，无须再提交', () => {
  const a = sessionPart('q1', 0, 1)
  const b = sessionPart('q2', 1, 2)
  for (const merged of [mergeStats(a, b), mergeStats(b, a)]) {
    assert.equal(merged.practiceSession.sessionTotal, 2)
    assert.equal(merged.practiceSession.sessionCorrect, 1)
    assert.deepEqual(merged.practiceSession.errorIds, ['q1'])
    assert.equal(merged.practiceSession.statsComplete, true)
    assert.deepEqual(mergeStats(merged, b).practiceSession, merged.practiceSession)
  }
})

test('同题冲突按作答时间选答案，汇总与该答案一致，不能依赖数组顺序', () => {
  const a = sessionPart('q1', 0, 20)
  const b = sessionPart('q1', 1, 10)
  a.attempts[0].id = 'late'
  a.practiceSession.submitted.q1.attemptId = 'late'
  b.attempts[0].id = 'early'
  b.practiceSession.submitted.q1.attemptId = 'early'
  b.practiceSession.updatedAt = 100 // 后续翻页不应改变较新的实际答案
  for (const merged of [mergeStats(a, b), mergeStats(b, a)]) {
    assert.equal(merged.practiceSession.submitted.q1.attemptId, 'late')
    assert.equal(merged.practiceSession.sessionTotal, 1)
    assert.equal(merged.practiceSession.sessionCorrect, 0)
    assert.deepEqual(merged.practiceSession.errorIds, ['q1'])
  }
})

test('有提交标记却缺少作答证据时不沿用缓存成绩', () => {
  const snapshot = sessionPart('q1', 1, 1)
  snapshot.attempts = []
  const merged = mergeStats({}, snapshot)
  assert.equal(merged.practiceSession.statsComplete, false)
})

test('扩展同一会话的题集后，已合并提交仍属于合并后的队列', () => {
  const a = sessionPart('q1', 0, 1)
  a.practiceSession.questionIds = ['q1']
  a.practiceSession.updatedAt = 10
  const b = sessionPart('q2', 1, 2)
  const session = mergeStats(a, b).practiceSession
  assert.deepEqual(session.questionIds, ['q1', 'q2'])
  assert.equal(session.sessionTotal, 2)
})
