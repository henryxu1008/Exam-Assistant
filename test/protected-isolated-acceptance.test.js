/** In-memory composition of real services; it does not exercise CloudBase rules or WeChat. */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path')
const { makeHarness } = require('./support/study-sync-harness.js')
const { createProtectedReader } = require('../cloudfunctions/bankSync/protected-reader.js')
const { createProtectedStudy } = require('../cloudfunctions/bankSync/protected-study.js')
const { createProtectedState } = require('../cloudfunctions/bankSync/protected-state.js')
const { createService } = require('../cloudfunctions/commerce/service.js')
const { createSettlement } = require('../cloudfunctions/commerce/settlement.js')
const subscriptions = require('../shared/subscription-domain.js')
const policy = require('../shared/exam-access-policy.js'), paged = require('../shared/paged-catalog-domain.js')
const sample = require('../docs/examples/catalog-import.json')
const clone = v => JSON.parse(JSON.stringify(v)), NOW = Date.parse('2026-10-30T06:00:00Z'), DAY = 86400000
function setup() {
  const source = fs.readFileSync(path.join(__dirname, '../cloudfunctions/studySync/index.js'), 'utf8')
    .replace('const PROTECTED_RECORDS_ENABLED = false', 'const PROTECTED_RECORDS_ENABLED = true')
    .replace('const PROTECTED_STUDY_ONLY = false', 'const PROTECTED_STUDY_ONLY = true')
  const h = makeHarness({ source }), bank = clone(sample.bank), template = bank.questions.it[0], evidence = sample.sources[template.id]
  bank.schemaVersion = 4
  bank.manifest.exams = [{ id: 'paid', name: '合成付费考试' }, { id: 'free', name: '合成免费考试' }]
  bank.manifest.subjects = [{ key: 'p', name: '付费科目', examId: 'paid', chapters: [{ key: 'c', name: '章节' }] },
    { key: 'f', name: '免费科目', examId: 'free', chapters: [{ key: 'c', name: '章节' }] }]
  bank.questions = { p: [{ ...clone(template), id: 'P', subject: 'p', chapter: 'c', stem: '合成付费题干' }],
    f: [{ ...clone(template), id: 'F', subject: 'f', chapter: 'c', stem: '合成免费题干' }] }
  const built = paged.buildPagedCatalog({ ...bank, sources: { P: evidence, F: evidence } })
  h.questions.set('bank', { schemaVersion: 4, root: built.root, publicationRevision: 1 })
  h.questions.set(built.root.releaseId, { kind: 'pagedQuestionBankRelease', root: built.root, publishedAt: NOW })
  for (const page of built.publicPages) h.questions.set(paged.pageDocumentId(page.releaseId, page.index), { kind: 'pagedQuestionBankPage', page })
  h.appConfig.set('examAccessPolicy', policy.buildPolicy(built.root, 1, [{ examId: 'paid', access: 'paid' }, { examId: 'free', access: 'free' }]))
  h.appConfig.set('commerceAdmins', { openids: ['alice'] })
  let clock = NOW
  const read = createProtectedReader({ db: h.db, now: () => clock }), study = createProtectedStudy({ db: h.db, now: () => clock })
  const markers = createProtectedState({ db: h.db, now: () => clock })
  const commerce = createService({ db: h.db, allowOrders: true, now: () => clock }), settlement = createSettlement({ db: h.db, now: () => clock })
  const question = built.publicPages.flatMap(p => p.questions).find(q => q.id === 'P')
  const alice = { OPENID: 'alice' }, bob = { OPENID: 'bob' }
  const page = (examId, token = 'tokA', ctx = alice) => read({ action: 'getProtectedExamPage', token, examId, index: 0 }, ctx)
  const attempts = (token = 'tokA', ctx = alice, dataEpoch = 0) => study({ action: 'getProtectedAttempts', token, examId: 'paid', dataEpoch, afterSequence: 0, limit: 50 }, ctx)
  return { h, built, read, study, markers, commerce, settlement, question, alice, bob, page, attempts,
    setClock: value => { clock = value; h.users.get('u1').tokenAt = value; h.users.get('u2').tokenAt = value } }
}

test('合成闭环：免费、未购、开通、到期、续期、退款、切号和清空', async () => {
  const { h, built, read, study, markers, commerce, settlement, question, alice, bob, page, attempts, setClock } = setup()
  assert.equal((await page('free')).page.questions[0].id, 'F')
  const denied = await page('paid'); assert.equal(denied.error, 'ENTITLEMENT_REQUIRED'); assert.equal(denied.page, undefined)
  assert.equal((await page('free', 'tokA', bob)).error, 'INVALID_TOKEN')
  const productId = subscriptions.productId('paid', 30)
  const product = { id: productId, examId: 'paid', name: '合成套餐', priceFen: 100, durationDays: 30, active: true }
  assert.equal((await commerce({ action: 'putProduct', token: 'tokB', product, expectedRevision: 0 }, bob)).error, 'NOT_ADMIN')
  assert.equal((await commerce({ action: 'confirmVerifiedPayment', token: 'tokA' }, alice)).error, 'BAD_ACTION')
  assert.equal((await commerce({ action: 'putProduct', token: 'tokA', product, expectedRevision: 0 }, alice)).ok, true)
  const disabledCommerce = createService({ db: h.db, allowOrders: false, now: () => NOW })
  assert.equal((await disabledCommerce({ action: 'createOrder', token: 'tokA', productId, requestId: 'disabled' }, alice)).error, 'COMMERCE_DISABLED')
  async function pay(requestId, transactionId, at) {
    const result = await commerce({ action: 'createOrder', token: 'tokA', productId, requestId }, alice)
    assert.equal(result.ok, true)
    await settlement.confirmVerifiedPayment({ orderId: result.order.id, ownerId: 'alice', amountFen: 100, transactionId, paidAt: at })
    return result.order
  }
  const first = await pay('one', 'tx_one', NOW)
  assert.equal((await page('paid')).page.questions[0].id, 'P')
  const commit = { action: 'commitProtectedAttempt', token: 'tokA', examId: 'paid', dataEpoch: 0, operationId: 'attempt1',
    releaseId: built.root.releaseId, publicationRevision: 1, questionId: 'P', questionVersionId: question.versionId,
    selected: [question.answer[0]], costMs: 100 }
  assert.equal((await study(commit, alice)).ok, true)
  const marker = { action: 'setProtectedMarker', token: 'tokA', examId: 'paid', dataEpoch: 0, operationId: 'marker1', questionId: 'P',
    field: 'starred', value: true, expectedRevision: 0, releaseId: built.root.releaseId, publicationRevision: 1 }
  assert.equal((await markers(marker, alice)).ok, true)
  h.fail.protectedQuery = new Error('injected'); assert.equal((await attempts()).error, 'PROTECTED_STUDY_FAILED'); h.fail.protectedQuery = null
  assert.equal((await attempts()).attempts.length, 1)
  setClock(NOW + 30 * DAY)
  assert.equal((await page('paid')).error, 'ENTITLEMENT_REQUIRED')
  assert.equal((await attempts()).attempts.length, 1, '到期保留学习事实')
  assert.equal((await markers({ action: 'getProtectedMarkers', token: 'tokA', examId: 'paid', dataEpoch: 0 }, alice)).entries[0].starred, true)
  const second = await pay('two', 'tx_two', NOW + 30 * DAY)
  assert.equal((await page('paid')).ok, true)
  await settlement.confirmVerifiedFullRefund({ orderId: second.id, transactionId: 'tx_two', refundId: 'refund_two', amountFen: 100, refundedAt: NOW + 30 * DAY })
  assert.equal((await page('paid')).error, 'ENTITLEMENT_REQUIRED')
  assert.equal((await page('paid', 'tokB', bob)).error, 'ENTITLEMENT_REQUIRED')
  assert.equal((await page('free', 'tokB', bob)).ok, true)
  assert.deepEqual((await attempts('tokB', bob)).attempts, [])
  assert.equal((await attempts('tokA', bob)).error, 'INVALID_TOKEN')
  assert.deepEqual((await markers({ action: 'getProtectedMarkers', token: 'tokB', examId: 'paid', dataEpoch: 0 }, bob)).entries, [])
  assert.equal((await markers({ ...marker, token: 'tokA', operationId: 'forged' }, bob)).error, 'INVALID_TOKEN')
  h.users.get('u1').tokenAt = NOW // studySync test runtime uses a fixed synthetic clock
  const removed = await h.main({ action: 'delete', token: 'tokA', deleteId: 'clear_1', dataEpoch: 0 })
  assert.equal(removed.ok, true); assert.equal(removed.dataEpoch, 1)
  assert.equal((await study(commit, alice)).error, 'STALE_EPOCH')
  assert.equal((await attempts('tokA', alice, 1)).attempts.length, 0)
  assert.equal(h.protectedQuestionStates.size, 0); assert.equal(h.protectedStateReceipts.size, 0)
  assert.equal(h.commerceOrders.has(first.id), true, '清空学习数据不删除交易记录')
})

test('访问策略缺失或记录读取失败时不返回题目', async () => {
  const { h, page } = setup()
  h.appConfig.delete('examAccessPolicy')
  assert.equal((await page('free')).error, 'INVALID_ACCESS_POLICY')
  h.fail.get = name => name === 'questions'
  const result = await page('free'); assert.equal(result.error, 'PROTECTED_READ_FAILED'); assert.equal(result.page, undefined)
})
