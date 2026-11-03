/** Authenticated product/order APIs. Payment callbacks are deliberately not exposed here. */
const { readOptionalDoc } = require('./db-error.js')
const { TOKEN_TTL } = require('./auth.js')
const { sha256 } = require('./question-domain.js')
const domain = require('./commerce-domain.js')
const fail = code => { throw Object.assign(new Error(code), { code }) }
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(value)
const read = (tx, collection, id) => readOptionalDoc(() => tx.collection(collection).doc(id).get())
const write = (tx, collection, id, data) => tx.collection(collection).doc(id).set({ data })
const orderKey = (owner, request) => 'ord_' + sha256(JSON.stringify([owner, request]))

function createService({ db, allowOrders = false, now = () => Date.now() }) {
  return async (event = {}, context = {}) => {
    try {
      const { action, token } = event
      if (!['putProduct', 'getProduct', 'createOrder', 'getOrder'].includes(action)) fail('BAD_ACTION')
      if (typeof token !== 'string' || !token || typeof context.OPENID !== 'string' || !context.OPENID) fail('INVALID_TOKEN')
      if (!db || typeof db.runTransaction !== 'function') fail('TRANSACTION_REQUIRED')
      const users = await db.collection('users').where({ token }).limit(1).get()
      const user = users && Array.isArray(users.data) && users.data[0]
      if (!user || !user._id || user.openid !== context.OPENID) fail('INVALID_TOKEN')
      return await db.runTransaction(async tx => {
        const current = await read(tx, 'users', user._id), at = now()
        if (!current || current.openid !== context.OPENID || current.token !== token || !Number.isSafeInteger(current.tokenAt) ||
            current.tokenAt <= 0 || current.tokenAt > at || at - current.tokenAt > TOKEN_TTL) fail('INVALID_TOKEN')
        if (action === 'putProduct') {
          const config = await read(tx, 'appConfig', 'commerceAdmins')
          if (!config || !Array.isArray(config.openids) || !config.openids.includes(context.OPENID)) fail('NOT_ADMIN')
          const input = event.product
          if (!input || !Number.isSafeInteger(event.expectedRevision) || event.expectedRevision < 0) fail('BAD_PRODUCT')
          const product = { id: input.id, examId: input.examId, name: input.name, priceFen: input.priceFen,
            durationDays: input.durationDays, active: input.active, revision: event.expectedRevision + 1 }
          if (!domain.validProduct(product)) fail('BAD_PRODUCT')
          const old = await read(tx, 'commerceProducts', product.id)
          if (old && (!domain.validProduct(old) || old.id !== product.id)) fail('INVALID_PRODUCT')
          if ((old ? old.revision : 0) !== event.expectedRevision) fail('STALE_PRODUCT')
          if (old && old.examId !== product.examId) fail('PRODUCT_EXAM_IMMUTABLE')
          await write(tx, 'commerceProducts', product.id, product)
          return { ok: true, product }
        }
        if (action === 'getProduct') {
          if (!validId(event.productId)) fail('BAD_PRODUCT')
          const product = await read(tx, 'commerceProducts', event.productId)
          if (!product || !domain.validProduct(product) || product.id !== event.productId || !product.active) fail('PRODUCT_UNAVAILABLE')
          return { ok: true, product }
        }
        if (action === 'createOrder') {
          if (!allowOrders) fail('COMMERCE_DISABLED')
          if (!validId(event.productId) || !validId(event.requestId)) fail('BAD_ORDER')
          const key = orderKey(context.OPENID, event.requestId)
          const existing = await read(tx, 'commerceOrders', key)
          if (existing) {
            if (existing.ownerId !== context.OPENID || !existing.product || existing.product.id !== event.productId) fail('ORDER_CONFLICT')
            return { ok: true, order: existing }
          }
          const product = await read(tx, 'commerceProducts', event.productId)
          if (product && product.id !== event.productId) fail('INVALID_PRODUCT')
          const order = domain.createOrder({ orderId: key, ownerId: context.OPENID, product, now: at })
          await write(tx, 'commerceOrders', key, order)
          return { ok: true, order }
        }
        if (!validId(event.orderId)) fail('BAD_ORDER')
        const order = await read(tx, 'commerceOrders', event.orderId)
        if (!order || order.ownerId !== context.OPENID) fail('ORDER_NOT_FOUND')
        return { ok: true, order }
      })
    } catch (e) {
      return { ok: false, error: /^[A-Z_]+$/.test(e.code || '') ? e.code : 'COMMERCE_FAILED' }
    }
  }
}

module.exports = { createService }
