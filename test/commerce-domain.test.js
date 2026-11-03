const { test } = require('node:test')
const assert = require('node:assert/strict')
const commerce = require('../shared/commerce-domain.js')
const product = { id: 'course_1', examId: 'exam_1', name: '合成考试', priceFen: 9900, durationDays: 180, revision: 1, active: true }
const order = () => commerce.createOrder({ orderId: 'order_1', ownerId: 'user_a', product, now: 1000 })
const payment = { orderId: 'order_1', ownerId: 'user_a', transactionId: 'pay_1', amountFen: 9900, paidAt: 2000 }
const refund = { orderId: 'order_1', transactionId: 'pay_1', refundId: 'refund_1', amountFen: 9900, refundedAt: 3000 }

test('模拟购买固定商品价格、版本和期限，支付重放不重复发放', () => {
  const editedProduct = { ...product }, original = commerce.createOrder({ orderId: 'order_1', ownerId: 'user_a', product: editedProduct, now: 1000 })
  editedProduct.priceFen = 1; editedProduct.durationDays = 1
  assert.equal(original.product.priceFen, 9900); assert.equal(original.product.durationDays, 180)
  const paid = commerce.confirmPayment(original, payment)
  assert.deepEqual(commerce.confirmPayment(paid.order, payment), paid)
  assert.equal(commerce.hasExamAccess([paid.grant], 'user_a', 'exam_1', 2000), true)
  assert.equal(commerce.hasExamAccess([paid.grant], 'user_b', 'exam_1', 2000), false)
  assert.equal(commerce.hasExamAccess([paid.grant], 'user_a', 'exam_2', 2000), false)
  assert.equal(commerce.hasExamAccess([paid.grant], 'user_a', 'exam_1', paid.grant.endAt), false)
})

test('下架商品、错误金额、账号和交易重放冲突均不能产生权益', () => {
  assert.throws(() => commerce.createOrder({ orderId: 'o', ownerId: 'a', product: { ...product, active: false }, now: 1 }), /PRODUCT_UNAVAILABLE/)
  for (const patch of [{ amountFen: 1 }, { ownerId: 'user_b' }, { orderId: 'order_2' }, { paidAt: 999 }]) {
    assert.throws(() => commerce.confirmPayment(order(), { ...payment, ...patch }), /PAYMENT_MISMATCH/)
  }
  const paid = commerce.confirmPayment(order(), payment)
  assert.throws(() => commerce.confirmPayment(paid.order, { ...payment, transactionId: 'pay_2' }), /PAYMENT_CONFLICT/)
})

test('全额退款只撤销该订单，其他订单权益不受影响', () => {
  const first = commerce.confirmPayment(order(), payment)
  const secondOrder = commerce.createOrder({ orderId: 'order_2', ownerId: 'user_a', product, now: 1000 })
  const second = commerce.confirmPayment(secondOrder, { ...payment, orderId: 'order_2', transactionId: 'pay_2' })
  assert.throws(() => commerce.confirmFullRefund(first.order, { ...refund, amountFen: 1 }), /REFUND_MISMATCH/)
  const refunded = commerce.confirmFullRefund(first.order, refund)
  assert.deepEqual(commerce.confirmFullRefund(refunded.order, refund), refunded)
  assert.equal(commerce.hasExamAccess([refunded.grant], 'user_a', 'exam_1', 3000), false)
  assert.equal(commerce.hasExamAccess([refunded.grant, second.grant], 'user_a', 'exam_1', 3000), true)
  assert.throws(() => commerce.confirmPayment(refunded.order, payment), /ORDER_NOT_PAYABLE/)
})
