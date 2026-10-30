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
  // 冻结时间，避免 recordAnswer 内部与断言之间时钟前进导致毫秒级不等（评审 P2 时间冻结）
  mockDate(BASE)
  const r = store.recordAnswer(q('t1', 'ch1'), true, 1000).record
  const expectNext = BASE + store.REVIEW_INTERVALS[r.level] * DAY
  assert.strictEqual(r.nextReviewAt, expectNext)
  restoreDate()
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
  assert.strictEqual(state.version, 3) // 已迁移（v1->v2->v3）
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
  assert.strictEqual(state.version, 3)
  assert.strictEqual(store.getStudySummary().days, 1)
  assert.strictEqual(store.getStudySummary().timeMs, 2000)
})

test('迁移失败回退默认状态：损坏数据不抛错', () => {
  const seed = 'not-an-object'
  const store = freshStore(seed)
  const state = store.load()
  assert.strictEqual(state.version, 3)
  assert.deepStrictEqual(state.records, {})
})

test('按用户隔离：切换数据种子后互不影响（为 Issue 1 预留）', () => {
  const a = freshStore({ version: 2, records: { x: { id: 'x', subject: helpers.SUBJECT, chapter: 'c', attempts: 1, wrong: 0, right: 1, level: 1 } }, daily: {}, settings: { dailyGoal: 30, autoNext: true, aiExplain: true, currentSubject: '' }, aiMessages: [], createdAt: 0 })
  assert.strictEqual(Object.keys(a.getRecords()).length, 1)
  const b = freshStore() // 全新用户
  assert.strictEqual(Object.keys(b.getRecords()).length, 0)
})

test('按用户隔离：setUserScope 后账号间互不可见彼此数据', () => {
  const store = freshStore()
  store.setUserScope('userA')
  store.recordAnswer(q('a1', 'ch1'), true, 100)
  store.flush() // 强制落盘，确保切作用域后仍可恢复
  assert.strictEqual(Object.keys(store.getRecords()).length, 1)

  store.setUserScope('userB')
  assert.strictEqual(Object.keys(store.getRecords()).length, 0) // B 看不到 A

  store.setUserScope('userA')
  assert.strictEqual(Object.keys(store.getRecords()).length, 1) // 切回 A 仍可见其数据
})

test('clearScope 仅删除指定用户数据，不影响其他账号', () => {
  const store = freshStore()
  store.setUserScope('userA')
  store.recordAnswer(q('a1', 'ch1'), true, 100)
  store.flush()
  store.setUserScope('userB')
  store.recordAnswer(q('b1', 'ch1'), true, 100)
  store.flush()

  store.clearScope('userA')
  store.setUserScope('userA')
  assert.strictEqual(Object.keys(store.getRecords()).length, 0) // A 已清空
  store.setUserScope('userB')
  assert.strictEqual(Object.keys(store.getRecords()).length, 1) // B 仍在
})

/* ---------------- Issue 2/3：练习 Session 状态机 + AnswerAttempt 幂等 ---------------- */

test('createPracticeSession 进入 in_progress 并可读取', () => {
  const store = freshStore()
  const session = store.createPracticeSession({ mode: 'all', subject: helpers.SUBJECT, questionIds: ['a', 'b'] })
  assert.strictEqual(session.status, 'in_progress')
  assert.strictEqual(store.getPracticeSession().id, session.id)
})

test('submitAttempt 同一 clientOpId 重试只落库一次', () => {
  const store = freshStore()
  store.createPracticeSession({ mode: 'all', subject: helpers.SUBJECT, questionIds: ['q1'] })
  const question = q('q1', 'ch1')
  const first = store.submitAttempt(question, ['A'], true, 100, 'op-1')
  assert.strictEqual(first.dup, false)
  assert.strictEqual(first.record.attempts, 1)
  assert.strictEqual(store.getAttempts().length, 1)

  // 重复点击提交：相同 clientOpId -> 幂等，不重复计数
  const second = store.submitAttempt(question, ['A'], true, 100, 'op-1')
  assert.strictEqual(second.dup, true)
  assert.strictEqual(second.record.attempts, 1) // 次数未增加
  assert.strictEqual(store.getAttempts().length, 1) // 流水未新增
})

test('submitAttempt 不同 clientOpId 视为新作答（次数累加）', () => {
  const store = freshStore()
  store.createPracticeSession({ mode: 'all', subject: helpers.SUBJECT, questionIds: ['q1'] })
  const question = q('q1', 'ch1')
  store.submitAttempt(question, ['A'], true, 100, 'op-1')
  store.submitAttempt(question, ['B'], false, 100, 'op-2') // 真的重做
  assert.strictEqual(store.getRecord('q1').attempts, 2)
  assert.strictEqual(store.getAttempts().length, 2)
})

test('已提交题在本会话内只读：submitted 标记存在', () => {
  const store = freshStore()
  const session = store.createPracticeSession({ mode: 'all', subject: helpers.SUBJECT, questionIds: ['q1'] })
  store.submitAttempt(q('q1', 'ch1'), ['A'], true, 100, 'op-1')
  assert.ok(session.submitted['q1'])
  assert.ok(store.getPracticeSession().submitted['q1'])
})

test('主动重练生成新 Session（新 attemptId 序列）', () => {
  const store = freshStore()
  const s1 = store.createPracticeSession({ mode: 'all', subject: helpers.SUBJECT, questionIds: ['q1'] })
  store.submitAttempt(q('q1', 'ch1'), ['A'], true, 100, 'op-1')
  const s2 = store.restartPracticeSession({ mode: 'all', subject: helpers.SUBJECT, questionIds: ['q1'] })
  assert.notStrictEqual(s1.id, s2.id)
  assert.strictEqual(Object.keys(s2.submitted || {}).length, 0) // 新会话未提交任何题
})

test('completePracticeSession 将状态置为 completed', () => {
  const store = freshStore()
  store.createPracticeSession({ mode: 'all', subject: helpers.SUBJECT, questionIds: ['q1'] })
  const done = store.completePracticeSession()
  assert.strictEqual(done.status, 'completed')
  assert.ok(done.completedAt > 0)
})

test('AnswerAttempt 字段完整（不可变流水）', () => {
  const store = freshStore()
  store.createPracticeSession({ mode: 'weak', subject: helpers.SUBJECT, questionIds: ['q1'] })
  const question = q('q1', 'ch1')
  store.submitAttempt(question, ['A'], true, 123, 'op-x')
  const att = store.getAttempts()[0]
  assert.strictEqual(att.questionId, 'q1')
  assert.strictEqual(att.clientOpId, 'op-x')
  assert.strictEqual(att.score, 1)
  assert.strictEqual(att.costMs, 123)
  assert.ok(att.id) // 唯一作答 ID（被 session.submitted.attemptId 引用）
})

/* ---------------- 评审 P2 修复回归 ---------------- */

test('setUserScope 切换作用域前先落盘当前数据，避免节流写入丢答案（评审 P2）', () => {
  const store = freshStore()
  store.recordAnswer(q('t1', 'ch1'), true, 100) // 调度了节流 flush，但数据仍在内存
  store.setUserScope('userX') // 切到新作用域（切换前应先把 anon 数据落盘）
  store.setUserScope('anon') // 切回
  const r = store.getRecord('t1')
  assert.ok(r, '切回后应能读到切换前在 anon 作用域提交的作答')
  assert.strictEqual(r.right, 1)
})

test('getDueRecords 包含错>=2 的题（即便 nextReviewAt 在未来），保证 redoDue 与之口径一致', () => {
  const store = freshStore()
  mockDate(BASE)
  store.recordAnswer(q('t1', 'ch1'), false, 100)
  store.recordAnswer(q('t1', 'ch1'), false, 100) // 错 2 次 -> 顽固
  mockDate(BASE + 100 * DAY) // 推进到未来，nextReviewAt 远超 now
  const due = store.getDueRecords()
  assert.ok(due.some((x) => x.id === 't1'), '错>=2 的题应出现在待复习（mistakes.redoDue 依赖同一选择器）')
  restoreDate()
})
