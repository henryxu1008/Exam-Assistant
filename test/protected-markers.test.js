const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path')
const { makeHarness } = require('./support/study-sync-harness.js')
const { createProtectedState } = require('../cloudfunctions/bankSync/protected-state.js')
const { createProtectedMarkerClient } = require('../utils/protected-marker-client.js')
const { buildProtectedLearningReport } = require('../utils/protected-learning-report.js')
const paged = require('../shared/paged-catalog-domain.js'), policy = require('../shared/exam-access-policy.js')
const subscriptions = require('../shared/subscription-domain.js'), sample = require('../docs/examples/catalog-import.json')
const clone = x => JSON.parse(JSON.stringify(x)), NOW = Date.parse('2026-10-30T06:00:00Z'), DAY = 86400000
function setup() {
  const file = path.join(__dirname, '../cloudfunctions/studySync/index.js')
  const source = fs.readFileSync(file, 'utf8').replace('const PROTECTED_RECORDS_ENABLED = false', 'const PROTECTED_RECORDS_ENABLED = true')
  const h = makeHarness({ source }), bank = clone(sample.bank), template = bank.questions.it[0], sourceInfo = sample.sources[template.id]
  bank.schemaVersion = 4; bank.manifest.exams = [{ id: 'exam_a', name: '甲' }, { id: 'exam_b', name: '乙' }]
  bank.manifest.subjects = [{ key: 'a', name: '甲科', examId: 'exam_a', chapters: [{ key: 'net', name: '基础' }] },
    { key: 'b', name: '乙科', examId: 'exam_b', chapters: [{ key: 'net', name: '基础' }] }]
  bank.questions = { a: [{ ...clone(template), id: 'A', subject: 'a', chapter: 'net', stem: '保密题干' }],
    b: [{ ...clone(template), id: 'B', subject: 'b', chapter: 'net', stem: '另一考试题干' }] }
  const built = paged.buildPagedCatalog({ ...bank, sources: { A: sourceInfo, B: sourceInfo } })
  h.questions.set('bank', { schemaVersion: 4, root: built.root, publicationRevision: 1 })
  h.questions.set(built.root.releaseId, { kind: 'pagedQuestionBankRelease', root: built.root, publishedAt: NOW })
  for (const page of built.publicPages) h.questions.set(paged.pageDocumentId(page.releaseId, page.index), { kind: 'pagedQuestionBankPage', page })
  h.appConfig.set('examAccessPolicy', policy.buildPolicy(built.root, 1, [{ examId: 'exam_a', access: 'paid' }, { examId: 'exam_b', access: 'free' }]))
  const key = subscriptions.timelineId('alice', 'exam_a')
  h.commerceTimelines.set(key, subscriptions.extend(subscriptions.reserve(subscriptions.empty('alice', 'exam_a'), 'one', NOW), 'one', 30, NOW))
  const service = createProtectedState({ db: h.db, now: () => NOW })
  const base = { action: 'setProtectedMarker', token: 'tokA', examId: 'exam_a', dataEpoch: 0, operationId: 'op1', questionId: 'A',
    field: 'starred', value: true, expectedRevision: 0, releaseId: built.root.releaseId, publicationRevision: 1 }
  const send = event => service({ ...base, ...event }, { OPENID: 'alice' })
  const get = event => send({ action: 'getProtectedMarkers', ...event })
  return { h, built, key, service, base, send, get }
}
test('收藏及掌握跨设备恢复，冲突不覆盖且重试只确认原操作', async () => {
  const { h, send, get } = setup()
  const [first, duplicate] = await Promise.all([send({}), send({})])
  assert.equal(first.revision, 1); assert.equal(duplicate.duplicate, true)
  assert.equal((await send({ operationId: 'other', field: 'mastered' })).error, 'STATE_CONFLICT')
  assert.equal((await send({ value: false })).error, 'OPERATION_CONFLICT')
  assert.equal((await send({ operationId: 'next', field: 'mastered', expectedRevision: 1 })).revision, 2)
  assert.deepEqual((await get()).entries, [{ questionId: 'A', starred: true, mastered: true }])
  assert.doesNotMatch(JSON.stringify([...h.protectedQuestionStates.values(), ...h.protectedStateReceipts.values()]), /保密题干|options|answer/)
})
test('权益、发布及考试归属校验失败不写，退款后仍能恢复历史状态', async () => {
  const { h, key, send, get, service, base } = setup()
  assert.equal((await service(base, { OPENID: 'bob' })).error, 'INVALID_TOKEN')
  assert.equal((await send({ questionId: 'B' })).error, 'QUESTION_UNAVAILABLE')
  assert.equal((await send({ publicationRevision: 2 })).error, 'STALE_RELEASE')
  h.fail.get = name => name === 'protectedQuestionStates'
  assert.equal((await send({})).error, 'PROTECTED_STATE_FAILED'); assert.equal(h.protectedQuestionStates.size, 0)
  h.fail.get = null; h.fail.protectedStateReceiptWrite = new Error('receipt write failed')
  assert.equal((await send({})).error, 'PROTECTED_STATE_FAILED'); assert.equal(h.protectedQuestionStates.size, 0)
  h.fail.protectedStateReceiptWrite = null; assert.equal((await send({})).ok, true)
  h.commerceTimelines.set(key, subscriptions.revoke(h.commerceTimelines.get(key), 'one', NOW))
  assert.equal((await send({ operationId: 'denied', expectedRevision: 1 })).error, 'ENTITLEMENT_REQUIRED')
  assert.equal((await send({})).duplicate, true)
  assert.equal((await get()).entries[0].starred, true)
})
test('清空后旧操作失效，物理清除状态及回执且不影响其他用户', async () => {
  const { h, send, get } = setup(); await send({})
  h.protectedQuestionStates.set('other', { _id: 'other', openid: 'bob', dataEpoch: 0 })
  const deletion = { token: 'tokA', action: 'delete', dataEpoch: 0, deleteId: 'del1' }
  h.fail.remove = new Error('injected'); assert.equal((await h.main(deletion)).error, 'DELETE_ATTEMPTS_FAILED')
  assert.equal((await send({})).error, 'STALE_EPOCH'); assert.equal((await get()).error, 'STALE_EPOCH')
  h.fail.remove = null; assert.equal((await h.main(deletion)).ok, true)
  assert.equal(h.protectedQuestionStates.size, 1); assert.equal(h.protectedQuestionStates.has('other'), true); assert.equal(h.protectedStateReceipts.size, 0)
})
test('客户端不接受损坏数据，切账号后丢弃迟到回执', async () => {
  const { service, base } = setup(); let generation = 1, resolve
  const ctx = { identity: { token: 'tokA' }, dataEpoch: 0, gen: 1 }, current = x => x.gen === generation
  const client = createProtectedMarkerClient({ call: data => service(data, { OPENID: 'alice' }) })
  const initial = await client.get('exam_a', ctx, current); assert.equal(initial.revision, 0)
  const input = { ...base }; delete input.action; delete input.token; delete input.dataEpoch
  assert.equal((await client.set(input, ctx, current)).revision, 1)
  const delayed = createProtectedMarkerClient({ call: () => new Promise(r => { resolve = r }) })
  const pending = delayed.get('exam_a', ctx, current); generation++; resolve({ ok: true, revision: 0, entries: [] })
  await assert.rejects(pending, /STALE_CONTEXT/)
  const bad = createProtectedMarkerClient({ call: async () => ({ ok: true, revision: 0, entries: [{ questionId: 'A', starred: 'yes', mastered: false }] }) })
  generation = 1; await assert.rejects(bad.get('exam_a', ctx, current), /INVALID_RESPONSE/)
})
test('复习日期从已确认作答计算，掌握后不再列为到期，趋势不包含其他考试', () => {
  const facts = [0, 1, 1].map((score, i) => ({ id: 'f' + i, examId: 'exam_a', sequence: i + 1, score, subject: 'a', chapter: 'c', questionId: 'A', questionVersionId: 'v', createdAt: NOW + i * DAY }))
  const history = { attempts: facts, snapshotSequence: 3, correct: 2 }
  const before = buildProtectedLearningReport('exam_a', history, { revision: 0, entries: [] }, NOW + 4 * DAY)
  assert.equal(before.wrongs[0].due, false); assert.equal(before.wrongs[0].dueAt, NOW + 5 * DAY)
  const due = buildProtectedLearningReport('exam_a', history, { revision: 0, entries: [] }, NOW + 5 * DAY)
  assert.equal(due.wrongs[0].due, true)
  const mastered = buildProtectedLearningReport('exam_a', history, { revision: 1, entries: [{ questionId: 'A', starred: true, mastered: true }] }, NOW + 5 * DAY)
  assert.equal(mastered.wrongs[0].due, false); assert.equal(mastered.wrongs[0].starred, true)
  assert.equal(mastered.trend.reduce((sum, day) => sum + day.total, 0), 3)
})
