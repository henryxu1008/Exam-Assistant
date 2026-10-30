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
  t.mock.method(user, 'requireLogin', (onLogged) => { if (onLogged) onLogged(); return true })
})

afterEach(() => {
  pages.forEach((page) => page.onUnload())
  store.flush()
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
