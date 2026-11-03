require('./wx-shim.js')
const { test } = require('node:test')
const assert = require('node:assert/strict')
const user = require('../utils/user.js')
const store = require('../utils/store.js')
const config = require('../utils/config.js')
const { createCommerceClient } = require('../utils/commerce-client.js')
const { createPreview } = require('../utils/commerce-preview.js')
const { createService } = require('../cloudfunctions/commerce/service.js')
const { harness, ADMIN_OPENID, ADMIN_TOKEN, USER_TOKEN } = require('./support/bank-harness.js')
const examDomain = require('../shared/exam-catalog-domain.js')
const subscriptions = require('../shared/subscription-domain.js')
const sample = require('../docs/examples/catalog-import.json')
const NOW = Date.parse('2026-10-30T06:00:00Z')
let definition
global.Page = value => { definition = value }
require('../pages/exam-plans/exam-plans.js')
const settle = () => new Promise(setImmediate)
function setup(t) {
  const h = harness(), bank = JSON.parse(JSON.stringify(sample.bank))
  bank.schemaVersion = 3; bank.manifest.exams = [{ id: 'exam_1', name: '示例考试' }]; bank.manifest.subjects[0].examId = 'exam_1'
  h.seedBank({ ...examDomain.buildExamRelease(bank), publicationRevision: 1 })
  h.config.set('commerceAdmins', { openids: [ADMIN_OPENID] })
  const service = createService({ db: h.db, now: () => NOW })
  let session = { logged: true, openid: 'normal-openid', token: USER_TOKEN }
  const client = createCommerceClient({ getSession: () => session, call: data => service(data, { OPENID: session.openid }) })
  t.mock.method(user, 'whenReady', cb => cb()); t.mock.method(user, 'isLogged', () => !!session.logged)
  t.mock.method(store, 'getCurrentExam', () => 'exam_1')
  const previous = config.commercePreview; config.commercePreview = true
  const p = Object.assign({}, definition, { data: JSON.parse(JSON.stringify(definition.data)), setData(value) { Object.assign(this.data, value) } })
  p.onLoad(); p._client = client; p.onShow()
  t.after(() => { p.onUnload(); config.commercePreview = previous })
  return { h, p, client, service, session: value => { session = value } }
}

test('真实套餐与有效期只读展示，模拟开通和答题不写订单或学习数据', async t => {
  const { h, p, service } = setup(t); await settle()
  const product = { id: subscriptions.productId('exam_1', 30), examId: 'exam_1', name: '考试月套餐', durationDays: 30, priceFen: 1980, active: true }
  await service({ action: 'putProduct', token: ADMIN_TOKEN, product, expectedRevision: 0 }, { OPENID: ADMIN_OPENID })
  await p.refresh(); assert.equal(p.data.exam.name, '示例考试'); assert.equal(p.data.plans[0].price, '19.80'); assert.equal(p.data.subscription.active, false)
  p.startDemo(); p.demoBuy(); assert.equal(p.data.demoActive, true)
  p.demoAnswer({ currentTarget: { dataset: { choice: 'B' } } }); assert.equal(p.data.answered, true)
  p.demoExpire(); assert.equal(p.data.demoActive, false)
  p.demoAnswer({ currentTarget: { dataset: { choice: 'B' } } }); assert.match(p.data.answerText, /结束/)
  assert.equal(h.collections.commerceOrders.size, 0); assert.equal(h.collections.commerceTimelines.size, 0)
  p.onHide(); assert.equal(p.data.demo, false); assert.equal(p._preview, null)
})

test('读取故障不显示空套餐；切换账号后的迟到响应不显示旧账号权益', async t => {
  const { h, p, session } = setup(t); await settle()
  h.fail.get = name => name === 'commerceProducts'; await p.refresh()
  assert.equal(p.data.loaded, false); assert.match(p.data.error, /失败/); assert.equal(p.data.subscription, null)
  h.fail.get = null
  let resolve; p._client.plans = () => new Promise(r => { resolve = r })
  const pending = p.refresh(); session({ logged: true, openid: ADMIN_OPENID, token: ADMIN_TOKEN })
  resolve({ exam: { id: 'exam_1', name: '旧账号' }, plans: [], subscription: { active: true, endAt: NOW + 1 } })
  await pending; assert.equal(p.data.loaded, false); assert.equal(p.data.subscription, null)
})

test('模拟续费、退款和到期使用隔离状态，不会影响正式权益', () => {
  const demo = createPreview(NOW)
  assert.throws(() => demo.answer('B'), /ENTITLEMENT_REQUIRED/)
  assert.equal(demo.buy(30).endAt, NOW + 30 * subscriptions.DAY_MS)
  assert.equal(demo.buy(90).endAt, NOW + 120 * subscriptions.DAY_MS)
  assert.equal(demo.refund().endAt, NOW + 30 * subscriptions.DAY_MS)
  assert.equal(demo.answer('B').correct, true)
  assert.equal(demo.expire().active, false); assert.throws(() => demo.answer('B'), /ENTITLEMENT_REQUIRED/)
  assert.equal(createPreview(NOW).state().active, false)
})
