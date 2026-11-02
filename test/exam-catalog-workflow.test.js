const { test } = require('node:test')
const assert = require('node:assert/strict')
const { operators } = require('./support/catalog-operators.js')
const { makeHarness } = require('./support/study-sync-harness.js')
const { fact, commit } = require('./support/grading-fixture.js')
const sample = require('../docs/examples/catalog-import.json')
const copy = x => JSON.parse(JSON.stringify(x))
const examInput = () => {
  const value = copy(sample)
  value.bank.schemaVersion = 3
  value.bank.manifest.exams = [{ id: 'architecture', name: '系统架构设计师' }]
  value.bank.manifest.subjects[0].examId = 'architecture'
  return value
}
const draft = (h, input, id, basePublication) => h.main({ action: 'createExamDraft', token: 'editor', bank: input.bank,
  sources: input.sources, submissionId: id, rightsConfirmed: true, ...(basePublication ? { basePublication } : {}) })
const approve = (h, draftId) => h.main({ action: 'reviewDraft', token: 'reviewer', draftId, decision: 'approve', note: '核对合成题目', sourceVerified: true })
const publish = (h, draftId, expectedRevision) => h.main({ action: 'publishExamDraft', token: 'publisher', draftId, expectedRevision })

test('考试草稿仅新协议接收，独立审核后发布且旧读取接口明确拒绝', async () => {
  const { h } = operators(), input = examInput()
  assert.equal((await h.main({ action: 'createDraft', token: 'editor', ...input, submissionId: 'legacy', rightsConfirmed: true })).error, 'EXAM_PROTOCOL_REQUIRED')
  const noVersion = copy(input); delete noVersion.bank.schemaVersion
  assert.equal((await h.main({ action: 'createDraft', token: 'editor', ...noVersion, submissionId: 'stripped', rightsConfirmed: true })).error, 'EXAM_PROTOCOL_REQUIRED')
  assert.equal((await h.main({ action: 'createExamDraft', token: 'user-token', ...input, submissionId: 'normal', rightsConfirmed: true })).error, 'NOT_CATALOG_ROLE')
  const d = await draft(h, input, 'new')
  assert.equal(d.ok, true)
  assert.equal((await h.main({ action: 'reviewDraft', token: 'editor', draftId: d.draftId, decision: 'approve', note: '自审', sourceVerified: true })).error, 'NOT_CATALOG_ROLE')
  assert.equal((await publish(h, d.draftId, 0)).error, 'DRAFT_NOT_APPROVED')
  assert.equal((await approve(h, d.draftId)).ok, true)
  assert.equal((await h.main({ action: 'publishDraft', token: 'publisher', draftId: d.draftId, expectedRevision: 0 })).error, 'EXAM_PROTOCOL_REQUIRED')
  const result = await publish(h, d.draftId, 0)
  assert.equal(result.ok, true)
  assert.equal((await h.main({ action: 'getPublished' })).error, 'EXAM_PROTOCOL_REQUIRED')
  assert.equal((await h.main({ action: 'get' })).error, 'EXAM_PROTOCOL_REQUIRED')
  const active = await h.main({ action: 'getExamPublished' })
  assert.equal(active.bank.manifest.subjects[0].examId, 'architecture')
  assert.equal(active.bank.releaseId, result.releaseId)
  const q = active.bank.questions.it[0]
  assert.equal((await h.main({ action: 'getVersion', releaseId: result.releaseId, versionId: q.versionId })).question.id, q.id)
  assert.equal((await h.main({ action: 'publish', token: 'admin-token', bank: input.bank, reviewed: true, expectedRevision: 1 })).error, 'EXAM_PROTOCOL_REQUIRED')
})

test('编辑必须绑定发布基线，并发发布后不能用新修订覆盖', async () => {
  const { h } = operators(), input = examInput()
  const initial = await draft(h, input, 'initial'); await approve(h, initial.draftId)
  const first = await publish(h, initial.draftId, 0), base = { revision: 1, releaseId: first.releaseId }
  assert.equal((await draft(h, input, 'missing-base')).error, 'BASE_PUBLICATION_REQUIRED')
  const a = copy(input), b = copy(input)
  a.bank.questions.it[0].stem = '第一项修改'; b.bank.questions.it[0].stem = '另一项修改'
  const da = await draft(h, a, 'a', base), db = await draft(h, b, 'b', base)
  await approve(h, da.draftId); await approve(h, db.draftId)
  assert.equal((await publish(h, da.draftId, 1)).ok, true)
  assert.equal((await publish(h, db.draftId, 2)).error, 'STALE_BASE_RELEASE')
  assert.equal((await draft(h, b, 'late', base)).error, 'STALE_BASE_RELEASE')
  assert.equal((await h.main({ action: 'getExamPublished' })).bank.questions.it[0].stem, '第一项修改')
  assert.equal(h.documents.get(first.releaseId).bank.questions.it[0].stem, input.bank.questions.it[0].stem)
})

test('已发布题目的章节身份不可移动，改名不会改变身份', async () => {
  const { h } = operators(), input = examInput()
  const first = await draft(h, input, 'identity'); await approve(h, first.draftId)
  const published = await publish(h, first.draftId, 0), base = { revision: 1, releaseId: published.releaseId }
  const active = (await h.main({ action: 'getExamPublished' })).bank
  const changed = { bank: copy(active), sources: copy(input.sources) }
  changed.bank.manifest.subjects[0].chapters.push({ key: 'new', name: '新章节' })
  changed.bank.questions.it[0].chapter = '新章节'
  assert.equal((await draft(h, changed, 'move', base)).error, 'QUESTION_SCOPE_IMMUTABLE')
  changed.bank.questions.it[0].chapter = active.questions.it[0].chapter
  changed.bank.manifest.subjects[0].chapters[0].name = '章节新名称'
  assert.equal((await draft(h, changed, 'rename', base)).ok, true)
})

test('旧发布转换不得沿用题号悄悄改变学习记录归属', async () => {
  const ops = operators(), old = await ops.editor.submitDraft(copy(sample), { submissionId: 'legacy', rightsConfirmed: true })
  await ops.approve(old.draftId); const previous = await ops.publisher.publish({ draftId: old.draftId, expectedRevision: 0 })
  const input = examInput(), before = copy(ops.h.bank())
  const result = await draft(ops.h, input, 'unsafe-conversion', { revision: 1, releaseId: previous.releaseId })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'LEGACY_IDENTITY_MIGRATION_REQUIRED')
  assert.deepEqual(ops.h.bank(), before)
})

test('已撤回题号永久保留，后续草稿不能重新启用或改变其身份', async () => {
  const { h } = operators(), input = examInput()
  const first = await draft(h, input, 'registry-first'); await approve(h, first.draftId)
  const p1 = await publish(h, first.draftId, 0)
  const reduced = copy(input), removed = reduced.bank.questions.it.shift(); delete reduced.sources[removed.id]
  const d2 = await draft(h, reduced, 'registry-remove', { revision: 1, releaseId: p1.releaseId }); await approve(h, d2.draftId)
  const p2 = await publish(h, d2.draftId, 1); assert.equal(p2.ok, true)
  const result = await draft(h, input, 'registry-reuse', { revision: 2, releaseId: p2.releaseId })
  assert.equal(result.ok, false); assert.equal(result.error, 'QUESTION_ID_RETIRED')
  assert.equal((await h.main({ action: 'getExamPublished' })).publicationRevision, 2)
})

test('题号登记缺页、内容损坏及读失败均不能作为空登记继续', async () => {
  const { h } = operators(), input = examInput()
  const first = await draft(h, input, 'registry-test'); await approve(h, first.draftId)
  const p = await publish(h, first.draftId, 0), base = { revision: 1, releaseId: p.releaseId }
  const shardId = [...h.documents.keys()].find(id => /^bank_identity_[0-9a-f]$/.test(id)), shard = copy(h.documents.get(shardId))
  h.documents.delete(shardId)
  assert.equal((await draft(h, input, 'missing-registry', base)).error, 'IDENTITY_REGISTRY_INVALID')
  h.documents.set(shardId, copy(shard)); h.documents.get(shardId).digest = 'tampered'
  assert.equal((await draft(h, input, 'bad-registry', base)).error, 'IDENTITY_REGISTRY_INVALID')
  h.documents.set(shardId, copy(shard)); h.fail.get = (name, id) => id === shardId
  assert.equal((await draft(h, input, 'read-registry', base)).ok, false)
  h.fail.get = null
  assert.equal((await h.main({ action: 'getExamPublished' })).bank.releaseId, p.releaseId)
})

test('题号登记写入失败会回滚发布、归档和登记', async () => {
  const { h } = operators(), input = examInput()
  const first = await draft(h, input, 'registry-write-base'); await approve(h, first.draftId)
  const p = await publish(h, first.draftId, 0), base = { revision: 1, releaseId: p.releaseId }
  const changed = copy(input), q = { ...changed.bank.questions.it[0], id: 'ADDED' }
  changed.bank.questions.it.push(q); changed.sources[q.id] = copy(changed.sources['DEMO-1'])
  const d = await draft(h, changed, 'registry-write', base); await approve(h, d.draftId)
  const before = JSON.stringify([...h.documents.entries()])
  h.fail.write = (name, id) => id === 'bank_identity_registry'
  const result = await publish(h, d.draftId, 1); h.fail.write = null
  assert.equal(result.ok, false)
  assert.equal(JSON.stringify([...h.documents.entries()]), before)
  assert.equal((await publish(h, d.draftId, 1)).ok, true)
})

test('两个空题库起草并发时，后一个不能使用新修订覆盖首次发布', async () => {
  const { h } = operators(), a = examInput(), b = examInput()
  b.bank.questions.it[0].stem = '第二个首次草稿'
  const first = await draft(h, a, 'first'), second = await draft(h, b, 'second')
  await approve(h, first.draftId); await approve(h, second.draftId)
  assert.equal((await publish(h, first.draftId, 0)).ok, true)
  assert.equal((await publish(h, second.draftId, 1)).error, 'STALE_BASE_RELEASE')
  assert.equal((await h.main({ action: 'getExamPublished' })).bank.questions.it[0].stem, a.bank.questions.it[0].stem)
})

test('发布的考试归档可供学习同步按原题判分；伪分数失败不落库', async () => {
  const { h } = operators(), input = examInput(), d = await draft(h, input, 'graded')
  await approve(h, d.draftId); await publish(h, d.draftId, 0)
  const active = await h.main({ action: 'getExamPublished' })
  const q = { ...active.bank.questions.it[0], bankReleaseId: active.bank.releaseId }
  const learning = makeHarness({ questionDocuments: h.documents })
  const submitted = fact(q, ['A'])
  assert.equal((await commit(learning, [{ ...submitted, score: 0 }])).error, 'GRADE_MISMATCH')
  assert.equal(learning.attempts.size, 0)
  const accepted = await commit(learning, [submitted])
  assert.equal(accepted.ok, true)
  assert.equal(accepted.attemptReceipts[0].gradingStatus, 'graded')
})

test('当前完整发布及私有来源只向目录角色提供，缺失或篡改关联不会返回可编辑空白', async () => {
  const { h } = operators(), input = examInput()
  assert.equal((await h.main({ action: 'getActiveCatalogDraft', token: 'user-token' })).error, 'NOT_CATALOG_ROLE')
  assert.equal((await h.main({ action: 'getActiveCatalogDraft', token: 'editor' })).draft, null)
  const d = await draft(h, input, 'source'); await approve(h, d.draftId)
  const result = await publish(h, d.draftId, 0)
  const active = await h.main({ action: 'getActiveCatalogDraft', token: 'editor' })
  assert.equal(active.draft.sources['DEMO-1'].reference, input.sources['DEMO-1'].reference)
  assert.equal(active.basePublication.releaseId, result.releaseId)
  h.documents.get('bank_publication_1').approval.draftId = 'broken'
  assert.equal((await h.main({ action: 'getActiveCatalogDraft', token: 'editor' })).error, 'NO_EDITABLE_PUBLISHED_DRAFT')
  h.fail.get = (name, id) => id === 'bank'
  assert.equal((await h.main({ action: 'getActiveCatalogDraft', token: 'editor' })).ok, false)
})
