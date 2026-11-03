/** Internal-only persistence primitive. Input must be verified by a future payment adapter; never expose as a client action. */
const { readOptionalDoc } = require('./db-error.js')
const { sha256 } = require('./question-domain.js')
const domain = require('./commerce-domain.js')
const fail = code => { throw Object.assign(new Error(code), { code }) }
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(value)
const read = (tx, collection, id) => readOptionalDoc(() => tx.collection(collection).doc(id).get())
const write = (tx, collection, id, data) => tx.collection(collection).doc(id).set({ data })

function createSettlement({ db, now = () => Date.now() }) {
  async function apply(kind, evidence) {
    if (!db || typeof db.runTransaction !== 'function') fail('TRANSACTION_REQUIRED')
    if (!evidence || !validId(evidence.orderId) || !validId(kind === 'payment' ? evidence.transactionId : evidence.refundId)) fail('BAD_EVIDENCE')
    const eventAt = kind === 'payment' ? evidence.paidAt : evidence.refundedAt
    if (!Number.isSafeInteger(eventAt) || eventAt > now()) fail('BAD_EVIDENCE')
    return db.runTransaction(async tx => {
      const order = await read(tx, 'commerceOrders', evidence.orderId)
      if (!order) fail('ORDER_NOT_FOUND')
      const key = kind + '_' + sha256(kind === 'payment' ? evidence.transactionId : evidence.refundId)
      const previous = await read(tx, 'commerceEvents', key)
      if (previous && (previous.orderId !== evidence.orderId || previous.kind !== kind)) fail('EVENT_CONFLICT')
      if (previous) {
        // A delayed payment notification must never revive a refunded entitlement.
        const checked = kind === 'payment' && order.status === 'refunded'
          ? domain.confirmPayment({ ...order, status: 'paid' }, evidence)
          : kind === 'payment' ? domain.confirmPayment(order, evidence) : domain.confirmFullRefund(order, evidence)
        const grant = await read(tx, 'commerceGrants', order.id)
        const expected = { ...checked.grant, revoked: order.status === 'refunded' }
        if (!grant || grant.orderId !== expected.orderId || grant.ownerId !== expected.ownerId || grant.examId !== expected.examId ||
            grant.startAt !== expected.startAt || grant.endAt !== expected.endAt || grant.revoked !== expected.revoked) fail('INVALID_GRANT')
        return { order, grant }
      }
      const result = kind === 'payment' ? domain.confirmPayment(order, evidence) : domain.confirmFullRefund(order, evidence)
      await write(tx, 'commerceOrders', order.id, result.order)
      await write(tx, 'commerceGrants', order.id, result.grant)
      if (!previous) await write(tx, 'commerceEvents', key, { orderId: order.id, kind })
      return result
    })
  }
  return { confirmVerifiedPayment: evidence => apply('payment', evidence), confirmVerifiedFullRefund: evidence => apply('refund', evidence) }
}
module.exports = { createSettlement }
