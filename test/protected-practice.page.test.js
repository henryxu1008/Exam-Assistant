require('./wx-shim.js')
const { test } = require('node:test')
const assert = require('node:assert/strict')
const config = require('../utils/config.js')
const user = require('../utils/user.js')
const store = require('../utils/store.js')
const { createProtectedPracticeClient } = require('../utils/protected-practice-client.js')
const { createProtectedReader, POLICY_ID } = require('../cloudfunctions/bankSync/protected-reader.js')
const { createService } = require('../cloudfunctions/commerce/service.js')
const { createSettlement } = require('../cloudfunctions/commerce/settlement.js')
const subscriptions = require('../shared/subscription-domain.js')
const accessPolicy = require('../shared/exam-access-policy.js')
const paged = require('../shared/paged-catalog-domain.js')
const { versionQuestion } = require('../shared/question-domain.js')
const { harness, USER_TOKEN, ADMIN_TOKEN, ADMIN_OPENID } = require('./support/bank-harness.js')
const sample = require('../docs/examples/catalog-import.json')
const clone = x => JSON.parse(JSON.stringify(x)), NOW = Date.parse('2026-10-30T06:00:00Z')
let definition
global.Page = value => { definition = value }
require('../pages/protected-practice/protected-practice.js')
const settle = () => new Promise(setImmediate)
function setup(t) {
  const h = harness(), bank = clone(sample.bank), template = bank.questions.it[0], source = sample.sources[template.id]
  bank.schemaVersion = 4; bank.manifest.exams = [{ id: 'exam_a', name: '合成甲' }, { id: 'exam_b', name: '合成乙' }]
  bank.manifest.subjects = [{ key: 'a', name: '甲科', examId: 'exam_a', chapters: [{ key: 'net', name: '基础' }] },
    { key: 'b', name: '乙科', examId: 'exam_b', chapters: [{ key: 'net', name: '基础' }] }]
  bank.questions = { a: ['A', 'B'].map(id => ({ ...clone(template), id, subject: 'a', chapter: 'net', stem: '合成题' + id })),
    b: [{ ...clone(template), id: 'C', subject: 'b', chapter: 'net', stem: '其他考试题' }] }
  const built = paged.buildPagedCatalog({ ...bank, sources: { A: source, B: source, C: source } })
  h.seedBank({ schemaVersion: 4, root: built.root, publicationRevision: 1 })
  h.documents.set(built.root.releaseId, { kind: 'pagedQuestionBankRelease', root: clone(built.root), publishedAt: 1 })
  for (const page of built.publicPages) h.documents.set(paged.pageDocumentId(page.releaseId, page.index), { kind: 'pagedQuestionBankPage', page: clone(page) })
  h.config.set(POLICY_ID, accessPolicy.buildPolicy(built.root, 1, [{ examId: 'exam_a', access: 'paid' }, { examId: 'exam_b', access: 'free' }]))
  h.config.set('commerceAdmins', { openids: [ADMIN_OPENID] })
  let clock = NOW, session = { logged: true, openid: 'normal-openid', token: USER_TOKEN }, selectedExam = 'exam_a'
  const read = createProtectedReader({ db: h.db, now: () => clock })
  const service = createService({ db: h.db, allowOrders: true, now: () => clock }), settlement = createSettlement({ db: h.db, now: () => clock })
  const client = createProtectedPracticeClient({ getSession: () => session, call: data => read(data, { OPENID: session.openid }) })
  t.mock.method(user, 'whenReady', cb => cb()); t.mock.method(store, 'getCurrentExam', () => selectedExam)
  const original = config.protectedPracticePreview; config.protectedPracticePreview = true
  const p = Object.assign({}, definition, { data: clone(definition.data), setData(value) { Object.assign(this.data, value) } })
  p.onLoad(); p._client = client; p.onShow()
  t.after(() => { p.onUnload(); config.protectedPracticePreview = original })
  async function buy() {
    const id = subscriptions.productId('exam_a', 30), product = { id, examId: 'exam_a', name: '合成套餐', durationDays: 30, priceFen: 100, active: true }
    await service({ action: 'putProduct', token: ADMIN_TOKEN, product, expectedRevision: 0 }, { OPENID: ADMIN_OPENID })
    const order = (await service({ action: 'createOrder', token: USER_TOKEN, productId: id, requestId: 'r1' }, { OPENID: 'normal-openid' })).order
    await settlement.confirmVerifiedPayment({ orderId: order.id, ownerId: 'normal-openid', amountFen: 100, transactionId: 'tx1', paidAt: NOW })
    return order
  }
  return { h, p, read, service, settlement, built, buy, clock: value => { clock = value }, session: value => { session = value }, exam: value => { selectedExam = value } }
}

test('模拟支付后读取真实受保护题库并作答，退款后下一题拒绝且不保存题目', async t => {
  const { h, p, buy, settlement } = setup(t); await settle()
  assert.match(p.data.error, /权限/); assert.equal(p.data.question, null)
  const order = await buy(); await p.restart()
  assert.equal(p.data.question.stem, '合成题A'); assert.equal(p.data.question.subject, 'a')
  assert.equal(JSON.stringify(p.data).includes('其他考试题'), false)
  p.onSelect({ detail: { key: p.data.question.answer[0] } }); await p.onSubmit()
  assert.equal(p.data.submitted, true); assert.equal(p.data.correct, true)
  await settlement.confirmVerifiedFullRefund({ orderId: order.id, transactionId: 'tx1', refundId: 'refund1', amountFen: 100, refundedAt: NOW })
  await p.onNext(); assert.equal(p.data.question, null); assert.match(p.data.error, /权限/)
  assert.deepEqual(wx.getStorageInfoSync().keys.filter(k => /protected|practice/i.test(k)), [])
})

test('首次获取无需发布 ID，其他页面必须固定发布；身份、读故障和过期均拒绝', async t => {
  const { p, read, built, buy, h, clock } = setup(t); await settle(); await buy()
  const call = data => read({ token: USER_TOKEN, examId: 'exam_a', ...data }, { OPENID: 'normal-openid' })
  assert.equal((await call({ index: 0 })).ok, true)
  assert.equal((await call({ index: 1 })).error, 'BAD_PAGE_QUERY')
  assert.equal((await call({ index: 0, releaseId: 'qb_' + '0'.repeat(64) })).error, 'STALE_RELEASE')
  await p.restart(); h.fail.get = name => name === 'commerceTimelines'
  p.onSelect({ detail: { key: p.data.question.answer[0] } }); await p.onSubmit()
  assert.equal(p.data.question, null); assert.match(p.data.error, /失败/)
  h.fail.get = null; clock(NOW + 30 * subscriptions.DAY_MS)
  h.users.get('u1').tokenAt = NOW + 29 * subscriptions.DAY_MS
  await p.restart(); assert.equal(p.data.question, null); assert.match(p.data.error, /权限/)
  assert.equal((await call({ index: 0, releaseId: built.root.releaseId })).error, 'ENTITLEMENT_REQUIRED')
})

test('切账号或离开页面时丢弃迟到响应，无法显示旧账号题目', async t => {
  const { p, buy, session } = setup(t); await settle(); await buy(); await p.restart()
  const real = p._client.page
  const response = await real('exam_a', 0, p._baseline, { openid: 'normal-openid', token: USER_TOKEN }); let resolve
  p._client.page = () => new Promise(r => { resolve = r })
  p.onSelect({ detail: { key: p.data.question.answer[0] } })
  const pending = p.onSubmit(); session({ logged: true, openid: ADMIN_OPENID, token: ADMIN_TOKEN })
  resolve(response)
  await pending; assert.equal(p.data.question, null); assert.match(p.data.error, /账号/)
  p.onHide(); assert.equal(p.data.question, null); assert.equal(p._baseline, null)
})

test('提交前退款会阻断判题，免费考试无需套餐但仍需身份校验', async t => {
  const { p, buy, settlement, exam } = setup(t); await settle(); const order = await buy(); await p.restart()
  p.onSelect({ detail: { key: p.data.question.answer[0] } })
  await settlement.confirmVerifiedFullRefund({ orderId: order.id, transactionId: 'tx1', refundId: 'refund1', amountFen: 100, refundedAt: NOW })
  await p.onSubmit(); assert.equal(p.data.question, null); assert.equal(p.data.answered, 0); assert.match(p.data.error, /权限/)
  exam('exam_b'); await p.restart(); assert.equal(p.data.question.stem, '其他考试题')
})

test('页数据被篡改或发布修订变化时不会显示和提交题目', async t => {
  const { p, buy, h, built } = setup(t); await settle(); await buy(); await p.restart()
  const question = p.data.question
  p.onSelect({ detail: { key: question.answer[0] } })
  h.seedBank({ schemaVersion: 4, root: built.root, publicationRevision: 2 })
  h.config.set(POLICY_ID, accessPolicy.buildPolicy(built.root, 2, [{ examId: 'exam_a', access: 'paid' }, { examId: 'exam_b', access: 'free' }]))
  await p.onSubmit(); assert.equal(p.data.question, null); assert.equal(p.data.answered, 0); assert.match(p.data.error, /更新/)
  const client = createProtectedPracticeClient({ getSession: () => ({ logged: true, openid: 'normal-openid', token: USER_TOKEN }),
    call: async () => ({ ok: true, publicationRevision: 2, scope: { exam: { id: 'exam_a', name: '甲' }, subjects: [{ key: 'a', examId: 'exam_a', chapters: [{ key: 'net' }] }], releaseId: built.root.releaseId, sourcePageCount: 1 },
      page: { releaseId: built.root.releaseId, examId: 'exam_a', index: 0, questions: [{ ...question, stem: '篡改' }] } }) })
  await assert.rejects(client.page('exam_a', 0, null, client.capture()), /INVALID_RESPONSE/)
})

test('在线练习复用填空、排序和多选题的输入与判分', async t => {
  const { p, buy } = setup(t); await settle(); await buy(); await p.restart()
  const base = p.data.question
  const cases = [
    { question: versionQuestion({ ...base, id: 'fill1', type: 'fill', options: [], answer: [['Hello', 'hi']] }),
      act: () => p.onFill({ detail: { index: 0, value: ' hello ' } }) },
    { question: versionQuestion({ ...base, id: 'sort1', type: 'sort', options: [{ key: 'A', text: '一' }, { key: 'B', text: '二' }], answer: ['B', 'A'] }),
      act: () => { p.onSelect({ detail: { key: 'A' } }); p.onSelect({ detail: { key: 'B' } }); p.onSort({ detail: { action: 'up', index: 1 } }) } },
    { question: versionQuestion({ ...base, id: 'multi1', type: 'multiple', options: [{ key: 'A', text: '一' }, { key: 'B', text: '二' }], answer: ['A', 'B'] }),
      act: () => { p.onSelect({ detail: { key: 'B' } }); p.onSelect({ detail: { key: 'A' } }) } }
  ]
  for (const item of cases) {
    p._cursor = { pageIndex: 0, position: 0 }
    p.setData({ question: item.question, selected: item.question.type === 'fill' ? [''] : [], submitted: false, busy: false })
    p._client.page = async () => ({ page: { questions: [item.question] } })
    item.act(); await p.onSubmit(); assert.equal(p.data.correct, true, item.question.type)
  }
})

test('科目练习只展示选定科目的题目，无权限时提供套餐入口', async t => {
  const { p, buy } = setup(t); await settle()
  assert.equal(p.data.showPlans, true)
  await buy(); p._subjectId = 'b'; await p.restart()
  assert.equal(p.data.question, null); assert.match(p.data.error, /科目/)
  p._subjectId = 'a'; await p.restart()
  assert.equal(p.data.question.subject, 'a')
  p.onSelect({ detail: { key: p.data.question.answer[0] } }); await p.onSubmit(); await p.onNext()
  assert.equal(p.data.question.subject, 'a')
})

test('科目筛选跨页跳过其他科目并保留实际分页位置', async t => {
  const { p, buy } = setup(t); await settle(); await buy(); await p.restart()
  const q = p.data.question, original = p._client.page
  p._subjectId = 'target'
  p._client.page = async (exam, index, baseline, ctx) => {
    assert.equal(exam, 'exam_a'); assert.equal(p._client.current(ctx), true)
    return { baseline: baseline || { releaseId: 'fake' }, scope: { exam: { name: '考试甲' }, subjects: [{ key: 'target' }], sourcePageCount: 2 },
      page: { questions: index === 0 ? [{ ...q, id: 'other', subject: 'other' }] : [{ ...q, id: 'other2', subject: 'other' }, { ...q, id: 'target', subject: 'target' }] } }
  }
  p._baseline = null; await p._load(0, 0)
  assert.equal(p.data.question.id, 'target'); assert.deepEqual(p._cursor, { pageIndex: 1, position: 1 })
  p._client.page = original
})
