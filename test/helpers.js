/**
 * 测试公共件：在注入 wx shim 后，提供「每次全新加载 store」的隔离辅助。
 * 通过清除 require 缓存 + 清空内存存储，保证用例之间互不串扰。
 */

require('./wx-shim.js')

const bank = require('../utils/bank/index.js')

const DAY = 86400000
// 固定基准日，避免依赖运行机器的真实日期
const BASE = new Date('2026-10-29T10:00:00').getTime()
const SUBJECT = bank.getSubjects()[0].name

const CACHE_KEYS = [
  '../utils/store.js',
  '../utils/analytics.js',
  '../utils/questions.js',
  '../utils/bank/index.js',
  '../utils/bank/manifest.js',
  '../utils/bank/gk.js',
  '../utils/bank/nl.js',
  '../utils/bank/it.js'
]

function freshStore(seed) {
  // 先取消上一个 store 实例遗留的节流定时器：它引用的还是旧模块闭包，
  // 一旦在后续用例中触发，就会用当前用例的 wx mock 发出请求，污染断言。
  try {
    const prev = require('../utils/store.js')
    if (prev && typeof prev.__clearFlushTimer === 'function') prev.__clearFlushTimer()
  } catch (e) {
    /* 首个用例尚无实例 */
  }
  global.__wxStorage.clearAll()
  // 默认作用域为 'anon'，故按匿名作用域 key 播种（store 现按用户命名空间隔离）
  if (seed) global.__wxStorage.setRaw('exam_quiz_data_v1__anon', seed)
  CACHE_KEYS.forEach((m) => {
    try {
      delete require.cache[require.resolve(m)]
    } catch (e) {
      /* 模块尚未加载则忽略 */
    }
  })
  return require('../utils/store.js')
}

/** 构造一条属于「当前科目」的单选题，便于统计/错题/复习测试 */
function q(id, chapter) {
  return { id, subject: SUBJECT, chapter: chapter || '默认章节', type: 'single', answer: ['A'] }
}

module.exports = { freshStore, q, SUBJECT, DAY, BASE }
