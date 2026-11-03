const { test } = require('node:test')
const assert = require('node:assert/strict')
const { harness, ADMIN_TOKEN, USER_TOKEN, ADMIN_OPENID } = require('./support/bank-harness.js')
const { createService } = require('../cloudfunctions/commerce/service.js')
const { createSettlement } = require('../cloudfunctions/commerce/settlement.js')
const examDomain = require('../shared/exam-catalog-domain.js')
const pagedDomain = require('../shared/paged-catalog-domain.js')
const sample = require('../docs/examples/catalog-import.json')
const NOW = Date.parse('2026-10-30T06:00:00Z')
const adminCtx = { OPENID: ADMIN_OPENID }, userCtx = { OPENID: 'normal-openid' }
const product = { id: 'p1', examId: 'exam_1', name: '合成考试', priceFen: 9900, durationDays: 180, active: true }
function setup(allowOrders = true) {
  const h = harness(), service = createService({ db: h.db, allowOrders, now: () => NOW })
  const settlement = createSettlement({ db: h.db, now: () => NOW + 10000 })
  h.config.set('commerceAdmins', { openids: [ADMIN_OPENID] })
  const bank = JSON.parse(JSON.stringify(sample.bank))
  bank.schemaVersion = 3; bank.manifest.exams = [{ id: 'exam_1', name: '合成考试' }]; bank.manifest.subjects[0].examId = 'exam_1'
  h.seedBank({ ...examDomain.buildExamRelease(bank), publicationRevision: 1 })
  const admin = data => service({ ...data, token: ADMIN_TOKEN }, adminCtx)
  const user = data => service({ ...data, token: USER_TOKEN }, userCtx)
  return { h, service, settlement, admin, user }
}

test('商品只允许管理员修改，版本冲突和数据库读取失败不能覆盖原配置', async () => {
  const { h, admin, user } = setup()
  assert.equal((await user({ action: 'putProduct', product, expectedRevision: 0 })).error, 'NOT_ADMIN')
  assert.equal((await admin({ action: 'putProduct', product, expectedRevision: 0 })).ok, true)
  assert.equal((await admin({ action: 'putProduct', product: { ...product, priceFen: 1 }, expectedRevision: 0 })).error, 'STALE_PRODUCT')
  assert.equal((await admin({ action: 'putProduct', product: { ...product, examId: 'other' }, expectedRevision: 1 })).error, 'PRODUCT_EXAM_IMMUTABLE')
  h.fail.get = (name, id) => name === 'commerceProducts' && id === 'p1'
  assert.equal((await admin({ action: 'putProduct', product: { ...product, priceFen: 1 }, expectedRevision: 1 })).error, 'COMMERCE_FAILED')
  assert.equal(h.collections.commerceProducts.get('p1').priceFen, 9900)
})

test('管理端只读取有效发布的考试，草稿考试及坏题库不允许配置商品', async () => {
  const { h, admin, user } = setup()
  assert.equal((await user({ action: 'getManageCatalog' })).error, 'NOT_ADMIN')
  assert.deepEqual((await admin({ action: 'getManageCatalog' })).exams, [{ id: 'exam_1', name: '合成考试' }])
  assert.equal((await admin({ action: 'putProduct', product: { ...product, examId: 'draft' }, expectedRevision: 0 })).error, 'EXAM_NOT_FOUND')
  const bank = h.bank(), built = pagedDomain.buildPagedCatalog({ ...bank, schemaVersion: 4, sources: sample.sources })
  h.seedBank({ schemaVersion: 4, root: built.root, publicationRevision: 2 })
  assert.equal((await admin({ action: 'getManageCatalog' })).exams[0].id, 'exam_1')
  h.seedBank({ schemaVersion: 4, root: { ...built.root, releaseId: 'corrupt' }, publicationRevision: 2 })
  assert.equal((await admin({ action: 'getManageCatalog' })).error, 'INVALID_PUBLISHED_CATALOG')
  assert.equal((await admin({ action: 'putProduct', product, expectedRevision: 0 })).error, 'INVALID_PUBLISHED_CATALOG')
  assert.equal(h.collections.commerceProducts.size, 0)
})

test('身份绑定微信账号并在事务内重验，关闭购买时不能建单或伪造付款', async () => {
  const { h, service, admin, user } = setup(false)
  await admin({ action: 'putProduct', product, expectedRevision: 0 })
  assert.equal((await user({ action: 'createOrder', productId: 'p1', requestId: 'req_1' })).error, 'COMMERCE_DISABLED')
  assert.equal((await user({ action: 'confirmVerifiedPayment' })).error, 'BAD_ACTION')
  assert.equal((await service({ action: 'getProduct', productId: 'p1', token: USER_TOKEN }, adminCtx)).error, 'INVALID_TOKEN')
  h.fail.beforeTransaction = () => { h.users.get('u1').token = 'revoked' }
  assert.equal((await user({ action: 'getProduct', productId: 'p1' })).error, 'INVALID_TOKEN')
  assert.equal(h.collections.commerceOrders.size, 0)
})

test('模拟并发下单幂等，价格来自服务端，重试保持原快照且账号隔离', async () => {
  const { h, admin, user } = setup()
  await admin({ action: 'putProduct', product, expectedRevision: 0 })
  const make = () => user({ action: 'createOrder', productId: 'p1', requestId: 'req_1', priceFen: 1, ownerId: ADMIN_OPENID })
  const [a, b] = await Promise.all([make(), make()])
  assert.equal(a.ok, true); assert.deepEqual(a, b); assert.equal(a.order.product.priceFen, 9900)
  assert.equal(h.collections.commerceOrders.size, 1)
  await admin({ action: 'putProduct', product: { ...product, priceFen: 200 }, expectedRevision: 1 })
  assert.deepEqual(await make(), a)
  assert.equal((await admin({ action: 'getOrder', orderId: a.order.id })).error, 'ORDER_NOT_FOUND')
  assert.equal((await user({ action: 'createOrder', productId: 'other', requestId: 'req_1' })).error, 'ORDER_CONFLICT')
})

test('合成支付和退款只可由内部服务确认，事务故障回滚且交易号不能跨订单重用', async () => {
  const { h, admin, user, settlement } = setup()
  await admin({ action: 'putProduct', product, expectedRevision: 0 })
  const first = (await user({ action: 'createOrder', productId: 'p1', requestId: 'req_1' })).order
  const second = (await user({ action: 'createOrder', productId: 'p1', requestId: 'req_2' })).order
  const evidence = { orderId: first.id, ownerId: userCtx.OPENID, amountFen: 9900, transactionId: 'tx_1', paidAt: NOW + 100 }
  h.fail.write = name => name === 'commerceGrants'
  await assert.rejects(settlement.confirmVerifiedPayment(evidence))
  assert.equal(h.collections.commerceOrders.get(first.id).status, 'pending'); assert.equal(h.collections.commerceEvents.size, 0)
  h.fail.write = null
  const [paid, replay] = await Promise.all([settlement.confirmVerifiedPayment(evidence), settlement.confirmVerifiedPayment(evidence)])
  assert.deepEqual(paid, replay); assert.equal(h.collections.commerceGrants.size, 1)
  await assert.rejects(settlement.confirmVerifiedPayment({ ...evidence, orderId: second.id }), /EVENT_CONFLICT/)
  h.collections.commerceGrants.delete(first.id)
  await assert.rejects(settlement.confirmVerifiedPayment(evidence), /INVALID_GRANT/)
  assert.equal(h.collections.commerceGrants.size, 0, '重放不能把损坏状态当作未发货补写')
  h.collections.commerceGrants.set(first.id, paid.grant)
  const refund = { orderId: first.id, transactionId: 'tx_1', refundId: 'refund_1', amountFen: 9900, refundedAt: NOW + 200 }
  h.fail.write = name => name === 'commerceEvents'
  await assert.rejects(settlement.confirmVerifiedFullRefund(refund))
  assert.equal(h.collections.commerceGrants.get(first.id).revoked, false)
  h.fail.write = null
  await settlement.confirmVerifiedFullRefund(refund)
  assert.equal(h.collections.commerceOrders.get(first.id).status, 'refunded')
  assert.equal(h.collections.commerceGrants.get(first.id).revoked, true)
  const latePayment = await settlement.confirmVerifiedPayment(evidence)
  assert.equal(latePayment.order.status, 'refunded'); assert.equal(latePayment.grant.revoked, true)
  assert.deepEqual(await settlement.confirmVerifiedFullRefund(refund), latePayment)
  assert.equal(h.collections.commerceOrders.get(second.id).status, 'pending')
})
