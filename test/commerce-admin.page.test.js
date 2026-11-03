require('./wx-shim.js')
const { test, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const user = require('../utils/user.js')
const { createCommerceAdmin } = require('../utils/commerce-admin.js')
const { createService } = require('../cloudfunctions/commerce/service.js')
const { harness, ADMIN_OPENID, ADMIN_TOKEN, USER_TOKEN } = require('./support/bank-harness.js')
const examDomain = require('../shared/exam-catalog-domain.js')
const sample = require('../docs/examples/catalog-import.json')
const NOW = Date.parse('2026-10-30T06:00:00Z')
let definition
global.Page = value => { definition = value }
require('../pages/commerce-admin/commerce-admin.js')
const settle = () => new Promise(setImmediate)
beforeEach(() => global.__wxStorage.clearAll())
function setup(t) {
  const h = harness(), bank = JSON.parse(JSON.stringify(sample.bank))
  bank.schemaVersion = 3; bank.manifest.exams = [{ id: 'exam_1', name: '合成考试' }]; bank.manifest.subjects[0].examId = 'exam_1'
  h.seedBank({ ...examDomain.buildExamRelease(bank), publicationRevision: 1 })
  h.config.set('commerceAdmins', { openids: [ADMIN_OPENID] })
  let session = { logged: true, openid: ADMIN_OPENID, token: ADMIN_TOKEN }
  const service = createService({ db: h.db, now: () => NOW })
  const client = createCommerceAdmin({ getSession: () => session, call: data => service(data, { OPENID: session.openid }) })
  t.mock.method(user, 'requireAccount', cb => { cb(); return true })
  const p = Object.assign({}, definition, { data: JSON.parse(JSON.stringify(definition.data)), setData(value) { Object.assign(this.data, value) } })
  p.onLoad(); p._client = client; p.onShow(); t.after(() => p.onUnload())
  return { h, p, session: value => { session = value } }
}
const input = (p, field, value) => p.onInput({ currentTarget: { dataset: { field } }, detail: { value } })
const choose = (p, id) => p.onSelect({ currentTarget: { dataset: { id } } })

test('管理员选择已发布考试配置商品，价格精确到分，重新读取同一商品', async t => {
  const { h, p } = setup(t); await settle()
  assert.equal(p.data.allowed, true); assert.equal(p.data.exams[0].name, '合成考试')
  choose(p, 'exam_1'); await settle(); assert.equal(p.data.loaded, true)
  input(p, 'price', '99.90'); p.onSave(); await settle()
  assert.equal(p.data.revision, 1); assert.equal(p.data.dirty, false)
  const stored = [...h.collections.commerceProducts.values()][0]
  assert.equal(stored.priceFen, 9990); assert.equal(stored.examId, 'exam_1'); assert.equal(stored.durationDays, 30); assert.equal(stored.active, false)
  p.onHide(); p.onShow(); await settle(); choose(p, 'exam_1'); await settle()
  assert.equal(p.data.price, '99.90'); assert.equal(p.data.revision, 1)
})

test('同一考试可配置不同期限套餐，未保存的价格阻止切换', async t => {
  const { h, p } = setup(t); await settle(); choose(p, 'exam_1'); await settle()
  input(p, 'price', '19.90')
  p.onTerm({ currentTarget: { dataset: { days: 90 } } }); assert.equal(p.data.error, 'UNSAVED_CHANGES'); assert.equal(p.data.termDays, 30)
  p.onSave(); await settle(); p.onTerm({ currentTarget: { dataset: { days: 90 } } }); await settle()
  assert.equal(p.data.termDays, 90); assert.equal(p.data.price, '')
  input(p, 'price', '49.90'); p.onSave(); await settle()
  assert.deepEqual([...h.collections.commerceProducts.values()].map(item => item.durationDays).sort((a, b) => a - b), [30, 90])
  p.onTerm({ currentTarget: { dataset: { days: 30 } } }); await settle(); assert.equal(p.data.price, '19.90')
})

test('价格无效、身份撤销或读取故障时不能提交或覆盖', async t => {
  const { h, p, session } = setup(t); await settle(); choose(p, 'exam_1'); await settle()
  input(p, 'price', '1.999'); p.onSave(); assert.equal(p.data.error, 'BAD_PRODUCT')
  assert.equal(h.collections.commerceProducts.size, 0)
  input(p, 'price', '12.00'); h.fail.get = name => name === 'commerceProducts'; p.onSave(); await settle()
  assert.equal(p.data.error, 'COMMERCE_FAILED'); assert.equal(h.collections.commerceProducts.size, 0)
  h.fail.get = null; session({ logged: true, openid: 'normal-openid', token: USER_TOKEN })
  p.onSave(); await settle(); assert.equal(h.collections.commerceProducts.size, 0)
})

test('页面隐藏后迟到的商品响应不能恢复旧账号界面', async t => {
  const { p } = setup(t); await settle()
  let resolve
  p._client.product = () => new Promise(r => { resolve = r })
  choose(p, 'exam_1'); p.onHide(); resolve({ product: null }); await settle()
  assert.equal(p.data.allowed, false); assert.equal(p.data.loaded, false); assert.equal(p.data.exams.length, 0)
})

test('未保存的商品表单阻止切换考试，放弃后可恢复服务端内容', async t => {
  const { p } = setup(t); await settle(); choose(p, 'exam_1'); await settle()
  p.setData({ exams: [...p.data.exams, { id: 'exam_2', name: '另一考试' }] })
  input(p, 'price', '25.00'); choose(p, 'exam_2')
  assert.equal(p.data.selected, 'exam_1'); assert.equal(p.data.price, '25.00'); assert.equal(p.data.error, 'UNSAVED_CHANGES')
  p.onDiscard(); await settle()
  assert.equal(p.data.dirty, false); assert.equal(p.data.price, '')
})

test('载入商品失败后可重试，不能把读取失败当作新商品', async t => {
  const { h, p } = setup(t); await settle()
  h.fail.get = name => name === 'commerceProducts'
  choose(p, 'exam_1'); await settle()
  assert.equal(p.data.loaded, false); assert.equal(p.data.error, 'COMMERCE_FAILED')
  p.onSave(); assert.equal(h.collections.commerceProducts.size, 0)
  h.fail.get = null; p.onDiscard(); await settle()
  assert.equal(p.data.loaded, true); assert.equal(p.data.revision, 0)
})
