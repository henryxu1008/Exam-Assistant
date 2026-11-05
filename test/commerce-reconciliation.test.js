const { test } = require('node:test'), assert = require('node:assert/strict')
const { harness, ADMIN_TOKEN, USER_TOKEN, ADMIN_OPENID } = require('./support/bank-harness.js')
const { createService } = require('../cloudfunctions/commerce/service.js')
const { createSettlement } = require('../cloudfunctions/commerce/settlement.js')
const { createReconciler } = require('../cloudfunctions/commerce/reconciliation.js')
const exam = require('../shared/exam-catalog-domain.js'), subscription = require('../shared/subscription-domain.js')
const sample = require('../docs/examples/catalog-import.json'), NOW = Date.parse('2026-10-30T06:00:00Z')
async function setup() {
  const h = harness(), bank = JSON.parse(JSON.stringify(sample.bank)), productId = subscription.productId('exam_a', 30)
  bank.schemaVersion = 3; bank.manifest.exams = [{ id: 'exam_a', name: '测试' }]; bank.manifest.subjects[0].examId = 'exam_a'
  h.seedBank({ ...exam.buildExamRelease(bank), publicationRevision: 1 }); h.config.set('commerceAdmins', { openids: [ADMIN_OPENID] })
  const service = createService({ db: h.db, allowOrders: true, now: () => NOW })
  const settlement = createSettlement({ db: h.db, now: () => NOW + 1000 })
  const product = { id: productId, examId: 'exam_a', name: '合成套餐', priceFen: 100, durationDays: 30, active: true }
  assert.equal((await service({ action: 'putProduct', token: ADMIN_TOKEN, product, expectedRevision: 0 }, { OPENID: ADMIN_OPENID })).ok, true)
  const order = (await service({ action: 'createOrder', token: USER_TOKEN, productId, requestId: 'request1' }, { OPENID: 'normal-openid' })).order
  const base = { orderId: order.id, ownerId: order.ownerId, amountFen: 100, currency: 'CNY', productId, transactionId: 'pay1', paidAt: NOW + 10 }
  let remote = { ...base, status: 'paid' }, throwQuery = false, calls = 0
  const reconcile = createReconciler({ db: h.db, settlement, queryVerified: async id => {
    calls++; assert.equal(id, order.id)
    if (throwQuery) throw new Error('injected timeout')
    return remote
  } })
  return { h, order, base, reconcile, settlement, service, setRemote: value => { remote = value }, failQuery: value => { throwQuery = value }, calls: () => calls }
}
test('已验证的合成支付查询可以补全丢失通知，重复对账不重复发放', async () => {
  const { h, order, reconcile } = await setup()
  const [a, b] = await Promise.all([reconcile(order.id), reconcile(order.id)])
  assert.equal(a.status, 'paid'); assert.equal(b.status, 'paid')
  assert.equal(h.collections.commerceOrders.get(order.id).status, 'paid')
  assert.equal(h.collections.commerceGrants.size, 1); assert.equal(h.collections.commerceEvents.size, 1)
  assert.equal([...h.collections.commerceTimelines.values()][0].periods.length, 1)
})
test('查单失败、身份金额商品不符、未知状态均不能开通或释放预留', async () => {
  const { h, order, base, reconcile, setRemote, failQuery } = await setup()
  failQuery(true); await assert.rejects(reconcile(order.id), /PROVIDER_QUERY_FAILED/); failQuery(false)
  for (const change of [{ ownerId: 'other' }, { amountFen: 1 }, { productId: 'other' }, { orderId: 'wrong' }, { currency: 'USD' }]) {
    setRemote({ ...base, status: 'paid', ...change }); await assert.rejects(reconcile(order.id), /PROVIDER_ORDER_MISMATCH/)
  }
  setRemote({ ...base, status: 'paid', transactionId: '' }); await assert.rejects(reconcile(order.id), /INVALID_PROVIDER_EVIDENCE/)
  setRemote({ ...base, status: 'unknown' }); assert.equal((await reconcile(order.id)).status, 'unknown')
  setRemote({ ...base, status: 'closed' }); assert.equal((await reconcile(order.id)).status, 'provider_closed')
  assert.equal(h.collections.commerceOrders.get(order.id).status, 'pending')
  assert.equal(h.collections.commerceGrants.size, 0); assert.equal([...h.collections.commerceTimelines.values()][0].reservations.length, 1)
})
test('先看到退款而本地尚无支付时要求人工核对，不临时发放权益', async () => {
  const { h, order, base, reconcile, setRemote } = await setup()
  setRemote({ ...base, status: 'refunded', refundId: 'r1', refundAmountFen: 100, refundedAt: NOW + 50 })
  assert.equal((await reconcile(order.id)).status, 'manual_review')
  assert.equal(h.collections.commerceOrders.get(order.id).status, 'pending'); assert.equal(h.collections.commerceGrants.size, 0)
})
test('已支付后可核对全额退款，退款后支付旧结果不会重新开通', async () => {
  const { h, order, base, reconcile, setRemote } = await setup()
  await reconcile(order.id)
  setRemote({ ...base, status: 'refunded', refundId: 'r1', refundAmountFen: 100, refundedAt: NOW + 50 })
  assert.equal((await reconcile(order.id)).status, 'refunded'); assert.equal((await reconcile(order.id)).status, 'refunded')
  setRemote({ ...base, status: 'paid' }); assert.equal((await reconcile(order.id)).status, 'conflict')
  assert.equal(h.collections.commerceOrders.get(order.id).status, 'refunded'); assert.equal(h.collections.commerceGrants.get(order.id).revoked, true)
})
test('本地读取或事务写失败不能把订单当成不存在或声称对账成功', async () => {
  const { h, order, reconcile, calls } = await setup()
  h.fail.get = name => name === 'commerceOrders'; await assert.rejects(reconcile(order.id)); assert.equal(calls(), 0)
  h.fail.get = null; h.fail.write = name => name === 'commerceEvents'; await assert.rejects(reconcile(order.id))
  assert.equal(h.collections.commerceOrders.get(order.id).status, 'pending'); assert.equal(h.collections.commerceGrants.size, 0)
})


test('对账服务不是客户端可调用 action，未经真实适配器不能启用', async () => {
  const { h, order, service } = await setup()
  assert.equal((await service({ action: 'reconcile', token: USER_TOKEN, orderId: order.id }, { OPENID: 'normal-openid' })).error, 'BAD_ACTION')
  assert.throws(() => createReconciler({ db: h.db, settlement: {} }), /RECONCILER_NOT_CONFIGURED/)
  assert.equal(h.collections.commerceOrders.get(order.id).status, 'pending')
})

test('支付时间早于下单、未来时间、未知供应商状态不会触发权益', async () => {
  const { h, order, base, reconcile, setRemote } = await setup()
  setRemote({ ...base, status: 'paid', paidAt: NOW - 1 }); await assert.rejects(reconcile(order.id), /PAYMENT_MISMATCH/)
  setRemote({ ...base, status: 'paid', paidAt: NOW + 1001 }); await assert.rejects(reconcile(order.id), /BAD_EVIDENCE/)
  setRemote({ ...base, status: 'success' }); await assert.rejects(reconcile(order.id), /INVALID_PROVIDER_EVIDENCE/)
  assert.equal(h.collections.commerceOrders.get(order.id).status, 'pending'); assert.equal(h.collections.commerceGrants.size, 0)
})


test('部分退款或未确认退款金额不能被当成全额退款并撤销权益', async () => {
  const { h, order, base, reconcile, setRemote } = await setup(); await reconcile(order.id)
  for (const refundAmountFen of [undefined, 0, 50, 101]) {
    setRemote({ ...base, status: 'refunded', refundId: 'r1', refundAmountFen, refundedAt: NOW + 50 })
    await assert.rejects(reconcile(order.id), /INVALID_PROVIDER_EVIDENCE/)
  }
  assert.equal(h.collections.commerceOrders.get(order.id).status, 'paid')
  assert.equal(h.collections.commerceGrants.get(order.id).revoked, false)
})
