/**
 * AI 助教回归测试：
 * - 个性化查询（正确率/薄弱/计划/错题/记忆方法）必须走本地引擎，基于真实答题数据作答
 * - 远端请求（开启时）应携带学习者数据快照，使大模型也能基于真实数据回答
 * 用轻量 page / cloud 桩验证，无需完整小程序运行时。
 */
require('./wx-shim.js')
const { test } = require('node:test')
const assert = require('node:assert')

let capturedPage = null
global.Page = (def) => { capturedPage = def }
const __app = { globalData: {} }
global.getApp = () => __app

require('../pages/ai/ai.js')

function makePage() {
  const page = Object.assign({}, capturedPage)
  page.data = Object.assign({}, capturedPage.data)
  page.setData = function (patch) { Object.assign(this.data, patch) }
  page._timer = null
  return page
}

test('isPersonalizedQuery 识别依赖真实数据的查询', () => {
  const ai = require('../utils/ai.js')
  assert.strictEqual(ai.isPersonalizedQuery('我的正确率多少'), true)
  assert.strictEqual(ai.isPersonalizedQuery('我哪里最薄弱'), true)
  assert.strictEqual(ai.isPersonalizedQuery('帮我制定今天的学习计划'), true)
  assert.strictEqual(ai.isPersonalizedQuery('错题怎么复习'), true)
  assert.strictEqual(ai.isPersonalizedQuery('这道题怎么解'), false)
  assert.strictEqual(ai.isPersonalizedQuery('你好'), false)
})

test('requestLLM 在远端请求中注入学习者数据快照（评审 P2）', () => {
  const ai = require('../utils/ai.js')
  let captured = null
  global.wx.cloud = {
    callFunction: (p) => { captured = p; return Promise.resolve({ result: { content: 'ok' } }) }
  }
  ai.REMOTE_LLM.enabled = true
  return ai
    .requestLLM([{ role: 'user', content: '你好' }], '公共基础知识', {})
    .then(() => {
      ai.REMOTE_LLM.enabled = false
      assert.ok(captured, '应发起云端调用')
      const sys = (captured.data.messages || []).filter((m) => m.role === 'system')
      assert.ok(sys.some((m) => /学习者当前数据快照/.test(m.content)), '远端请求应携带学习者数据快照')
    })
})

test('chat 正确率查询返回含真实数据的要点', () => {
  const ai = require('../utils/ai.js')
  const r = ai.chat('我的正确率多少', {})
  assert.ok(r.bullets.some((b) => /正确率/.test(b)), '应基于真实数据给出正确率要点')
})

test('评审 P2：个性化查询走本地引擎，页面落到含真实数据的回复', () => {
  const ai = require('../utils/ai.js')
  const page = makePage()
  page.send('我的正确率多少', {})
  assert.strictEqual(page.data.loading, true)
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      try {
        const msgs = page.data.messages
        const last = msgs[msgs.length - 1]
        assert.strictEqual(last.role, 'ai')
        assert.ok(last.bullets.some((b) => /正确率/.test(b)), '应落在本地的真实数据回复')
        resolve()
      } catch (e) {
        reject(e)
      }
    }, 600)
  })
})
