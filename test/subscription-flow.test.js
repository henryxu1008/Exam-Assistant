const { test } = require('node:test')
const assert = require('node:assert/strict')
const { harness, ADMIN_TOKEN, USER_TOKEN, ADMIN_OPENID } = require('./support/bank-harness.js')
const { createService } = require('../cloudfunctions/commerce/service.js')
const { createSettlement } = require('../cloudfunctions/commerce/settlement.js')
const subscriptions = require('../shared/subscription-domain.js')
const examDomain = require('../shared/exam-catalog-domain.js')
const sample = require('../docs/examples/catalog-import.json')
const paged = require('../shared/paged-catalog-domain.js')
const accessPolicy = require('../shared/exam-access-policy.js')
const { createProtectedReader, POLICY_ID } = require('../cloudfunctions/bankSync/protected-reader.js')
const DAY = subscriptions.DAY_MS, NOW = Date.parse('2026-10-30T06:00:00Z')
const planId = subscriptions.productId('exam_1', 30)
const product = { id: planId, examId: 'exam_1', name: '合成套餐', priceFen: 9900, durationDays: 30, active: true }
function setup() {
  const h = harness(); let clock = NOW
  h.config.set('commerceAdmins', { openids: [ADMIN_OPENID] })
  const bank = JSON.parse(JSON.stringify(sample.bank)); bank.schemaVersion = 3
  bank.manifest.exams = [{ id: 'exam_1', name: '合成考试' }]; bank.manifest.subjects[0].examId = 'exam_1'
  h.seedBank({ ...examDomain.buildExamRelease(bank), publicationRevision: 1 })
  const service = createService({ db: h.db, allowOrders: true, now: () => clock })
  const settlement = createSettlement({ db: h.db, now: () => clock })
  const admin = event => service({ ...event, token: ADMIN_TOKEN }, { OPENID: ADMIN_OPENID })
  const user = event => service({ ...event, token: USER_TOKEN }, { OPENID: 'normal-openid' })
  return { h, admin, user, settlement, at: value => { clock = value } }
}

test('模拟两次购买、乱序回调和退款，续费顺延且账户查询隔离', async () => {
  const { h, admin, user, settlement, at } = setup()
  assert.equal((await admin({ action: 'putProduct', product, expectedRevision: 0 })).ok, true)
  const longer = { ...product, id: subscriptions.productId('exam_1', 90), durationDays: 90, priceFen: 19900 }
  assert.equal((await admin({ action: 'putProduct', product: longer, expectedRevision: 0 })).ok, true)
  const first = (await user({ action: 'createOrder', productId: planId, requestId: 'first' })).order
  const second = (await user({ action: 'createOrder', productId: longer.id, requestId: 'second' })).order
  const ev1 = { orderId: first.id, ownerId: 'normal-openid', transactionId: 'tx1', amountFen: 9900, paidAt: NOW }
  const ev2 = { ...ev1, orderId: second.id, transactionId: 'tx2', amountFen: 19900, paidAt: NOW + 1 }
  at(NOW + 2)
  await settlement.confirmVerifiedPayment(ev2); await settlement.confirmVerifiedPayment(ev1)
  let status = await user({ action: 'getSubscription', examId: 'exam_1' })
  assert.equal(status.active, true); assert.equal(status.endAt, NOW + 2 + 120 * DAY)
  assert.equal((await admin({ action: 'getSubscription', examId: 'exam_1' })).active, false)
  assert.deepEqual(await settlement.confirmVerifiedPayment(ev1), await settlement.confirmVerifiedPayment(ev1))
  at(NOW + 10 * DAY)
  await settlement.confirmVerifiedFullRefund({ orderId: second.id, transactionId: 'tx2', refundId: 'refund2', amountFen: 19900, refundedAt: NOW + 10 * DAY })
  status = await user({ action: 'getSubscription', examId: 'exam_1' })
  assert.equal(status.active, true); assert.equal(status.endAt, NOW + 40 * DAY)
  const timeline = h.collections.commerceTimelines.get(subscriptions.timelineId('normal-openid', 'exam_1'))
  assert.equal(timeline.periods.find(period => period.orderId === first.id).startAt, NOW + 10 * DAY)
  assert.equal((await settlement.confirmVerifiedPayment(ev2)).order.status, 'refunded')
})

test('预留和结算写失败时整笔回滚；时间线损坏不当作空订阅', async () => {
  const { h, admin, user, settlement, at } = setup()
  await admin({ action: 'putProduct', product, expectedRevision: 0 })
  h.fail.write = name => name === 'commerceTimelines'
  assert.equal((await user({ action: 'createOrder', productId: planId, requestId: 'first' })).error, 'COMMERCE_FAILED')
  assert.equal(h.collections.commerceOrders.size, 0); assert.equal(h.collections.commerceTimelines.size, 0)
  h.fail.write = null
  const order = (await user({ action: 'createOrder', productId: planId, requestId: 'first' })).order
  const key = subscriptions.timelineId('normal-openid', 'exam_1'), before = JSON.stringify(h.collections.commerceTimelines.get(key))
  at(NOW + 10); h.fail.write = name => name === 'commerceTimelines'
  const evidence = { orderId: order.id, ownerId: 'normal-openid', transactionId: 'tx1', amountFen: 9900, paidAt: NOW }
  await assert.rejects(settlement.confirmVerifiedPayment(evidence))
  h.fail.write = null
  assert.equal(h.collections.commerceOrders.get(order.id).status, 'pending')
  assert.equal(h.collections.commerceEvents.size, 0); assert.equal(h.collections.commerceGrants.size, 0)
  assert.equal(JSON.stringify(h.collections.commerceTimelines.get(key)), before)
  h.collections.commerceTimelines.get(key).digest = 'broken'
  assert.equal((await user({ action: 'getSubscription', examId: 'exam_1' })).error, 'INVALID_SUBSCRIPTION')
  assert.equal((await user({ action: 'createOrder', productId: planId, requestId: 'second' })).error, 'INVALID_SUBSCRIPTION')
})

test('支付、续费与退款联动受保护题库，退款写入故障不改变原权益', async () => {
  const { h, admin, user, settlement, at } = setup()
  await admin({ action: 'putProduct', product, expectedRevision: 0 })
  const first = (await user({ action: 'createOrder', productId: planId, requestId: 'first' })).order
  const second = (await user({ action: 'createOrder', productId: planId, requestId: 'second' })).order
  const event = (order, transactionId) => ({ orderId: order.id, ownerId: 'normal-openid', transactionId, amountFen: 9900, paidAt: NOW })
  const bank = JSON.parse(JSON.stringify(sample.bank)); bank.schemaVersion = 4
  bank.manifest.exams = [{ id: 'exam_1', name: '合成考试' }]; bank.manifest.subjects[0].examId = 'exam_1'
  const built = paged.buildPagedCatalog({ ...bank, sources: sample.sources })
  h.seedBank({ schemaVersion: 4, root: built.root, publicationRevision: 1 })
  h.documents.set(built.root.releaseId, { kind: 'pagedQuestionBankRelease', root: built.root, publishedAt: 1 })
  for (const page of built.publicPages) h.documents.set(paged.pageDocumentId(page.releaseId, page.index), { kind: 'pagedQuestionBankPage', page })
  h.config.set(POLICY_ID, accessPolicy.buildPolicy(built.root, 1, [{ examId: 'exam_1', access: 'paid' }]))
  const reader = createProtectedReader({ db: h.db, now: () => NOW + 10 * DAY })
  const request = { token: USER_TOKEN, examId: 'exam_1', releaseId: built.root.releaseId, index: 0 }
  const read = () => reader(request, { OPENID: 'normal-openid' })
  assert.equal((await read()).error, 'ENTITLEMENT_REQUIRED')
  await settlement.confirmVerifiedPayment(event(first, 'tx1'))
  await settlement.confirmVerifiedPayment(event(second, 'tx2'))
  assert.equal((await read()).ok, true)
  at(NOW + 10 * DAY)
  const refund = { orderId: first.id, transactionId: 'tx1', refundId: 'refund1', amountFen: 9900, refundedAt: NOW + 10 * DAY }
  h.fail.write = name => name === 'commerceTimelines'
  await assert.rejects(settlement.confirmVerifiedFullRefund(refund))
  h.fail.write = null
  assert.equal((await user({ action: 'getSubscription', examId: 'exam_1' })).endAt, NOW + 60 * DAY)
  assert.equal((await read()).ok, true)
  await settlement.confirmVerifiedFullRefund(refund)
  assert.equal((await user({ action: 'getSubscription', examId: 'exam_1' })).endAt, NOW + 40 * DAY)
  assert.equal((await read()).ok, true)
  await settlement.confirmVerifiedFullRefund({ ...refund, orderId: second.id, transactionId: 'tx2', refundId: 'refund2' })
  assert.equal((await read()).error, 'ENTITLEMENT_REQUIRED')
})
