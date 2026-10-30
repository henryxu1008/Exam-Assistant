/**
 * 评审 P2 回归：自动下一题定时器在切换题目（回看上一题）时必须被取消，
 * 否则残留定时器命中 `submitted` 后又自动前进，打断复习。
 * 用轻量 page 桩验证 _load 会清除挂起的 this._timer，无需完整小程序运行时。
 */
require('./wx-shim.js')
const { test } = require('node:test')
const assert = require('node:assert')

// 捕获 practice.js 调用 Page(...) 时传入的定义
let capturedPage = null
global.Page = (def) => {
  capturedPage = def
}
const __app = { globalData: {} }
global.getApp = () => __app

require('../pages/practice/practice.js')

function makePage(queue, timer) {
  const page = Object.assign({}, capturedPage)
  page.data = { queue: queue, idx: 0 }
  page.setData = function (patch) {
    Object.assign(this.data, patch)
  }
  page._timer = timer
  return page
}

test('_load 切换题目时清除挂起的自动下一题定时器（P2 回归）', () => {
  const queue = [
    { id: 'q1', type: 'single', answer: ['A'] },
    { id: 'q2', type: 'single', answer: ['A'] }
  ]
  const page = makePage(queue, 12345)
  // 模拟：上一题刚答对，1.2s 自动下一题定时器仍挂起，用户点了「上一题」
  page._load(0)
  assert.strictEqual(page._timer, null) // 残留定时器已被清除，不会再次自动前进
})

test('_load 到已提交题不会因残留定时器前进（只读回看）', () => {
  const queue = [
    { id: 'q1', type: 'single', answer: ['A'] },
    { id: 'q2', type: 'single', answer: ['A'] }
  ]
  const store = require('../utils/store.js')
  store.createPracticeSession({ mode: 'all', subject: require('./helpers.js').SUBJECT, questionIds: ['q1', 'q2'] })
  store.submitAttempt(queue[1], ['A'], true, 100, 'op-q2')
  const page = makePage(queue, 999)
  page._load(1) // 回看已提交的 q2
  assert.strictEqual(page._timer, null)
  assert.strictEqual(page.data.submitted, true) // 只读回看状态
})

test('评审 P2：重建页面时恢复未完成的会话（进度/已提交只读回看）', () => {
  const store = require('../utils/store.js')
  const helpers = require('./helpers.js')
  const bank = require('../utils/bank/index.js')
  // 取当前科目下两道真实题目的 id（store 按题目 id 恢复队列，必须用真实存在 id）
  const real = bank.filterQuestions({ subject: helpers.SUBJECT })
  const qA = real[0]
  const qB = real[1]
  // 模拟已进行中的一轮：创建会话、提交 qA、进度停在 qB
  store.createPracticeSession({
    mode: 'all',
    subject: helpers.SUBJECT,
    questionIds: [qA.id, qB.id],
    params: { mode: 'all', subject: helpers.SUBJECT, chapter: '', ids: null }
  })
  store.submitAttempt({ id: qA.id, type: qA.type, answer: qA.answer, subject: helpers.SUBJECT, chapter: qA.chapter }, qA.answer, true, 100, 'op-a')
  store.updatePracticeSession({ currentIndex: 1 })
  // 重建页面（app 重启后再次进入练习），参数一致且非 fresh -> 应恢复而非重开
  const page = makePage([], null)
  page._init({ mode: 'all', subject: helpers.SUBJECT, chapter: '', ids: null, fresh: false })
  assert.strictEqual(page.data.total, 2, '队列应恢复为 2 题')
  assert.strictEqual(page.data.idx, 1, '进度应恢复到 qB')
  assert.strictEqual(page._sessionId, store.getPracticeSession().id, '复用同一会话 id')
  assert.strictEqual(page.data.submitted, false, '当前题 qB 未提交 -> 可作答')
})

test('评审 P2：_finish 标记会话完成，重建页面不再恢复已完成轮次', () => {
  const store = require('../utils/store.js')
  const helpers = require('./helpers.js')
  const bank = require('../utils/bank/index.js')
  const real = bank.filterQuestions({ subject: helpers.SUBJECT })
  store.createPracticeSession({ mode: 'all', subject: helpers.SUBJECT, questionIds: [real[0].id, real[1].id], params: { mode: 'all', subject: helpers.SUBJECT, chapter: '', ids: null } })
  store.submitAttempt({ id: real[0].id, type: real[0].type, answer: real[0].answer, subject: helpers.SUBJECT, chapter: real[0].chapter }, real[0].answer, true, 100, 'op-a')
  store.submitAttempt({ id: real[1].id, type: real[1].type, answer: real[1].answer, subject: helpers.SUBJECT, chapter: real[1].chapter }, real[1].answer, true, 100, 'op-b')
  const page = makePage([], null)
  page._init({ mode: 'all', subject: helpers.SUBJECT, chapter: '', ids: null, fresh: false })
  const firstId = page._sessionId
  page._load(1)
  page.onNext() // 末题再下一题 -> _finish
  assert.strictEqual(page.data.finished, true)
  assert.strictEqual(store.getPracticeSession().status, 'completed')
  // 重建页面：已完成轮次被恢复守卫排除，应开启新一轮（新的 in_progress 会话）
  const page2 = makePage([], null)
  page2._init({ mode: 'all', subject: helpers.SUBJECT, chapter: '', ids: null, fresh: false })
  assert.ok(page2._sessionId && page2._sessionId !== firstId, '已完成轮次不应被恢复')
})

test('评审 P2：登录切换存储作用域后 onShow 重建练习到新作用域（进度不归零）', () => {
  const store = require('../utils/store.js')
  const helpers = require('./helpers.js')
  const bank = require('../utils/bank/index.js')
  const user = require('../utils/user.js')
  user.requireLogin = () => true // 绕过真实登录重定向
  const real = bank.filterQuestions({ subject: helpers.SUBJECT })
  // 匿名作用域下已开始一轮并提交一题
  store.setUserScope('anon')
  store.createPracticeSession({ mode: 'all', subject: helpers.SUBJECT, questionIds: [real[0].id, real[1].id], params: { mode: 'all', subject: helpers.SUBJECT, chapter: '', ids: null } })
  store.submitAttempt({ id: real[0].id, type: real[0].type, answer: real[0].answer, subject: helpers.SUBJECT, chapter: real[0].chapter }, real[0].answer, true, 100, 'op-a')
  const page = makePage([], null)
  page._init({ mode: 'all', subject: helpers.SUBJECT, chapter: '', ids: null, fresh: false })
  page._scope = store.getUserScope() // 页面记忆此前作用域为 anon
  // 模拟登录：切换到 userX 作用域
  store.setUserScope('userX')
  store.setCurrentSubject(helpers.SUBJECT)
  page.onShow() // loadPending 无参数；作用域变化 -> 重建到新作用域
  assert.strictEqual(store.getUserScope(), 'userX')
  assert.ok(page._sessionId, '应已在新作用域创建/恢复会话')
  // 新作用域下提交应被计入进度（不再因沿用旧会话而归零）
  store.submitAttempt({ id: real[1].id, type: real[1].type, answer: real[1].answer, subject: helpers.SUBJECT, chapter: real[1].chapter }, real[1].answer, true, 100, 'op-b')
  const sess = store.getPracticeSession()
  assert.strictEqual(sess.sessionTotal, 1)
  assert.strictEqual(sess.sessionCorrect, 1)
})

test('评审 P2：登录切换作用域时保留此前已建立的 pending 单题练习请求（不丢题）', () => {
  const store = require('../utils/store.js')
  const helpers = require('./helpers.js')
  const bank = require('../utils/bank/index.js')
  const user = require('../utils/user.js')
  user.requireLogin = () => true
  const real = bank.filterQuestions({ subject: helpers.SUBJECT })
  const targetIds = [real[3].id]
  // 第一次：在 anon 作用域消费 pending 建立单题会话
  global.getApp().globalData.practiceParams = { mode: 'single', ids: targetIds, __stamp: 1111 }
  const page = makePage([], null)
  page.onShow()
  assert.strictEqual(page.data.mode, 'single')
  assert.strictEqual(page.data.total, 1, 'pending 单题请求应建立会话')
  // 第二次：登录切换到 userX，pending 已被消费，触发作用域重建
  store.setUserScope('userX')
  store.setCurrentSubject(helpers.SUBJECT)
  page.onShow()
  assert.strictEqual(store.getUserScope(), 'userX')
  assert.strictEqual(page.data.mode, 'single', '仍应为单题练习')
  assert.strictEqual(page.data.total, 1, '作用域切换后不应丢弃 pending 单题请求')
  assert.strictEqual(page.data.queue[0].id, targetIds[0])
  assert.ok(page._sessionId, '应在新作用域重建会话')
  // 清理注入的 pending，避免污染后续用例（app.startPractice 实际每次都会用新 __stamp 覆盖）
  global.getApp().globalData.practiceParams = null
})

test('评审 P2：清空学习数据后返回练习页应重建会话（不沿用已删除会话）', () => {
  const store = require('../utils/store.js')
  const helpers = require('./helpers.js')
  const bank = require('../utils/bank/index.js')
  const user = require('../utils/user.js')
  user.requireLogin = () => true
  const real = bank.filterQuestions({ subject: helpers.SUBJECT })
  store.createPracticeSession({ mode: 'all', subject: helpers.SUBJECT, questionIds: [real[0].id, real[1].id], params: { mode: 'all', subject: helpers.SUBJECT, chapter: '', ids: null } })
  const page = makePage([], null)
  page._init({ mode: 'all', subject: helpers.SUBJECT, chapter: '', ids: null, fresh: false })
  page._scope = store.getUserScope()
  const oldId = page._sessionId
  assert.ok(oldId)
  // 清空学习数据：删除持久化会话（作用域/科目不变）
  store.clearAll()
  assert.strictEqual(store.getPracticeSession(), null)
  // 返回练习页：应检测到持久化会话缺失并重建，而非沿用已删除会话
  page.onShow()
  assert.ok(page._sessionId, '应重建新会话')
  assert.notStrictEqual(page._sessionId, oldId, '不应沿用已删除会话')
  // 提交应落到新会话，进度可累加（不再归零）
  store.submitAttempt({ id: real[1].id, type: real[1].type, answer: real[1].answer, subject: helpers.SUBJECT, chapter: real[1].chapter }, real[1].answer, true, 100, 'op-x')
  const sess = store.getPracticeSession()
  assert.strictEqual(sess.sessionTotal, 1)
})

test('评审 P2：单题练习后从其它页面切换科目，返回练习应降级为整科练习（非空队列）', () => {
  const store = require('../utils/store.js')
  const helpers = require('./helpers.js')
  const bank = require('../utils/bank/index.js')
  const user = require('../utils/user.js')
  user.requireLogin = () => true
  const real = bank.filterQuestions({ subject: helpers.SUBJECT })
  store.setCurrentSubject(helpers.SUBJECT)
  // 从错题本进入单题练习（ids 指向当前科目某题）
  const page = makePage([], null)
  page._init({ mode: 'single', subject: helpers.SUBJECT, chapter: '', ids: [real[0].id], fresh: true })
  assert.strictEqual(page.data.mode, 'single')
  assert.strictEqual(page.data.total, 1)
  // 从其它页面切换全局科目到另一个有题的科目
  const other = bank.getSubjects().map((s) => s.name).find((s) => s !== helpers.SUBJECT)
  assert.ok(other, '测试数据应存在第二科目')
  assert.ok(bank.filterQuestions({ subject: other }).length > 0, '新科目应有题目')
  store.setCurrentSubject(other)
  // 返回练习页 onShow：_params.subject !== 全局科目 -> 降级 single 为 all（评审 P2）
  page.onShow()
  assert.strictEqual(page.data.mode, 'all', '跨科后应降级为整科练习')
  assert.ok(page.data.total > 0, '新科目下应有题目，队列非空')
})
