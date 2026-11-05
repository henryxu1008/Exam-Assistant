const { test } = require('node:test')
const assert = require('node:assert/strict')
const paged = require('../shared/paged-catalog-domain.js')
const policyDomain = require('../shared/exam-access-policy.js')
const subscriptions = require('../shared/subscription-domain.js')
const { operators } = require('./support/catalog-operators.js')
const sample = require('../docs/examples/catalog-import.json')
const copy = value => JSON.parse(JSON.stringify(value))
function catalog(count = 3, suffix = '') {
  const bank = copy(sample.bank), q = bank.questions.it[0], source = sample.sources[q.id]
  bank.schemaVersion = 4; bank.manifest.exams = [{ id: 'exam', name: '合成考试' }]; bank.manifest.subjects[0].examId = 'exam'
  bank.questions.it = Array.from({ length: count }, (_, i) => ({ ...copy(q), id: 'q' + String(i).padStart(4, '0'), stem: q.stem + suffix }))
  return paged.buildPagedCatalog({ ...bank, sources: Object.fromEntries(bank.questions.it.map(question => [question.id, source])) })
}
function setup() {
  const { h } = operators()
  let openid = 'normal-openid'
  const main = h.createMain({ protectedMode: true, getContext: () => ({ OPENID: openid }) })
  const call = (token, action, values = {}) => { openid = token; return main({ token, action, ...values }) }
  return { h, main, call, asUser: () => { openid = 'normal-openid' } }
}
async function prepare(ctx, bank, submissionId, basePublication = null, access = 'paid') {
  const { call } = ctx, rules = [{ examId: 'exam', access }]
  const started = await call('editor', 'beginPagedDraft', { root: bank.root, evidence: bank.evidence, basePublication,
    submissionId, rightsConfirmed: true, accessRules: rules })
  assert.equal(started.ok, true, started.error)
  for (const page of bank.publicPages) assert.equal((await call('editor', 'uploadPagedDraftPage', { draftId: started.draftId,
    page, sourcePage: bank.privatePages[page.index] })).ok, true)
  assert.equal((await call('editor', 'sealPagedDraft', { draftId: started.draftId })).ok, true)
  return started.draftId
}
async function approve(ctx, bank, draftId) {
  const { call } = ctx
  assert.equal((await call('reviewer', 'getPagedDraft', { draftId })).ok, true)
  for (const page of bank.publicPages) assert.equal((await call('reviewer', 'getPagedDraftPage', { draftId, index: page.index })).ok, true)
  return call('reviewer', 'reviewPagedDraft', { draftId, decision: 'approve', note: '核对题目和访问策略', sourceVerified: true, policyVerified: true })
}
function snapshot(h) { return JSON.stringify(Object.fromEntries(Object.entries(h.collections).map(([name, rows]) => [name, [...rows.entries()]]))) }

test('策略纳入草稿摘要和独立审核，发布事务同时激活策略与题库，失败可完整回滚', async () => {
  const ctx = setup(), { h, call, main } = ctx, bank = catalog()
  const missing = await call('editor', 'beginPagedDraft', { root: bank.root, evidence: bank.evidence, basePublication: null,
    submissionId: 'missing-policy', rightsConfirmed: true })
  assert.equal(missing.error, 'INVALID_ACCESS_POLICY')
  ctx.asUser()
  assert.equal((await main({ token: 'editor', action: 'beginPagedDraft', root: bank.root, evidence: bank.evidence, basePublication: null,
    submissionId: 'stolen-token', rightsConfirmed: true, accessRules: [{ examId: 'exam', access: 'paid' }] })).error, 'INVALID_TOKEN')
  const draftId = await prepare(ctx, bank, 'protected-first')
  for (const page of bank.publicPages) assert.equal((await call('reviewer', 'getPagedDraftPage', { draftId, index: page.index })).ok, true)
  const confirm = { draftId, decision: 'approve', note: '核对题目和访问策略', sourceVerified: true, policyVerified: true }
  assert.equal((await call('reviewer', 'reviewPagedDraft', confirm)).error, 'REVIEW_PAGES_REQUIRED', '未读取策略不能批准')
  const viewed = await call('reviewer', 'getPagedDraft', { draftId })
  assert.equal(viewed.draft.accessPolicy.entries[0].access, 'paid')
  assert.equal((await call('reviewer', 'reviewPagedDraft', { ...confirm, policyVerified: false })).error, 'POLICY_REVIEW_REQUIRED')
  assert.equal((await call('reviewer', 'reviewPagedDraft', confirm)).ok, true)
  const before = snapshot(h)
  for (const [name, id] of [['appConfig', 'examAccessPolicy'], ['questions', 'bank']]) {
    h.fail.write = (collection, key) => collection === name && key === id
    assert.equal((await call('publisher', 'publishPagedDraft', { draftId, expectedRevision: 0 })).ok, false)
    h.fail.write = null; assert.equal(snapshot(h), before); assert.equal(h.bank(), null); assert.equal(h.config.has('examAccessPolicy'), false)
  }
  const done = await call('publisher', 'publishPagedDraft', { draftId, expectedRevision: 0 })
  assert.equal(done.ok, true); assert.equal(done.publicationRevision, 1)
  assert.equal(policyDomain.validPolicy(h.bank().root, 1, h.config.get('examAccessPolicy')), true)
  assert.equal(h.documents.get('bank_publication_1').approval.accessPolicyDigest, h.config.get('examAccessPolicy').digest)
  assert.equal((await call('publisher', 'publishPagedDraft', { draftId, expectedRevision: 0 })).alreadyPublished, true)
  const orderId = 'order_a', start = Date.parse('2026-10-30T05:59:00Z')
  h.collections.commerceTimelines.set(subscriptions.timelineId('normal-openid', 'exam'), subscriptions.extend(
    subscriptions.reserve(subscriptions.empty('normal-openid', 'exam'), orderId, start), orderId, 1, start))
  ctx.asUser()
  const read = await main({ action: 'getProtectedExamPage', token: 'user-token', examId: 'exam', releaseId: bank.root.releaseId, index: 0, grantOrderId: orderId })
  assert.equal(read.ok, true); assert.equal(read.page.questions.length, 3)
})

test('并发旧基线只能成功一次，草稿策略篡改不能通过审核和发布', async () => {
  const ctx = setup(), { h, call } = ctx, first = catalog(2), d0 = await prepare(ctx, first, 'first')
  assert.equal((await approve(ctx, first, d0)).ok, true)
  assert.equal((await call('publisher', 'publishPagedDraft', { draftId: d0, expectedRevision: 0 })).ok, true)
  const base = { revision: 1, releaseId: first.root.releaseId }, second = catalog(2, '乙'), third = catalog(2, '丙')
  const d1 = await prepare(ctx, second, 'second', base, 'free'), d2 = await prepare(ctx, third, 'third', base, 'paid')
  const reused = await call('editor', 'beginPagedDraft', { root: second.root, evidence: second.evidence, basePublication: base,
    submissionId: 'second', rightsConfirmed: true, accessRules: [{ examId: 'exam', access: 'paid' }] })
  assert.equal(reused.error, 'DRAFT_OPERATION_CONFLICT')
  assert.equal((await approve(ctx, second, d1)).ok, true); assert.equal((await approve(ctx, third, d2)).ok, true)
  const currentPolicy = copy(h.config.get('examAccessPolicy'))
  h.config.delete('examAccessPolicy')
  assert.equal((await call('publisher', 'publishPagedDraft', { draftId: d1, expectedRevision: 1 })).error, 'INVALID_ACCESS_POLICY')
  h.config.set('examAccessPolicy', currentPolicy)
  h.fail.get = (name, id) => name === 'appConfig' && id === 'examAccessPolicy'
  assert.equal((await call('publisher', 'publishPagedDraft', { draftId: d1, expectedRevision: 1 })).ok, false)
  h.fail.get = null
  const original = copy(h.documents.get(d1)); h.documents.get(d1).accessPolicy.entries[0].access = 'paid'
  assert.equal((await call('publisher', 'publishPagedDraft', { draftId: d1, expectedRevision: 1 })).error, 'INVALID_DRAFT')
  h.documents.set(d1, original)
  const results = await Promise.all([call('publisher', 'publishPagedDraft', { draftId: d1, expectedRevision: 1 }),
    call('publisher', 'publishPagedDraft', { draftId: d2, expectedRevision: 1 })])
  assert.equal(results.filter(result => result.ok).length, 1)
  assert.equal(results.find(result => !result.ok).error, 'STALE_BASE_RELEASE')
  assert.equal(policyDomain.validPolicy(h.bank().root, 2, h.config.get('examAccessPolicy')), true)
  assert.equal((await call('publisher', 'publishPagedDraft', { draftId: d0, expectedRevision: 0 })).error, 'STALE_BASE_RELEASE')
})

test('保护发布的最大分页事务保持在数据库操作预算内', async () => {
  const ctx = setup(), oversized = catalog(2000)
  assert.equal((await ctx.call('editor', 'beginPagedDraft', { root: oversized.root, evidence: oversized.evidence, basePublication: null,
    submissionId: 'too-large', rightsConfirmed: true, accessRules: [{ examId: 'exam', access: 'paid' }] })).error, 'PROTECTED_CATALOG_TOO_LARGE')
  const bank = catalog(1900), draftId = await prepare(ctx, bank, 'protected-max')
  assert.equal(bank.root.pages.length, 19); assert.equal((await approve(ctx, bank, draftId)).ok, true)
  const result = await ctx.call('publisher', 'publishPagedDraft', { draftId, expectedRevision: 0 })
  assert.equal(result.ok, true, result.error)
  assert.ok(ctx.h.transactions.at(-1).length <= 100, `操作数 ${ctx.h.transactions.at(-1).length}`)
})
