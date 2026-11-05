require('./wx-shim.js')
const { test } = require('node:test')
const assert = require('node:assert/strict')
const config = require('../utils/config.js'), bank = require('../utils/questions.js')
const user = require('../utils/user.js')
test('受保护模式屏蔽旧题库接口及云端批量载入，关闭时恢复既有行为', async t => {
  const previous = config.protectedCatalog; t.after(() => { config.protectedCatalog = previous })
  config.protectedCatalog = false
  const questions = bank.getAllQuestions(); assert.ok(questions.length)
  assert.ok(bank.findQuestion(questions[0].id))
  config.protectedCatalog = true
  assert.deepEqual(bank.getAllQuestions(), []); assert.equal(bank.findQuestion(questions[0].id), null)
  assert.deepEqual(bank.QUESTIONS, []); assert.deepEqual(bank.getExams(), []); assert.deepEqual(bank.getSubjects(), [])
  assert.deepEqual(bank.getChapters(), []); assert.deepEqual(bank.getQuestionsByIds([questions[0].id]), [])
  assert.deepEqual(bank.filterQuestions({}), []); assert.equal(await bank.loadCloudBank(), false); assert.equal(await bank.pushStaticBankToCloud({ force: true }), false)
  config.protectedCatalog = false; assert.equal(bank.findQuestion(questions[0].id).id, questions[0].id)
})
test('切入受保护模式清除 AI 页显示并丢弃在途回复', t => {
  const previous = config.protectedCatalog; t.after(() => { config.protectedCatalog = previous })
  const app = { globalData: { aiPreInput: 'secret', aiContext: { questionId: 'A' } } }; global.getApp = () => app
  let page; global.Page = def => { page = def }; const path = require.resolve('../pages/ai/ai.js'); delete require.cache[path]; require(path)
  const p = Object.assign({}, page, { data: { ...page.data, messages: [{ text: 'old question' }], input: 'old' }, setData(v) { Object.assign(this.data, v) } })
  t.mock.method(user, 'whenReady', () => { throw new Error('should not read AI history') })
  config.protectedCatalog = true; p.onShow()
  assert.equal(p.data.protectedUnavailable, true); assert.deepEqual(p.data.messages, []); assert.equal(app.globalData.aiContext, null)
  assert.equal(p._isCurrentReply(p._reqToken), false); p.send('old question', {}); assert.deepEqual(p.data.messages, [])
  delete require.cache[path]
})
