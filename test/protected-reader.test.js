const { test } = require('node:test')
const assert = require('node:assert/strict')
const { harness, USER_TOKEN, ADMIN_TOKEN, ADMIN_OPENID } = require('./support/bank-harness.js')
const { createProtectedReader, policyKey } = require('../cloudfunctions/bankSync/protected-reader.js')
const paged = require('../shared/paged-catalog-domain.js')
const sample = require('../docs/examples/catalog-import.json')
const clone = value => JSON.parse(JSON.stringify(value))
const NOW = Date.parse('2026-10-30T06:00:00Z')
function setup() {
  const h = harness(), bank = clone(sample.bank), template = bank.questions.it[0], source = sample.sources[template.id]
  bank.schemaVersion = 4; bank.manifest.exams = [{ id: 'exam_a', name: '考试甲' }, { id: 'exam_b', name: '考试乙' }]
  bank.manifest.subjects = [
    { key: 'a', name: '甲', examId: 'exam_a', chapters: [{ key: 'net', name: '基础' }] },
    { key: 'b', name: '乙', examId: 'exam_b', chapters: [{ key: 'net', name: '基础' }] }
  ]
  bank.questions = { a: [{ ...clone(template), id: 'A', subject: 'a', chapter: 'net', stem: '付费甲' }],
    b: [{ ...clone(template), id: 'B', subject: 'b', chapter: 'net', stem: '付费乙' }] }
  const built = paged.buildPagedCatalog({ ...bank, sources: { A: source, B: source } })
  h.seedBank({ schemaVersion: 4, root: built.root, publicationRevision: 1 })
  h.documents.set(built.root.releaseId, { kind: 'pagedQuestionBankRelease', root: clone(built.root), publishedAt: 1 })
  for (const page of built.publicPages) h.documents.set(paged.pageDocumentId(page.releaseId, page.index), { kind: 'pagedQuestionBankPage', page: clone(page) })
  h.config.set(policyKey('exam_a'), { kind: 'examAccessPolicy', examId: 'exam_a', access: 'paid', releaseId: built.root.releaseId, publicationRevision: 1 })
  h.collections.commerceGrants.set('order_a', { orderId: 'order_a', ownerId: 'normal-openid', examId: 'exam_a', startAt: NOW - 100, endAt: NOW + 100, revoked: false })
  const reader = createProtectedReader({ db: h.db, now: () => NOW })
  const request = { token: USER_TOKEN, examId: 'exam_a', releaseId: built.root.releaseId, index: 0, grantOrderId: 'order_a' }
  return { h, built, reader, request, ctx: { OPENID: 'normal-openid' } }
}

test('已购用户仅读取其考试的题目，保留原发布并拒绝伪造身份', async () => {
  const { reader, request, ctx, h } = setup()
  const result = await reader(request, ctx)
  assert.equal(result.ok, true); assert.equal(result.page.questions.length, 1)
  assert.equal(result.page.questions[0].id, 'A'); assert.equal(result.scope.subjects[0].key, 'a')
  assert.equal(JSON.stringify(result).includes('付费乙'), false)
  assert.equal((await reader(request, { OPENID: ADMIN_OPENID })).error, 'INVALID_TOKEN')
  assert.equal((await reader({ ...request, token: ADMIN_TOKEN }, { OPENID: ADMIN_OPENID })).error, 'ENTITLEMENT_REQUIRED')
  assert.equal((await h.main({ ...request, action: 'getProtectedExamPage' })).error, 'BAD_ACTION', '原型尚未开放网络入口')
})

test('未购买、过期、退款、缺失策略或读取故障均不返回题目', async () => {
  const { h, reader, request, ctx } = setup(), grant = h.collections.commerceGrants.get('order_a')
  for (const patch of [{ ownerId: ADMIN_OPENID }, { examId: 'exam_b' }, { revoked: true }, { endAt: NOW }, { startAt: NOW + 1 }]) {
    h.collections.commerceGrants.set('order_a', { ...grant, ...patch })
    const result = await reader(request, ctx)
    assert.equal(result.error, 'ENTITLEMENT_REQUIRED'); assert.equal(result.page, undefined)
  }
  h.collections.commerceGrants.set('order_a', grant)
  h.config.delete(policyKey('exam_a'))
  assert.equal((await reader(request, ctx)).error, 'INVALID_ACCESS_POLICY')
  h.fail.get = name => name === 'appConfig'
  assert.equal((await reader(request, ctx)).error, 'PROTECTED_READ_FAILED')
})

test('发布切换、坏页及事务前撤销会话时停止读取', async () => {
  const { h, built, reader, request, ctx } = setup()
  h.seedBank({ schemaVersion: 4, root: built.root, publicationRevision: 2 })
  assert.equal((await reader(request, ctx)).error, 'INVALID_ACCESS_POLICY')
  h.seedBank({ schemaVersion: 4, root: built.root, publicationRevision: 1 })
  h.documents.delete(paged.pageDocumentId(built.root.releaseId, 0))
  assert.equal((await reader(request, ctx)).error, 'INVALID_PUBLISHED_PAGE')
  h.fail.beforeTransaction = () => { h.users.get('u1').token = 'revoked' }
  assert.equal((await reader(request, ctx)).error, 'INVALID_TOKEN')
})

test('免费考试必须有匹配发布的明确策略，策略不能被隐式降级', async () => {
  const { h, reader, request, ctx } = setup(), key = policyKey('exam_a')
  const original = h.config.get(key)
  h.config.set(key, { ...original, access: 'free' })
  assert.equal((await reader({ ...request, grantOrderId: '' }, ctx)).ok, true)
  h.config.set(key, { ...original, access: 'fre' })
  assert.equal((await reader(request, ctx)).error, 'INVALID_ACCESS_POLICY')
  h.config.set(key, { ...original, access: 'free', releaseId: 'qb_' + '0'.repeat(64) })
  assert.equal((await reader(request, ctx)).error, 'INVALID_ACCESS_POLICY')
})
