/** Pure commerce rules. Persistence, authenticated identity and payment verification are separate trusted boundaries. */
const DAY_MS = 86400000
const fail = code => { throw Object.assign(new Error(code), { code }) }
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(value)
const time = value => Number.isSafeInteger(value) && value >= 0
const label = value => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 120

function validProduct(product) {
  return !!product && id(product.id) && id(product.examId) && label(product.name) &&
    Number.isSafeInteger(product.priceFen) && product.priceFen > 0 && product.priceFen <= 100000000 &&
    Number.isSafeInteger(product.durationDays) && product.durationDays > 0 && product.durationDays <= 3650 &&
    Number.isSafeInteger(product.revision) && product.revision > 0 && typeof product.active === 'boolean'
}

// ownerId, product and orderId must come from authenticated server state, not from a client-supplied price or identity.
function createOrder({ orderId, ownerId, product, now }) {
  if (!id(orderId) || !id(ownerId) || !time(now)) fail('BAD_ORDER')
  if (!validProduct(product) || !product.active) fail('PRODUCT_UNAVAILABLE')
  return { id: orderId, ownerId, product: { id: product.id, examId: product.examId, name: product.name,
    priceFen: product.priceFen, durationDays: product.durationDays, revision: product.revision },
  status: 'pending', createdAt: now }
}

// evidence is accepted only from an adapter that verifies provider authenticity and confirms payment.
// Caller must atomically persist the returned order and grant and enforce unique provider transaction IDs.
function confirmPayment(order, evidence, deliveredStartAt = evidence && evidence.paidAt) {
  if (!order || !evidence || !id(evidence.transactionId) || !time(evidence.paidAt) ||
      evidence.orderId !== order.id || evidence.ownerId !== order.ownerId || evidence.amountFen !== order.product.priceFen ||
      evidence.paidAt < order.createdAt) fail('PAYMENT_MISMATCH')
  if (order.status === 'paid') {
    if (order.transactionId !== evidence.transactionId || order.paidAt !== evidence.paidAt) fail('PAYMENT_CONFLICT')
    return { order, grant: grantFromOrder(order) }
  }
  if (order.status !== 'pending') fail('ORDER_NOT_PAYABLE')
  if (!time(deliveredStartAt) || deliveredStartAt < evidence.paidAt) fail('PAYMENT_MISMATCH')
  const endAt = deliveredStartAt + order.product.durationDays * DAY_MS
  if (!Number.isSafeInteger(endAt)) fail('BAD_EXPIRY')
  const paid = { ...order, status: 'paid', transactionId: evidence.transactionId, paidAt: evidence.paidAt, startAt: deliveredStartAt, endAt }
  return { order: paid, grant: grantFromOrder(paid) }
}

function grantFromOrder(order) {
  return { orderId: order.id, ownerId: order.ownerId, examId: order.product.examId,
    startAt: order.startAt, endAt: order.endAt, revoked: order.status === 'refunded' }
}

// Full refunds only. Verification and the atomic order/grant update belong to the caller.
function confirmFullRefund(order, evidence) {
  if (!order || !evidence || !id(evidence.refundId) || !time(evidence.refundedAt) ||
      evidence.orderId !== order.id || evidence.transactionId !== order.transactionId ||
      evidence.amountFen !== order.product.priceFen || evidence.refundedAt < order.paidAt) fail('REFUND_MISMATCH')
  if (order.status === 'refunded') {
    if (order.refundId !== evidence.refundId || order.refundedAt !== evidence.refundedAt) fail('REFUND_CONFLICT')
    return { order, grant: grantFromOrder(order) }
  }
  if (order.status !== 'paid') fail('ORDER_NOT_REFUNDABLE')
  const refunded = { ...order, status: 'refunded', refundId: evidence.refundId, refundedAt: evidence.refundedAt }
  return { order: refunded, grant: grantFromOrder(refunded) }
}

// Independent grants overlap rather than extend each other, so refunding one never revokes another.
function hasExamAccess(grants, ownerId, examId, now) {
  if (!Array.isArray(grants) || !id(ownerId) || !id(examId) || !time(now)) return false
  return grants.some(g => g && g.ownerId === ownerId && g.examId === examId && g.revoked === false &&
    time(g.startAt) && time(g.endAt) && g.startAt <= now && now < g.endAt)
}

module.exports = { DAY_MS, validProduct, createOrder, confirmPayment, confirmFullRefund, hasExamAccess }
