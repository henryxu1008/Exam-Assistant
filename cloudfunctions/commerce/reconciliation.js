/**
 * Internal reconciliation coordinator. queryVerified is a TRUSTED adapter boundary,
 * not a client API. No real payment-provider adapter is registered by this module.
 * Unknown/pending/closed or inconsistent evidence never creates an entitlement.
 */
const { readOptionalDoc } = require('./db-error.js')
const fail = code => { throw Object.assign(new Error(code), { code }) }
const id = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(v)
const time = v => Number.isSafeInteger(v) && v >= 0
function createReconciler({ db, queryVerified, settlement }) {
  if (!db || typeof queryVerified !== 'function' || !settlement || typeof settlement.confirmVerifiedPayment !== 'function' ||
      typeof settlement.confirmVerifiedFullRefund !== 'function') fail('RECONCILER_NOT_CONFIGURED')
  return async function reconcile(orderId) {
    if (!id(orderId)) fail('BAD_ORDER')
    const order = await readOptionalDoc(() => db.collection('commerceOrders').doc(orderId).get())
    if (!order) fail('ORDER_NOT_FOUND')
    if (order.id !== orderId || !id(order.ownerId) || !order.product || !id(order.product.id) || !id(order.product.examId) ||
        !Number.isSafeInteger(order.product.priceFen) || order.product.priceFen <= 0 || !['pending', 'paid', 'refunded'].includes(order.status)) fail('INVALID_ORDER')
    let remote
    try { remote = await queryVerified(orderId) } catch (e) { throw Object.assign(new Error('PROVIDER_QUERY_FAILED'), { code: 'PROVIDER_QUERY_FAILED' }) }
    if (!remote || !['pending', 'paid', 'refunded', 'closed', 'unknown'].includes(remote.status)) fail('INVALID_PROVIDER_EVIDENCE')
    // These fields are an internal normalized contract, not a claim about any provider's API.
    if (remote.orderId !== orderId || remote.ownerId !== order.ownerId || remote.amountFen !== order.product.priceFen || remote.productId !== order.product.id || remote.currency !== 'CNY') fail('PROVIDER_ORDER_MISMATCH')
    if (remote.status === 'unknown') return { status: 'unknown', orderId }
    if (remote.status === 'pending' || remote.status === 'closed') return { status: order.status === 'pending' ? (remote.status === 'closed' ? 'provider_closed' : 'pending') : 'conflict', orderId }
    if (!id(remote.transactionId) || !time(remote.paidAt)) fail('INVALID_PROVIDER_EVIDENCE')
    const payment = { orderId, ownerId: order.ownerId, amountFen: order.product.priceFen, transactionId: remote.transactionId, paidAt: remote.paidAt }
    if (remote.status === 'paid') {
      if (order.status === 'refunded') return { status: 'conflict', orderId }
      const result = await settlement.confirmVerifiedPayment(payment)
      return { status: result.order.status === 'refunded' ? 'conflict' : 'paid', orderId }
    }
    if (!id(remote.refundId) || !time(remote.refundedAt) || remote.refundedAt < remote.paidAt || remote.refundAmountFen !== order.product.priceFen) fail('INVALID_PROVIDER_EVIDENCE')
    // Do not grant even temporarily when a refund is seen before the local payment.
    if (order.status === 'pending') return { status: 'manual_review', orderId }
    if (order.transactionId !== remote.transactionId || order.paidAt !== remote.paidAt) fail('PROVIDER_ORDER_MISMATCH')
    await settlement.confirmVerifiedFullRefund({ orderId, transactionId: remote.transactionId, amountFen: remote.refundAmountFen,
      refundId: remote.refundId, refundedAt: remote.refundedAt })
    return { status: 'refunded', orderId }
  }
}
module.exports = { createReconciler }
