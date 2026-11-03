const { test } = require('node:test')
const assert = require('node:assert/strict')
const { harness, USER_TOKEN, ADMIN_TOKEN, ADMIN_OPENID } = require('./support/bank-harness.js')
const { createProtectedReader, POLICY_ID } = require('../cloudfunctions/bankSync/protected-reader.js')
const accessPolicy = require('../shared/exam-access-policy.js')
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
  h.config.set(POLICY_ID, accessPolicy.buildPolicy(built.root, 1, [{ examId: 'exam_a', access: 'paid' }, { examId: 'exam_b', access: 'free' }]))
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
  assert.equal((await h.main({ ...request, action: 'getProtectedExamPage' })).error, 'PROTECTED_READ_DISABLED', '默认入口尚未启用')
})

test('未购买、过期、退款、缺失策略或读取故障均不返回题目', async () => {
  const { h, reader, request, ctx } = setup(), grant = h.collections.commerceGrants.get('order_a')
  for (const patch of [{ ownerId: ADMIN_OPENID }, { examId: 'exam_b' }, { revoked: true }, { endAt: NOW }, { startAt: NOW + 1 }]) {
    h.collections.commerceGrants.set('order_a', { ...grant, ...patch })
    const result = await reader(request, ctx)
    assert.equal(result.error, 'ENTITLEMENT_REQUIRED'); assert.equal(result.page, undefined)
  }
  h.collections.commerceGrants.set('order_a', grant)
  h.config.delete(POLICY_ID)
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
  const { h, built, reader, request, ctx } = setup(), key = POLICY_ID
  const original = h.config.get(key)
  h.config.set(key, accessPolicy.buildPolicy(built.root, 1, [{ examId: 'exam_a', access: 'free' }, { examId: 'exam_b', access: 'free' }]))
  assert.equal((await reader({ ...request, grantOrderId: '' }, ctx)).ok, true)
  h.config.set(key, { ...original, entries: [{ examId: 'exam_a', access: 'fre' }, { examId: 'exam_b', access: 'free' }] })
  assert.equal((await reader(request, ctx)).error, 'INVALID_ACCESS_POLICY')
  h.config.set(key, { ...original, releaseId: 'qb_' + '0'.repeat(64) })
  assert.equal((await reader(request, ctx)).error, 'INVALID_ACCESS_POLICY')
})

test('发布策略必须完整覆盖每个考试且绑定同一发布修订', () => {
  const { built } = setup(), rules = [{ examId: 'exam_a', access: 'paid' }, { examId: 'exam_b', access: 'free' }]
  const policy = accessPolicy.buildPolicy(built.root, 1, rules)
  assert.equal(accessPolicy.validPolicy(built.root, 1, policy), true)
  assert.equal(accessPolicy.validPolicy(built.root, 1, { ...policy, _id: 'examAccessPolicy' }), true)
  assert.equal(accessPolicy.validPolicy(built.root, 1, { ...policy, _id: 'other' }), false)
  assert.equal(accessPolicy.validPolicy(built.root, 2, policy), false)
  assert.throws(() => accessPolicy.buildPolicy(built.root, 1, rules.slice(0, 1)), /INVALID_ACCESS_POLICY/)
  assert.throws(() => accessPolicy.buildPolicy(built.root, 1, [rules[0], rules[0]]), /INVALID_ACCESS_POLICY/)
  assert.equal(accessPolicy.validPolicy(built.root, 1, { ...policy, entries: policy.entries.slice(0, 1) }), false)
})

test('受保护模式封闭旧公开读取和旧发布路径，实际入口只返回持权考试', async () => {
  const { h, reader, request, ctx } = setup()
  const protectedMain = h.createMain({ protectedMode: true, getContext: () => ctx })
  for (const action of ['get', 'getPublished', 'getExamPublished', 'getVersion', 'getPagedPublished', 'getPagedPage']) {
    const result = await protectedMain({ ...request, action })
    assert.equal(result.error, 'PROTECTED_READER_REQUIRED', action); assert.equal(result.page, undefined); assert.equal(result.bank, undefined)
  }
  assert.equal((await protectedMain({})).error, 'PROTECTED_READER_REQUIRED')
  for (const action of ['set', 'publish', 'publishDraft', 'publishExamDraft']) {
    assert.equal((await protectedMain({ ...request, action })).error, 'PROTECTED_PUBLICATION_NOT_READY', action)
  }
  assert.equal((await protectedMain({ action: 'publishPagedDraft' })).error, 'NO_TOKEN')
  const accepted = await protectedMain({ ...request, action: 'getProtectedExamPage' })
  assert.equal(accepted.ok, true); assert.equal(accepted.page.questions[0].id, 'A')
  assert.equal(JSON.stringify(accepted).includes('付费乙'), false)
  assert.equal((await protectedMain({ ...request, action: 'getProtectedExamPage', grantOrderId: 'missing' })).error, 'ENTITLEMENT_REQUIRED')
  assert.equal((await h.main({ action: 'getPagedPublished' })).ok, true, '默认版本继续使用当前未保护的免费模式')
  assert.equal((await h.main({ ...request, action: 'getProtectedExamPage' })).error, 'PROTECTED_READ_DISABLED')
  assert.equal((await reader(request, ctx)).ok, true)
})

test('受保护入口拒绝客户端伪造上下文及读取失败，事务前被退款不能继续访问', async () => {
  const { h, request, ctx } = setup()
  const protectedMain = h.createMain({ protectedMode: true, getContext: () => ctx })
  const event = { ...request, action: 'getProtectedExamPage', OPENID: ADMIN_OPENID }
  h.fail.beforeTransaction = () => { h.collections.commerceGrants.get('order_a').revoked = true }
  assert.equal((await protectedMain(event)).error, 'ENTITLEMENT_REQUIRED')
  h.collections.commerceGrants.get('order_a').revoked = false
  h.fail.get = name => name === 'questions'
  assert.equal((await protectedMain(event)).error, 'PROTECTED_READ_FAILED')
  const forged = h.createMain({ protectedMode: true, getContext: () => ({ OPENID: ADMIN_OPENID }) })
  assert.equal((await forged(event)).error, 'INVALID_TOKEN')
})
