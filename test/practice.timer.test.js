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
global.getApp = () => ({ globalData: {} })

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
