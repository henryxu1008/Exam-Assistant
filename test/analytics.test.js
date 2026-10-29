/**
 * Issue 4：analytics 学情统计测试
 * 覆盖：薄弱项门槛（正确率<60% 且至少 2 题）、优势项门槛、总体概览、错题顽固判定。
 */
const { test } = require('node:test')
const assert = require('node:assert')
const helpers = require('./helpers.js')
const { freshStore, q } = helpers

test('weakPoints 命中「正确率<60% 且至少 2 题」的章节', () => {
  const store = freshStore()
  // 章节弱：2 次全错 -> rate 0
  store.recordAnswer(q('w1', '弱章节'), false, 100)
  store.recordAnswer(q('w2', '弱章节'), false, 100)
  // 章节强：2 次全对 -> rate 100
  store.recordAnswer(q('s1', '强章节'), true, 100)
  store.recordAnswer(q('s2', '强章节'), true, 100)
  // 章节样本不足：仅 1 次 -> 不纳入薄弱
  store.recordAnswer(q('n1', '样本不足章节'), false, 100)

  const weak = require('../utils/analytics.js').weakPoints()
  const weakChapters = weak.map((x) => x.chapter)
  assert.ok(weakChapters.includes('弱章节'))
  assert.ok(!weakChapters.includes('强章节'))
  assert.ok(!weakChapters.includes('样本不足章节'))
})

test('overview 汇总正确率与错题数', () => {
  const store = freshStore()
  store.recordAnswer(q('a', 'c1'), true, 100)
  store.recordAnswer(q('b', 'c1'), true, 100)
  store.recordAnswer(q('c', 'c1'), false, 100)
  const ov = require('../utils/analytics.js').overview()
  assert.strictEqual(ov.total, 3)
  assert.strictEqual(ov.correct, 2)
  assert.strictEqual(ov.rate, Math.round((2 / 3) * 100))
  assert.strictEqual(ov.wrongCount, 1)
  assert.strictEqual(ov.stubbornCount, 0) // 错 1 次不算顽固
})

test('stubbornQuestions 仅含错误>=2 的题', () => {
  const store = freshStore()
  const bank = require('../utils/bank/index.js')
  // 取当前科目下两道真实题目（stubbornQuestions 会反查题库，必须用真实 id）
  const real = bank.filterQuestions({ subject: helpers.SUBJECT })
  const qa = real[0]
  const qb = real[1]
  store.recordAnswer(qa, false, 100)
  store.recordAnswer(qa, false, 100) // 错 2 次 -> 顽固
  store.recordAnswer(qb, false, 100) // 错 1 次 -> 非顽固
  const stub = require('../utils/analytics.js').stubbornQuestions()
  assert.ok(stub.some((x) => x.record.id === qa.id))
  assert.ok(!stub.some((x) => x.record.id === qb.id))
})
