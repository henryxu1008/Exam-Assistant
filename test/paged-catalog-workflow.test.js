const { test } = require('node:test')
const assert = require('node:assert/strict')
const paged = require('../shared/paged-catalog-domain.js')
const { operators } = require('./support/catalog-operators.js')
const sample = require('../docs/examples/catalog-import.json')
const { makeHarness } = require('./support/study-sync-harness.js')
const { fact } = require('./support/grading-fixture.js')
const { createCatalogAdmin } = require('../utils/catalog-admin.js')
const copy = x => JSON.parse(JSON.stringify(x))
function catalog(count = 205) {
  const bank = copy(sample.bank), q = bank.questions.it[0], source = sample.sources[q.id]
  bank.schemaVersion = 4; bank.manifest.exams = [{ id: 'exam', name: '考试' }]; bank.manifest.subjects[0].examId = 'exam'
  bank.questions.it = Array.from({ length: count }, (_, i) => ({ ...q, id: 'q' + String(i).padStart(4, '0') }))
  return paged.buildPagedCatalog({ ...bank, sources: Object.fromEntries(bank.questions.it.map(x => [x.id, source])) })
}
const call = (h, token, action, extra = {}) => h.main({ token, action, ...extra })
async function begin(h, v, submissionId, basePublication = null) {
  return call(h, 'editor', 'beginPagedDraft', { root: v.root, evidence: v.evidence, basePublication, submissionId, rightsConfirmed: true })
}
async function upload(h, id, v) {
  for (let i = 0; i < v.publicPages.length; i++) assert.equal((await call(h, 'editor', 'uploadPagedDraftPage', { draftId: id, page: v.publicPages[i], sourcePage: v.privatePages[i] })).ok, true)
}
async function review(h, id, v) {
  for (const page of v.publicPages) assert.equal((await call(h, 'reviewer', 'getPagedDraftPage', { draftId: id, index: page.index })).ok, true)
  return call(h, 'reviewer', 'reviewPagedDraft', { draftId: id, decision: 'approve', note: '合成来源已核验', sourceVerified: true })
}
async function finish(h, v, name, base = null) {
  const d = await begin(h, v, name, base); assert.equal(d.ok, true)
  await upload(h, d.draftId, v)
  assert.equal((await call(h, 'editor', 'sealPagedDraft', { draftId: d.draftId })).ok, true)
  assert.equal((await call(h, 'editor', 'sealPagedDraft', { draftId: d.draftId })).replayed, true)
  assert.equal((await review(h, d.draftId, v)).ok, true)
  assert.equal((await call(h, 'reviewer', 'reviewPagedDraft', { draftId: d.draftId, decision: 'approve', note: '合成来源已核验', sourceVerified: true })).replayed, true)
  assert.equal((await call(h, 'reviewer', 'reviewPagedDraft', { draftId: d.draftId, decision: 'approve', note: '篡改', sourceVerified: true })).error, 'REVIEW_ALREADY_DECIDED')
  return call(h, 'publisher', 'publishPagedDraft', { draftId: d.draftId, expectedRevision: base ? base.revision : 0 })
}

test('分页编辑只载入当前审核发布及完整来源，权限、缺页和并发发布均失败关闭', async () => {
  const ops = operators(), v = catalog(205), published = await finish(ops.h, v, 'editable')
  const workspace = await ops.editor.activePagedWorkspace()
  assert.equal(workspace.bank.schemaVersion, 4); assert.equal(workspace.bank.questions.it.length, 205)
  assert.equal(Object.keys(workspace.sources).length, 205); assert.equal(workspace.basePublication.releaseId, published.releaseId)
  await assert.rejects(ops.reviewer.activePagedWorkspace(), /NOT_CATALOG_ROLE/)
  const sourceKey = [...ops.h.documents.keys()].find(k => k.startsWith('bps_')), original = copy(ops.h.documents.get(sourceKey))
  ops.h.documents.delete(sourceKey)
  await assert.rejects(ops.editor.activePagedWorkspace(), /PAGED_STAGE_CORRUPT/)
  ops.h.documents.set(sourceKey, original)
  const audit = ops.h.documents.get('bank_publication_1'); audit.approval.payloadDigest = 'corrupt'
  await assert.rejects(ops.editor.activePagedWorkspace(), /INVALID_PUBLISHED_DRAFT/)
  audit.approval.payloadDigest = ops.h.documents.get(audit.approval.draftId).payloadDigest
  ops.h.fail.get = (name, id) => id === 'bank_publication_1'
  await assert.rejects(ops.editor.activePagedWorkspace(), /PAGED_WORKFLOW_FAILED/)
  ops.h.fail.get = null
  const stale = createCatalogAdmin({ getSession: () => ({ logged: true, token: 'editor', openid: 'editor' }), call: async event => {
    const response = await ops.h.main(event)
    if (event.action === 'getPagedPublished') return { ...response, publicationRevision: 2 }
    return response
  } })
  await assert.rejects(stale.activePagedWorkspace(), /STALE_BASE_RELEASE/)
})

test('仅草稿创建人可原子丢弃未封存暂存，故障回滚并保留共享题目页及发布证据', async () => {
  const { h } = operators(), v = catalog(205), draft = await begin(h, v, 'abandon')
  await upload(h, draft.draftId, v)
  const before = JSON.stringify([...h.documents.entries()])
  assert.equal((await call(h, 'reviewer', 'abandonPagedDraft', { draftId: draft.draftId })).error, 'NOT_CATALOG_ROLE')
  h.users.set('editor2', { _id: 'editor2', openid: 'editor2', token: 'editor2', tokenAt: Date.parse('2026-10-30T06:00:00Z') })
  h.config.get('bankRoles').editors.push('editor2')
  assert.equal((await call(h, 'editor2', 'abandonPagedDraft', { draftId: draft.draftId })).error, 'DRAFT_NOT_EDITABLE')
  const sourceKey = [...h.documents.keys()].find(k => k.startsWith('bps_')), source = copy(h.documents.get(sourceKey))
  h.documents.get(sourceKey).page.sources[Object.keys(source.page.sources)[0]].reference = '损坏'
  assert.equal((await call(h, 'editor', 'abandonPagedDraft', { draftId: draft.draftId })).error, 'PAGED_STAGE_CORRUPT')
  h.documents.set(sourceKey, source); assert.equal(JSON.stringify([...h.documents.entries()]), before)
  h.fail.get = (name, id) => id === sourceKey
  assert.equal((await call(h, 'editor', 'abandonPagedDraft', { draftId: draft.draftId })).ok, false)
  h.fail.get = null; assert.equal(JSON.stringify([...h.documents.entries()]), before)
  h.fail.write = (name, id) => id.startsWith('bpi_')
  assert.equal((await call(h, 'editor', 'abandonPagedDraft', { draftId: draft.draftId })).ok, false)
  h.fail.write = null; assert.equal(JSON.stringify([...h.documents.entries()]), before)
  assert.equal((await call(h, 'editor', 'abandonPagedDraft', { draftId: draft.draftId })).state, 'abandoned')
  assert.ok(h.transactions.at(-1).length <= 100)
  assert.equal([...h.documents.keys()].filter(k => k.startsWith('bps_') || k.startsWith('bpi_')).length, 0)
  for (const page of v.publicPages) assert.ok(h.documents.has(paged.pageDocumentId(v.root.releaseId, page.index)))
  assert.equal((await call(h, 'editor', 'abandonPagedDraft', { draftId: draft.draftId })).replayed, true)
  assert.equal((await call(h, 'editor', 'sealPagedDraft', { draftId: draft.draftId })).error, 'DRAFT_NOT_EDITABLE')
  const sealed = await begin(h, v, 'sealed-protected'); await upload(h, sealed.draftId, v)
  await call(h, 'editor', 'sealPagedDraft', { draftId: sealed.draftId })
  assert.equal((await call(h, 'editor', 'abandonPagedDraft', { draftId: sealed.draftId })).error, 'DRAFT_NOT_EDITABLE')
})

test('分片经逐页上传、完整封存和独立审核后原子发布，公开接口不暴露来源', async () => {
  const { h } = operators(), v = catalog(), d = await begin(h, v, 'paged-first')
  assert.equal(d.ok, true)
  assert.equal((await call(h, 'user-token', 'getPagedDraft', { draftId: d.draftId })).error, 'NOT_CATALOG_ROLE')
  assert.equal((await call(h, 'editor', 'sealPagedDraft', { draftId: d.draftId })).error, 'PAGED_DRAFT_INCOMPLETE')
  await upload(h, d.draftId, v)
  const replay = await call(h, 'editor', 'uploadPagedDraftPage', { draftId: d.draftId, page: v.publicPages[0], sourcePage: v.privatePages[0] })
  assert.equal(replay.replayed, true)
  assert.equal((await h.main({ action: 'getPagedPage', releaseId: v.root.releaseId, index: 0 })).error, 'PUBLISHED_RELEASE_NOT_FOUND')
  assert.equal((await call(h, 'editor', 'sealPagedDraft', { draftId: d.draftId })).ok, true)
  assert.equal((await call(h, 'reviewer', 'reviewPagedDraft', { draftId: d.draftId, decision: 'approve', note: '未逐页', sourceVerified: true })).error, 'REVIEW_PAGES_REQUIRED')
  assert.equal((await call(h, 'editor', 'reviewPagedDraft', { draftId: d.draftId, decision: 'approve', note: '自审', sourceVerified: true })).error, 'NOT_CATALOG_ROLE')
  assert.equal((await review(h, d.draftId, v)).ok, true)
  assert.equal((await call(h, 'editor', 'publishPagedDraft', { draftId: d.draftId, expectedRevision: 0 })).error, 'NOT_CATALOG_ROLE')
  const published = await call(h, 'publisher', 'publishPagedDraft', { draftId: d.draftId, expectedRevision: 0 })
  assert.equal(published.ok, true); assert.equal(published.publicationRevision, 1)
  const page = await h.main({ action: 'getPagedPage', releaseId: v.root.releaseId, index: 0 })
  assert.equal(page.ok, true); assert.equal(JSON.stringify(page).includes('synthetic:'), false)
  assert.equal((await h.main({ action: 'getPagedPublished' })).root.releaseId, v.root.releaseId)
  assert.equal((await call(h, 'publisher', 'publishPagedDraft', { draftId: d.draftId, expectedRevision: 0 })).alreadyPublished, true)
})

test('审核人权限被撤销或来源页面损坏时不得发布', async () => {
  const { h } = operators(), v = catalog(2), d = await begin(h, v, 'role-and-source')
  await upload(h, d.draftId, v); await call(h, 'editor', 'sealPagedDraft', { draftId: d.draftId })
  const sourceKey = [...h.documents.keys()].find(k => k.startsWith('bps_')), original = copy(h.documents.get(sourceKey))
  h.documents.get(sourceKey).page.sources[Object.keys(original.page.sources)[0]].reference = '损坏'
  assert.equal((await call(h, 'reviewer', 'getPagedDraftPage', { draftId: d.draftId, index: 0 })).error, 'PAGED_STAGE_CORRUPT')
  h.documents.set(sourceKey, original); assert.equal((await review(h, d.draftId, v)).ok, true)
  h.config.get('bankRoles').reviewers = []
  assert.equal((await call(h, 'publisher', 'publishPagedDraft', { draftId: d.draftId, expectedRevision: 0 })).error, 'DRAFT_NOT_APPROVED')
  assert.equal(h.bank(), null)
})

test('审核后题目页或来源页丢失时发布事务拒绝激活', async () => {
  for (const type of ['public', 'private']) {
    const { h } = operators(), v = catalog(2), d = await begin(h, v, 'lost-' + type)
    await upload(h, d.draftId, v); await call(h, 'editor', 'sealPagedDraft', { draftId: d.draftId }); await review(h, d.draftId, v)
    const key = type === 'public' ? paged.pageDocumentId(v.root.releaseId, 0) : [...h.documents.keys()].find(k => k.startsWith('bps_'))
    const saved = copy(h.documents.get(key)); h.documents.delete(key)
    const before = JSON.stringify([...h.documents.entries()])
    assert.equal((await call(h, 'publisher', 'publishPagedDraft', { draftId: d.draftId, expectedRevision: 0 })).error, 'PAGED_STAGE_CORRUPT')
    assert.equal(JSON.stringify([...h.documents.entries()]), before); assert.equal(h.bank(), null)
    h.documents.set(key, saved)
    assert.equal((await call(h, 'publisher', 'publishPagedDraft', { draftId: d.draftId, expectedRevision: 0 })).ok, true)
  }
})

test('20 页最大容量的激活事务不超过 100 次数据库操作', async () => {
  const { h } = operators(), v = catalog(2000)
  assert.equal(v.root.pages.length, 20)
  const result = await finish(h, v, 'max-pages')
  assert.equal(result.ok, true)
  assert.ok(h.transactions.at(-1).length <= 100, '最大页数发布也必须符合事务操作预算')
  assert.throws(() => catalog(2001), /PAGED_CATALOG_TOO_LARGE/)
})

test('现有稳定身份的 v3 发布可升级分页，旧单文档草稿不能覆盖分页发布', async () => {
  const ops = operators(), input = copy(sample)
  input.bank.schemaVersion = 3; input.bank.manifest.exams = [{ id: 'exam', name: '考试' }]; input.bank.manifest.subjects[0].examId = 'exam'
  const old = await ops.editor.submitDraft(input, { submissionId: 'v3-base', rightsConfirmed: true })
  await ops.approve(old.draftId); const previous = await ops.publisher.publishExam({ draftId: old.draftId, expectedRevision: 0 })
  const stale = await ops.editor.submitDraft(input, { submissionId: 'old-writer', rightsConfirmed: true, basePublication: { revision: 1, releaseId: previous.releaseId } })
  await ops.approve(stale.draftId)
  const bank = { ...input.bank, schemaVersion: 4 }, v = paged.buildPagedCatalog({ ...bank, sources: input.sources })
  const next = await finish(ops.h, v, 'v4-upgrade', { revision: 1, releaseId: previous.releaseId })
  assert.equal(next.ok, true); assert.equal(next.publicationRevision, 2)
  await assert.rejects(ops.publisher.publishExam({ draftId: stale.draftId, expectedRevision: 2 }), /STALE_BASE_RELEASE|PAGED_PROTOCOL_REQUIRED/)
  assert.equal((await ops.h.main({ action: 'getPagedPublished' })).root.releaseId, v.root.releaseId)
})

test('上传和发布的事务写失败不留下半页或半个发布，重试可完成', async () => {
  const { h } = operators(), v = catalog(2), d = await begin(h, v, 'paged-fault')
  const before = JSON.stringify([...h.documents.entries()])
  h.fail.write = (name, id) => id.startsWith('bps_')
  assert.equal((await call(h, 'editor', 'uploadPagedDraftPage', { draftId: d.draftId, page: v.publicPages[0], sourcePage: v.privatePages[0] })).ok, false)
  h.fail.write = null; assert.equal(JSON.stringify([...h.documents.entries()]), before)
  await upload(h, d.draftId, v); await call(h, 'editor', 'sealPagedDraft', { draftId: d.draftId }); await review(h, d.draftId, v)
  const staged = JSON.stringify([...h.documents.entries()])
  h.fail.write = (name, id) => id === 'bank_identity_registry'
  assert.equal((await call(h, 'publisher', 'publishPagedDraft', { draftId: d.draftId, expectedRevision: 0 })).ok, false)
  h.fail.write = null; assert.equal(JSON.stringify([...h.documents.entries()]), staged)
  assert.equal((await call(h, 'publisher', 'publishPagedDraft', { draftId: d.draftId, expectedRevision: 0 })).ok, true)
})

test('并发基线过时与已撤回题号复用均不能激活', async () => {
  const { h } = operators(), first = catalog(3), p1 = await finish(h, first, 'identity-first')
  const base = { revision: 1, releaseId: p1.releaseId }, reduced = catalog(2), stale = await begin(h, first, 'stale', base)
  await upload(h, stale.draftId, first); await call(h, 'editor', 'sealPagedDraft', { draftId: stale.draftId }); await review(h, stale.draftId, first)
  const p2 = await finish(h, reduced, 'identity-remove', base); assert.equal(p2.ok, true)
  assert.equal((await call(h, 'publisher', 'publishPagedDraft', { draftId: stale.draftId, expectedRevision: 2 })).error, 'STALE_BASE_RELEASE')
  const reused = await finish(h, first, 'identity-reuse', { revision: 2, releaseId: p2.releaseId })
  assert.equal(reused.error, 'QUESTION_ID_RETIRED')
  assert.equal((await h.main({ action: 'getPagedPublished' })).publicationRevision, 2)
})

test('超过 500 题经过完整审核发布后，可按原分片判分且事务操作有界', async () => {
  const { h } = operators(), v = catalog(700), result = await finish(h, v, 'large-end-to-end')
  assert.equal(result.ok, true); assert.equal(v.root.totalQuestions, 700)
  assert.ok(h.transactions.every(trace => trace.length <= 100))
  const page = await h.main({ action: 'getPagedPage', releaseId: result.releaseId, index: 4 })
  assert.equal(page.ok, true)
  const q = { ...page.page.questions[0], bankReleaseId: result.releaseId, catalogProtocol: 4 }, learning = makeHarness({ questionDocuments: h.documents })
  const submitted = await learning.main({ token: 'tokA', action: 'commitPagedAttempts', attemptProtocol: 2, questionProtocol: 3, dataEpoch: 0, attempts: [fact(q)] })
  assert.equal(submitted.ok, true); assert.equal(submitted.attemptReceipts[0].gradingStatus, 'graded')
})

test('管理员客户端网络中断后以同一提交 ID 续传，不重新上传或覆盖不同内容', async () => {
  const ops = operators(), v = catalog(205), original = copy(sample.bank), source = sample.sources['DEMO-1']
  original.schemaVersion = 4; original.manifest = copy(v.root.manifest)
  original.questions.it = v.publicPages.flatMap(page => page.questions)
  const text = JSON.stringify({ bank: original, sources: Object.fromEntries(original.questions.it.map(q => [q.id, source])) })
  const prepared = ops.editor.preparePaged(text)
  assert.equal(prepared.root.releaseId, v.root.releaseId)
  assert.equal(await ops.editor.pagedBase(), null)
  let writes = 0
  ops.h.fail.write = (name, id) => id.startsWith('bps_') && ++writes === 2
  await assert.rejects(ops.editor.submitPaged(prepared, { submissionId: 'resume', rightsConfirmed: true, basePublication: null }), /PAGED_WORKFLOW_FAILED/)
  ops.h.fail.write = null
  const result = await ops.editor.submitPaged(prepared, { submissionId: 'resume', rightsConfirmed: true, basePublication: null })
  assert.equal(result.state, 'sealed')
  assert.equal((await ops.editor.getPagedDraft(result.draftId)).draft.uploadedCount, v.publicPages.length)
  const changed = copy(prepared); changed.evidence.pages[0].digest = '0'.repeat(64)
  await assert.rejects(ops.editor.submitPaged(changed, { submissionId: 'resume', rightsConfirmed: true, basePublication: null }), /BAD_PAGED_CATALOG/)
})

test('上传成功但响应丢失后幂等续传；页面失效时不继续发送后续页', async () => {
  const ops = operators(), v = catalog(205)
  let loseAck = true, active = true
  const editor = createCatalogAdmin({ getSession: () => ({ logged: true, openid: 'editor', token: 'editor' }), call: async data => {
    const result = await ops.h.main(data)
    if (loseAck && data.action === 'uploadPagedDraftPage') { loseAck = false; throw new Error('lost ack') }
    return result
  } })
  await assert.rejects(editor.submitPaged(v, { submissionId: 'lost-ack', rightsConfirmed: true, basePublication: null }), /NETWORK_ERROR/)
  const resume = await editor.submitPaged(v, { submissionId: 'lost-ack', rightsConfirmed: true, basePublication: null })
  assert.equal(resume.state, 'sealed')
  await assert.rejects(editor.submitPaged(v, { submissionId: 'stale-context', rightsConfirmed: true, basePublication: null,
    onProgress: () => { active = false } }, () => active), /STALE_OPERATOR_CONTEXT/)
  const draft = [...ops.h.documents.values()].find(item => item.kind === 'pagedCatalogDraft' && item.submissionId === 'stale-context')
  assert.equal(draft.uploadedCount, 1); assert.equal(draft.state, 'uploading')
})

test('分页发布撤回仅移除指定题目，绑定基线并保留其余来源', async () => {
  const ops = operators(), v = catalog(205), first = await finish(ops.h, v, 'withdraw-base')
  const draftId = [...ops.h.documents.values()].find(doc => doc.kind === 'pagedCatalogDraft' && doc.state === 'published').draftId
  const removed = v.publicPages[1].questions[0].id
  const d = await ops.editor.withdrawPaged({ draftId, questionIds: [removed], submissionId: 'withdraw', rightsConfirmed: true })
  const staged = (await ops.editor.getPagedDraft(d.draftId)).draft
  assert.equal(staged.root.totalQuestions, 204); assert.equal(staged.basePublication.releaseId, first.releaseId)
  for (let i = 0; i < staged.root.pages.length; i++) await ops.reviewer.getPagedDraftPage(d.draftId, i)
  await ops.reviewer.reviewPaged({ draftId: d.draftId, decision: 'approve', note: '核验', sourceVerified: true })
  assert.equal((await ops.publisher.publishPaged({ draftId: d.draftId, expectedRevision: 1 })).ok, true)
  await assert.rejects(ops.editor.withdrawPaged({ draftId, questionIds: [removed], submissionId: 'stale', rightsConfirmed: true }), /STALE_BASE_RELEASE/)
})
