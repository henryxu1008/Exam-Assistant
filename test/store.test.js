/**
 * Issue 4：store 核心逻辑测试（复习间隔 / 掌握等级 / 错题重练 / 待复习 / 迁移幂等）
 * 依赖 test/helpers 提供的 wx shim 与用例隔离。
 */
const { test } = require('node:test')
const assert = require('node:assert')
const helpers = require('./helpers.js')
const { freshStore, q, DAY, BASE } = helpers
const { mockDate, restoreDate } = require('./date-mock.js')

test('recordAnswer 首次作答创建记录并累计', () => {
  const store = freshStore()
  const r = store.recordAnswer(q('t1', 'ch1'), true, 1000).record
  assert.strictEqual(r.attempts, 1)
  assert.strictEqual(r.right, 1)
  assert.strictEqual(r.wrong, 0)
  assert.strictEqual(r.level, 1)
  assert.strictEqual(store.getRecord('t1').attempts, 1)
})

test('recordAnswer 答错降级 level 并进入错题本', () => {
  const store = freshStore()
  store.recordAnswer(q('t1', 'ch1'), false, 1000)
  const r = store.getRecord('t1')
  assert.strictEqual(r.wrong, 1)
  assert.strictEqual(r.level, 0)
  assert.strictEqual(store.getWrongRecords().length, 1)
})

test('REVIEW_INTERVALS 与掌握等级映射 nextReviewAt', () => {
  const store = freshStore()
  assert.deepStrictEqual(store.REVIEW_INTERVALS, [0, 1, 2, 4, 7, 15])
  const r = store.recordAnswer(q('t1', 'ch1'), true, 1000).record
  const expectNext = Date.now() + store.REVIEW_INTERVALS[r.level] * DAY
  assert.strictEqual(r.nextReviewAt, expectNext)
})

test('错题重练：连续 MASTER_DAYS 天答对自动移出错题本', () => {
  const store = freshStore()
  mockDate(BASE)
  store.recordAnswer(q('t1', 'ch1'), false, 100) // wrong>0
  mockDate(BASE + 1 * DAY)
  store.recordAnswer(q('t1', 'ch1'), true, 100)
  mockDate(BASE + 2 * DAY)
  store.recordAnswer(q('t1', 'ch1'), true, 100)
  mockDate(BASE + 3 * DAY)
  store.recordAnswer(q('t1', 'ch1'), true, 100)
  const r = store.getRecord('t1')
  assert.strictEqual(r.mastered, true)
  assert.strictEqual(store.getWrongRecords().length, 0) // 已移出错题本
  restoreDate()
})

test('getDueRecords 含「有错未掌握」的题', () => {
  const store = freshStore()
  mockDate(BASE)
  store.recordAnswer(q('t1', 'ch1'), false, 100)
  const due = store.getDueRecords()
  assert.ok(due.some((x) => x.id === 't1'))
  restoreDate()
})

test('getDueRecords 排除已掌握', () => {
  const store = freshStore()
  mockDate(BASE)
  store.recordAnswer(q('t1', 'ch1'), false, 100)
  store.resetWrong('t1') // 手动标记已掌握
  const due = store.getDueRecords()
  assert.ok(!due.some((x) => x.id === 't1'))
  restoreDate()
})

test('迁移：v1 数据升级为 v2 且不丢数据', () => {
  const seed = {
    version: 1,
    records: {},
    daily: {
      '2026-10-29': { date: '2026-10-29', total: 5, correct: 3, timeMs: 1000, chapters: {}, subjects: {} }
    },
    settings: { dailyGoal: 30, autoNext: true, aiExplain: true, currentSubject: '' },
    aiMessages: [],
    createdAt: 0
  }
  const store = freshStore(seed)
  const state = store.load()
  assert.strictEqual(state.version, 2) // 已迁移
  assert.strictEqual(store.getStudySummary().days, 1) // 日统计保留
})

test('迁移幂等：已是 v2 的数据重复加载不会二次迁移/重复计数', () => {
  const seed = {
    version: 2,
    records: {},
    daily: {
      '2026-10-29': { date: '2026-10-29', total: 7, correct: 4, timeMs: 2000, chapters: {}, subjects: {} }
    },
    settings: { dailyGoal: 30, autoNext: true, aiExplain: true, currentSubject: '' },
    aiMessages: [],
    createdAt: 0
  }
  const store = freshStore(seed)
  const state = store.load()
  assert.strictEqual(state.version, 2)
  assert.strictEqual(store.getStudySummary().days, 1)
  assert.strictEqual(store.getStudySummary().timeMs, 2000)
})

test('迁移失败回退默认状态：损坏数据不抛错', () => {
  const seed = 'not-an-object'
  const store = freshStore(seed)
  const state = store.load()
  assert.strictEqual(state.version, 2)
  assert.deepStrictEqual(state.records, {})
})

test('按用户隔离：切换数据种子后互不影响（为 Issue 1 预留）', () => {
  const a = freshStore({ version: 2, records: { x: { id: 'x', subject: helpers.SUBJECT, chapter: 'c', attempts: 1, wrong: 0, right: 1, level: 1 } }, daily: {}, settings: { dailyGoal: 30, autoNext: true, aiExplain: true, currentSubject: '' }, aiMessages: [], createdAt: 0 })
  assert.strictEqual(Object.keys(a.getRecords()).length, 1)
  const b = freshStore() // 全新用户
  assert.strictEqual(Object.keys(b.getRecords()).length, 0)
})
