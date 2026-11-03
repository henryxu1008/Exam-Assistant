/** 真实练习页状态衔接：清空、切账号、换科目与新练习请求的组合。 */
require('./wx-shim.js')
const { test, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const store = require('../utils/store.js')
const bank = require('../utils/questions.js')
const user = require('../utils/user.js')

let definition
const app = { globalData: {} }
global.getApp = () => app
global.Page = (value) => { definition = value }
require('../pages/practice/practice.js')
wx.showToast = () => {}

const DEFAULT_SUBJECT = bank.getSubjects()[0].name
const OTHER_SUBJECT = '专业知识'
const CHAPTER = '操作系统'
const questions = bank.filterQuestions({ subject: OTHER_SUBJECT, chapter: CHAPTER })
let pages

beforeEach((t) => {
  store.flush()
  store.setUserScope('anon')
  global.__wxStorage.clearAll()
  store.clearAll()
  app.globalData = {}
  pages = []
  t.mock.method(user, 'whenReady', (onReady) => { if (onReady) onReady(); return true })
})

afterEach(() => {
  pages.forEach((page) => page.onUnload())
  store.flush()
  wx.__cloudReady = false
  wx.cloud = undefined
})

function makePage(params) {
  assert.notEqual(OTHER_SUBJECT, DEFAULT_SUBJECT)
  assert.ok(questions.length >= 2, '评审用例应使用真实的专业知识/操作系统题目')
  assert.equal(bank.filterQuestions({ subject: DEFAULT_SUBJECT, chapter: CHAPTER }).length, 0)
  const page = Object.assign({}, definition)
  page.data = JSON.parse(JSON.stringify(definition.data))
  page.setData = function (patch, callback) { Object.assign(this.data, patch); if (callback) callback() }
  pages.push(page)
  page.onLoad({})
  app.globalData.practiceParams = Object.assign({ __stamp: 1 }, params)
  page.onShow()
  return page
}

function start(mode, subject = OTHER_SUBJECT) {
  const pool = subject === OTHER_SUBJECT ? questions : bank.filterQuestions({ subject })
  return makePage({
    mode, subject,
    chapter: mode === 'chapter' ? pool[0].chapter : '',
    ids: mode === 'single' ? [pool[0].id] : null
  })
}

const changes = {
  '清空学习数据': () => store.clearAll(),
  '切换账号': () => store.setUserScope('B'),
  '会话替换并换科': () => {
    store.setCurrentSubject(DEFAULT_SUBJECT)
    store.createPracticeSession({ subject: DEFAULT_SUBJECT, questionIds: [] })
  },
  '仅从其它页面换科': () => store.setCurrentSubject(DEFAULT_SUBJECT)
}

for (const mode of ['chapter', 'single']) {
  for (const [name, change] of Object.entries(changes)) {
    test(`${mode}：${name}后回到默认科目，清理旧章节和 IDs，队列仍可提交`, () => {
      const page = start(mode)
      const previousId = store.getPracticeSession().id
      change()
      assert.equal(store.getCurrentSubject(), DEFAULT_SUBJECT)
      page.onShow()
      assert.equal(page.data.mode, 'all')
      assert.equal(page.data.subject, DEFAULT_SUBJECT)
      assert.equal(page.data.chapter, '')
      assert.equal(page._params.ids, null)
      assert.ok(page.data.total > 0)
      assert.ok(page.data.queue.every((q) => q.subject === DEFAULT_SUBJECT))
      const session = store.getPracticeSession()
      assert.notEqual(session.id, previousId)
      assert.equal(session.params.mode, 'all')
      assert.equal(session.subject, DEFAULT_SUBJECT)
      store.saveSettings({ autoNext: false })
      page.setData({ selected: page.data.question.answer })
      page.onSubmit()
      assert.equal(page.data.sessionTotal, 1)
      assert.equal(page.data.sessionCorrect, 1)
    })
  }

  test(`${mode}：清空后科目没变，保留当前科目的专项约束`, () => {
    const page = start(mode, DEFAULT_SUBJECT)
    const previous = JSON.parse(JSON.stringify(page._params))
    const oldSession = page._sessionId
    store.clearAll()
    page.onShow()
    assert.equal(page.data.mode, mode)
    assert.equal(page.data.chapter, previous.chapter)
    assert.deepEqual(page._params.ids, previous.ids)
    assert.notEqual(page._sessionId, oldSession)
    assert.ok(page.data.total > 0)
  })

  test(`${mode}：账号变化但科目相同，仍保留有效专项请求`, () => {
    const page = start(mode)
    const previous = JSON.parse(JSON.stringify(page._params))
    const oldSession = page._sessionId
    store.setUserScope('B')
    store.setCurrentSubject(OTHER_SUBJECT)
    page.onShow()
    assert.equal(page.data.mode, mode)
    assert.equal(page.data.chapter, previous.chapter)
    assert.deepEqual(page._params.ids, previous.ids)
    assert.notEqual(page._sessionId, oldSession)
    assert.ok(page.data.queue.every((q) => q.subject === OTHER_SUBJECT))
  })

  test(`${mode}：重置后有新的显式请求，以新请求的科目和题集为准`, () => {
    const page = start('all')
    store.clearAll()
    app.globalData.practiceParams = {
      __stamp: 2, mode, subject: OTHER_SUBJECT,
      chapter: mode === 'chapter' ? CHAPTER : '',
      ids: mode === 'single' ? [questions[1].id] : null
    }
    page.onShow()
    assert.equal(page.data.mode, mode)
    assert.equal(page.data.subject, OTHER_SUBJECT)
    assert.ok(page.data.total > 0)
    if (mode === 'chapter') assert.equal(page.data.chapter, CHAPTER)
    else assert.deepEqual(page.data.queue.map((q) => q.id), [questions[1].id])
    const sessionId = page._sessionId
    page.onShow()
    assert.equal(page._sessionId, sessionId, '显式请求只消费一次')
  })
}

test('科目、账号、会话都没变时保留进度和只读答案', () => {
  const page = start('chapter')
  store.saveSettings({ autoNext: false })
  page.setData({ selected: page.data.question.answer })
  page.onSubmit()
  const id = page._sessionId
  const before = JSON.stringify(store.load())
  page.onShow()
  assert.equal(page._sessionId, id)
  assert.equal(page.data.submitted, true)
  assert.equal(page.data.sessionTotal, 1)
  assert.equal(JSON.stringify(store.load()), before)
})

test('随机模式跨科重建仍为随机练习，队列仅来自当前科目', () => {
  const page = start('random')
  store.clearAll()
  page.onShow()
  assert.equal(page.data.mode, 'random')
  assert.equal(page.data.subject, DEFAULT_SUBJECT)
  assert.ok(page.data.queue.every((q) => q.subject === DEFAULT_SUBJECT))
})

test('当前页 loadPending 消费切账号后的新请求，返回页面不再重建同一会话', () => {
  const page = start('chapter')
  store.setUserScope('B')
  app.globalData.practiceParams = {
    __stamp: 2, mode: 'single', subject: OTHER_SUBJECT, ids: [questions[1].id]
  }
  page.loadPending()
  const id = page._sessionId
  page.onShow()
  assert.equal(page._sessionId, id)
  assert.deepEqual(page.data.queue.map((q) => q.id), [questions[1].id])
})

test('页面打开期间云端替换会话，立即恢复新题集，不把旧选项记入新会话', () => {
  wx.__cloudReady = false
  store.setUserScope('cloud-user')
  wx.setStorageSync('exam_quiz_session_v1', { logged: true, openid: 'cloud-user', token: 'tok' })
  const page = start('single')
  page.setData({ selected: page.data.question.answer, canSubmit: true })
  const calls = []
  wx.__cloudReady = true
  wx.cloud = { callFunction(opts) {
    calls.push(opts)
    if (opts.data.action !== 'get') opts.fail(new Error('fixture offline write'))
    return Promise.resolve()
  } }
  store.pullFromCloud()
  const restored = {
    id: 'restored-session', subject: OTHER_SUBJECT, mode: 'single', questionIds: [questions[1].id],
    questionSnapshots: { [questions[1].id]: questions[1] },
    params: { mode: 'single', subject: OTHER_SUBJECT, chapter: '', ids: [questions[1].id] },
    status: 'in_progress', createdAt: Date.now() + 1000, updatedAt: Date.now() + 1000,
    currentIndex: 0, submitted: {}
  }
  calls.find((c) => c.data.action === 'get').success({ result: {
    ok: true, stats: { version: 3, practiceSession: restored }, attempts: [], hasMore: false
  } })
  assert.equal(store.getPracticeSession().id, restored.id)
  assert.equal(page._sessionId, restored.id)
  assert.equal(page.data.question.id, questions[1].id)
  assert.deepEqual(page.data.selected, [])
  page.onSubmit()
  assert.equal(store.getAttempts().length, 0, '旧选项不得提交到新会话')
  store.saveSettings({ autoNext: false })
  page.setData({ selected: page.data.question.answer })
  page.onSubmit()
  assert.equal(store.getAttempts()[0].sessionId, restored.id)
  assert.equal(store.getAttempts()[0].questionId, questions[1].id)
})

test('过期页面的提交、暂停、完成均不能改写替换后的会话', () => {
  const page = start('single')
  const context = store.getPracticeContext()
  const oldQuestion = page.data.question
  const next = store.createPracticeSession({
    subject: OTHER_SUBJECT, mode: 'single', questionIds: [questions[1].id],
    params: { mode: 'single', subject: OTHER_SUBJECT, chapter: '', ids: [questions[1].id] }
  })
  const before = JSON.stringify(store.load())
  const rejected = store.submitAttempt(oldQuestion, oldQuestion.answer, true, 1, 'stale', context)
  assert.equal(rejected.ok, false)
  assert.equal(JSON.stringify(store.load()), before)
  assert.equal(store.updatePracticeSession({ currentIndex: 99 }, context), null)
  assert.equal(store.completePracticeSession(context), null)
  page.setData({ selected: oldQuestion.answer })
  page.onSubmit()
  assert.equal(store.getAttempts().length, 0)
  assert.equal(store.getPracticeSession().id, next.id)
  assert.equal(page.data.question.id, questions[1].id)
})

test('同会话远端补齐作答后，页面刷新答案并直接结束得到正确成绩', () => {
  wx.__cloudReady = false
  store.setUserScope('cloud-user')
  wx.setStorageSync('exam_quiz_session_v1', { logged: true, openid: 'cloud-user', token: 'tok' })
  const page = start('chapter')
  store.saveSettings({ autoNext: false })
  const first = page.data.queue[0]
  const second = page.data.queue[1]
  page.setData({ selected: ['definitely-wrong'] })
  page.onSubmit()
  const local = JSON.parse(JSON.stringify(store.getPracticeSession()))
  const previousContext = store.getPracticeContext()
  const remote = Object.assign({}, local, {
    updatedAt: local.updatedAt + 10, submitted: { [second.id]: { attemptId: 'remote-answer' } },
    sessionTotal: 1, sessionCorrect: 1, errorIds: []
  })
  const calls = []
  wx.__cloudReady = true
  wx.cloud = { callFunction(opts) {
    calls.push(opts)
    if (opts.data.action !== 'get') opts.fail(new Error('fixture offline write'))
    return Promise.resolve()
  } }
  store.pullFromCloud()
  calls.find((c) => c.data.action === 'get').success({ result: {
    ok: true, stats: { version: 3, practiceSession: remote },
    attempts: [{ id: 'remote-answer', sessionId: local.id, questionId: second.id,
      score: 1, createdAt: Date.now() + 100, selected: second.answer, questionVersionId: second.versionId,
      bankReleaseId: second.bankReleaseId, questionSnapshot: second, answer: second.answer }], hasMore: false
  } })
  assert.equal(page.data.sessionTotal, 2)
  assert.equal(page.data.sessionCorrect, 1)
  assert.deepEqual(page.data.errorIds, [first.id])
  assert.equal(store.submitAttempt(first, first.answer, true, 1, 'stale-same-session', previousContext).error, 'STALE_PRACTICE_CONTEXT')
  page._load(1)
  assert.equal(page.data.submitted, true)
  assert.deepEqual(page.data.selected, second.answer)
  page._finish()
  assert.equal(page.data.summary.total, 2)
  assert.equal(page.data.summary.correct, 1)
  assert.equal(page.data.summary.rate, 50)
  assert.deepEqual(page.data.summary.wrongList.map((q) => q.id), [first.id])
})

test('存储层拒绝会话外题目，加入相似题后同步扩展可提交范围', () => {
  const page = start('single')
  const nextQuestion = questions[1]
  const before = JSON.stringify(store.load())
  const result = store.submitAttempt(nextQuestion, nextQuestion.answer, true, 10, 'outside', store.getPracticeContext())
  assert.equal(result.error, 'QUESTION_OUTSIDE_SESSION')
  assert.equal(JSON.stringify(store.load()), before)
  page.onAddSimilar({ currentTarget: { dataset: { id: nextQuestion.id } } })
  page.onNext()
  page.setData({ selected: nextQuestion.answer })
  store.saveSettings({ autoNext: false })
  page.onSubmit()
  assert.equal(store.getPracticeSession().questionIds.includes(nextQuestion.id), true)
  assert.equal(store.getAttempts()[0].questionId, nextQuestion.id)
})

test('缺少作答证据的恢复会话不能显示缓存的成功成绩', () => {
  const page = start('single')
  store.updatePracticeSession({ statsComplete: false, sessionTotal: 1, sessionCorrect: 1 })
  page._finish()
  assert.equal(page.data.finished, false)
  assert.equal(store.getPracticeSession().status, 'in_progress')
})

for (const action of ['onStop', '_finish']) {
  test(`旧页面 ${action} 只能重新绑定，不写入新会话的进度或状态`, () => {
    const page = start('single')
    const next = store.createPracticeSession({
      subject: OTHER_SUBJECT, mode: 'single', questionIds: [questions[1].id],
      params: { mode: 'single', subject: OTHER_SUBJECT, chapter: '', ids: [questions[1].id] }
    })
    const before = JSON.stringify(store.load())
    page[action]()
    assert.equal(JSON.stringify(store.load()), before)
    assert.equal(page._sessionId, next.id)
    assert.equal(page.data.question.id, questions[1].id)
  })
}


test('本地保存失败时保留所选答案且不锁题，恢复存储后可重试一次', (t) => {
  const page = start('single')
  store.saveSettings({ autoNext: false })
  store.flush()
  const q = page.data.question
  const selected = q.answer.slice()
  page.setData({ selected, showExplain: false })
  let fail = true
  const write = wx.setStorageSync
  const toasts = []
  t.mock.method(wx, 'showToast', value => toasts.push(value.title))
  t.mock.method(wx, 'setStorageSync', (key, value) => {
    if (fail && key.startsWith('exam_quiz_data_v1__')) throw new Error('storage full')
    write(key, value)
  })
  page.onSubmit()
  assert.equal(page.data.submitted, false)
  assert.equal(page.data.showExplain, false)
  assert.deepEqual(page.data.selected, selected)
  assert.equal(store.getPracticeSession().submitted[q.id], undefined)
  assert.equal(store.getAttempts().length, 0)
  assert.ok(toasts.includes('保存失败，请重试'))
  fail = false
  page.onSubmit()
  assert.equal(page.data.submitted, true)
  assert.equal(page.data.sessionTotal, 1)
  assert.equal(store.getRecord(q.id).attempts, 1)
  page.onSubmit()
  assert.equal(store.getAttempts().length, 1)
})

test('题库纠错后恢复会话仍显示作答时题面、答案和解析，不按稳定题号套用新版本', (t) => {
  const page = start('single')
  store.saveSettings({ autoNext: false })
  const original = JSON.parse(JSON.stringify(page.data.question))
  page.setData({ selected: original.answer }); page.onSubmit()
  const attempt = store.getAttempts()[0]
  assert.equal(attempt.questionVersionId, original.versionId)
  assert.deepEqual(bank.resolveAttemptQuestion(attempt), original)
  t.mock.method(bank, 'findQuestion', () => ({ ...original, stem: '运营修订后的新题面', answer: ['Z'], explain: '新的解析' }))
  page._restoreSession(store.getPracticeSession())
  assert.equal(page.data.question.stem, original.stem)
  assert.deepEqual(page.data.question.answer, original.answer)
  assert.equal(page.data.question.explain, original.explain)
  assert.deepEqual(page.data.selected, original.answer)
})

test('旧 v1 作答缺失原题证据时保留未知，不用当前题库伪造恢复或改写旧流水', () => {
  const page = start('single')
  store.saveSettings({ autoNext: false })
  page.setData({ selected: page.data.question.answer }); page.onSubmit()
  const old = store.load().attempts[0]
  delete old.questionSnapshot; delete old.bankReleaseId; old.questionVersionId = 'v1'
  const before = JSON.stringify(store.load())
  page._restoreSession(store.getPracticeSession())
  assert.equal(page.data.question, null)
  assert.match(page.data.emptyTip, /缺少原题版本/)
  assert.equal(JSON.stringify(store.load()), before)
})

test('带题目快照的作答在旧后端明确拒绝，不会先接受流水再丢掉版本证据', async () => {
  store.setUserScope('cloud-user')
  wx.setStorageSync('exam_quiz_session_v1', { logged: true, openid: 'cloud-user', token: 'tok' })
  let accepted = 0
  wx.__cloudReady = true
  wx.cloud = { callFunction(opts) {
    let result
    if (opts.data.action === 'get') result = { ok: true, stats: null, attempts: [], hasMore: false, dataEpoch: 0 }
    else if (opts.data.action === 'commitAttempts') { accepted += opts.data.attempts.length; result = { ok: false, error: 'UNEXPECTED_OLD_ACTION' } }
    else result = { ok: false, error: 'BAD_ACTION' }
    opts.success({ result }); return Promise.resolve({ result })
  } }
  const page = start('single'); store.saveSettings({ autoNext: false })
  page.setData({ selected: page.data.question.answer }); page.onSubmit()
  const result = await store.syncNow()
  assert.equal(result.error, 'BAD_ACTION')
  assert.equal(accepted, 0)
  assert.equal(store.load().attemptOutbox.pending.length, 1)
  assert.ok(store.getAttempts()[0].questionSnapshot)
})

test('服务端确认改为业务 ID 后，本轮页面上下文与自动下一题计时器仍有效', async () => {
  const { makeHarness } = require('./support/study-sync-harness.js')
  const server = makeHarness()
  // 显式发布测试用内置 Mock 夹具；不能将客户端自签快照自动当成云端已发布内容。
  const manifest = require('../utils/bank/manifest.js')
  const published = require('../shared/question-domain.js').buildRelease({ manifest,
    questions: Object.fromEntries(manifest.subjects.map(s => [s.key, require('../utils/bank/' + s.key + '.js')])) })
  server.questions.set(published.releaseId, { kind: 'questionBankRelease', bank: published, publishedAt: 1 })
  wx.setStorageSync('exam_quiz_session_v1', { logged: true, token: 'tokA', openid: 'alice' })
  store.setUserScope('alice')
  wx.__cloudReady = true
  const requests = new Set(), outcomes = []
  wx.cloud = { callFunction(opts) {
    const task = server.main(opts.data).then(result => { outcomes.push({ action: opts.data.action, ok: result.ok, error: result.error }); opts.success({ result }) })
    requests.add(task)
    task.finally(() => requests.delete(task))
    return task
  } }
  store.load()
  const page = start('chapter')
  store.saveSettings({ autoNext: true })
  page.setData({ selected: page.data.question.answer })
  page.onSubmit()
  await new Promise(setImmediate)
  while (requests.size) { await Promise.all([...requests]); await new Promise(setImmediate) }
  assert.equal(page.data.submitted, true)
  assert.equal(store.isPracticeContextCurrent(page._practiceContext), true)
  assert.ok(page._timer, '确认只是 ID 收敛，不能取消已计划的自动下一题')
  assert.ok(store.getPracticeSession().submitted[page.data.question.id].attemptId.startsWith('op_'), JSON.stringify(outcomes))
  assert.equal(store.getRecord(page.data.question.id).attempts, 1)
})
