require('./wx-shim.js')
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { makeHarness } = require('./support/study-sync-harness.js')
const { device } = require('./support/study-sync-device.js')
const { createProtectedStudy } = require('../cloudfunctions/bankSync/protected-study.js')
const { createProtectedStudyClient } = require('../utils/protected-study-client.js')
const { createProtectedOutbox } = require('../utils/protected-study-outbox.js')
const { createProtectedStudySession } = require('../utils/protected-study-session.js')
const { createProtectedReader } = require('../cloudfunctions/bankSync/protected-reader.js')
const { createProtectedPracticeClient } = require('../utils/protected-practice-client.js')
const user = require('../utils/user.js')
const store = require('../utils/store.js')
const config = require('../utils/config.js')
const paged = require('../shared/paged-catalog-domain.js')
const policy = require('../shared/exam-access-policy.js')
const subscriptions = require('../shared/subscription-domain.js')
const sample = require('../docs/examples/catalog-import.json')
const clone = x => JSON.parse(JSON.stringify(x)), NOW = Date.parse('2026-10-30T06:00:00Z')
function setup({ enablePurge = false } = {}) {
  const file = path.join(__dirname, '../cloudfunctions/studySync/index.js')
  const source = enablePurge ? fs.readFileSync(file, 'utf8').replace('const PROTECTED_RECORDS_ENABLED = false', 'const PROTECTED_RECORDS_ENABLED = true') : undefined
  const h = makeHarness({ source }), bank = clone(sample.bank), template = bank.questions.it[0], sourceInfo = sample.sources[template.id]
  bank.schemaVersion = 4; bank.manifest.exams = [{ id: 'exam_a', name: '甲' }, { id: 'exam_b', name: '乙' }]
  bank.manifest.subjects = [{ key: 'a', name: '甲科', examId: 'exam_a', chapters: [{ key: 'net', name: '基础' }] },
    { key: 'b', name: '乙科', examId: 'exam_b', chapters: [{ key: 'net', name: '基础' }] }]
  bank.questions = { a: [{ ...clone(template), id: 'A', subject: 'a', chapter: 'net', stem: '付费题干机密' }],
    b: [{ ...clone(template), id: 'B', subject: 'b', chapter: 'net', stem: '另一考试机密' }] }
  const built = paged.buildPagedCatalog({ ...bank, sources: { A: sourceInfo, B: sourceInfo } })
  h.questions.set('bank', { schemaVersion: 4, root: built.root, publicationRevision: 1 })
  h.questions.set(built.root.releaseId, { kind: 'pagedQuestionBankRelease', root: built.root, publishedAt: NOW })
  for (const page of built.publicPages) h.questions.set(paged.pageDocumentId(page.releaseId, page.index), { kind: 'pagedQuestionBankPage', page })
  h.appConfig.set('examAccessPolicy', policy.buildPolicy(built.root, 1, [{ examId: 'exam_a', access: 'paid' }, { examId: 'exam_b', access: 'free' }]))
  const key = subscriptions.timelineId('alice', 'exam_a')
  h.commerceTimelines.set(key, subscriptions.extend(subscriptions.reserve(subscriptions.empty('alice', 'exam_a'), 'o1', NOW), 'o1', 30, NOW))
  let clock = NOW
  const service = createProtectedStudy({ db: h.db, now: () => clock }), q = built.publicPages[0].questions.find(q => q.id === 'A')
  const input = { action: 'commitProtectedAttempt', token: 'tokA', examId: 'exam_a', dataEpoch: 0, operationId: 'op1',
    releaseId: built.root.releaseId, publicationRevision: 1, questionId: q.id, questionVersionId: q.versionId, selected: [q.answer[0]], costMs: 1000 }
  const call = event => service({ ...input, ...event }, { OPENID: 'alice' })
  const list = options => service({ action: 'getProtectedAttempts', token: 'tokA', examId: 'exam_a', dataEpoch: 0, afterSequence: 0, limit: 50, ...options }, { OPENID: 'alice' })
  return { h, built, q, key, input, service, call, list, clock: n => { clock = n } }
}

test('提交只存不含题目的作答事实，重复请求只判分和计数一次', async () => {
  const { h, call, list, q } = setup()
  const [a, b] = await Promise.all([call({ score: 0, answer: ['forged'], questionSnapshot: { stem: 'injected' } }), call({})])
  assert.equal(a.ok, true); assert.equal(a.attempt.score, 1); assert.equal(b.duplicate, true); assert.deepEqual(a.attempt, b.attempt)
  const saved = JSON.stringify([...h.protectedAttempts.values()]); assert.doesNotMatch(saved, /付费题干机密|questionSnapshot|forged|injected|options|explain|pitfall/)
  assert.equal(Object.hasOwn([...h.protectedAttempts.values()][0], 'answer'), false)
  assert.equal(h.protectedAttempts.size, 1); assert.equal([...h.protectedStudyHeads.values()][0].sequence, 1)
  assert.equal((await call({ selected: ['not_an_option'] })).error, 'OPERATION_CONFLICT')
  const result = await list(); assert.equal(result.ok, true); assert.equal(result.attempts.length, 1); assert.equal(result.correct, 1)
  assert.equal(result.attempts[0].questionVersionId, q.versionId); assert.equal(JSON.stringify(result).includes('付费题干机密'), false)
})

test('身份、考试归属、权益、版本与选项均由服务端核验，读写错误不产生半条记录', async () => {
  const { h, input, service, call, key, built } = setup()
  assert.equal((await service(input, { OPENID: 'bob' })).error, 'INVALID_TOKEN')
  assert.equal((await call({ examId: 'exam_b' })).error, 'PUBLISHED_QUESTION_NOT_FOUND')
  assert.equal((await call({ selected: ['bad'] })).error, 'BAD_SELECTION')
  assert.equal((await call({ publicationRevision: 2 })).error, 'STALE_RELEASE')
  h.fail.get = name => name === 'commerceTimelines'
  assert.equal((await call({})).error, 'PROTECTED_STUDY_FAILED')
  h.fail.get = null; h.fail.protectedHeadWrite = new Error('injected write')
  assert.equal((await call({})).error, 'PROTECTED_STUDY_FAILED'); assert.equal(h.protectedAttempts.size, 0); assert.equal(h.protectedStudyHeads.size, 0)
  h.fail.protectedHeadWrite = null
  const timeline = h.commerceTimelines.get(key); h.commerceTimelines.set(key, subscriptions.revoke(timeline, 'o1', NOW))
  assert.equal((await call({})).error, 'ENTITLEMENT_REQUIRED')
  h.appConfig.set('examAccessPolicy', policy.buildPolicy(built.root, 1, [{ examId: 'exam_a', access: 'free' }, { examId: 'exam_b', access: 'free' }]))
  assert.equal((await call({})).ok, true)
})

test('记录内容损坏时恢复和重放均失败，平台附加身份字段不影响校验', async () => {
  const { h, call, list } = setup(); await call({})
  const row = [...h.protectedAttempts.values()][0]
  row._openid = 'platform-field'; assert.equal((await list()).ok, true)
  ;[...h.protectedAttempts.values()][0].score = 0
  assert.equal((await list()).error, 'INVALID_PROTECTED_ATTEMPTS')
  assert.equal((await call({})).error, 'INVALID_PROTECTED_ATTEMPTS')
})

test('分页恢复采用固定快照，故障和缺失流水不能报告完成，退款后仍能读取自己的历史事实', async () => {
  const { h, call, list, key } = setup()
  for (let i = 0; i < 3; i++) assert.equal((await call({ operationId: 'op' + i })).ok, true)
  const first = await list({ limit: 2 }); assert.equal(first.hasMore, true); assert.equal(first.nextSequence, 2)
  assert.deepEqual((await list({ afterSequence: 2, limit: 2, snapshotSequence: first.snapshotSequence })).attempts.map(a => a.sequence), [3])
  await call({ operationId: 'op3' })
  assert.equal((await list({ afterSequence: 2, limit: 2, snapshotSequence: first.snapshotSequence })).error, 'SNAPSHOT_CHANGED')
  h.fail.protectedQuery = new Error('timeout'); assert.equal((await list({})).error, 'PROTECTED_STUDY_FAILED'); h.fail.protectedQuery = null
  h.protectedAttempts.delete([...h.protectedAttempts.keys()][1]); assert.equal((await list({})).error, 'INVALID_PROTECTED_ATTEMPTS')
  const timeline = h.commerceTimelines.get(key); h.commerceTimelines.set(key, subscriptions.revoke(timeline, 'o1', NOW))
  assert.equal((await call({ operationId: 'new' })).error, 'ENTITLEMENT_REQUIRED')
  assert.equal((await call({ operationId: 'op0' })).duplicate, true, '确认丢失后退款仍可安全重放回执')
})

test('清空代次阻止旧请求恢复，清理故障可重试且不影响其他账号', async () => {
  const { h, call, list } = setup({ enablePurge: true })
  await call({}); h.protectedAttempts.set('other', { _id: 'other', openid: 'bob', dataEpoch: 0 })
  h.fail.remove = new Error('failure')
  const deletion = { token: 'tokA', action: 'delete', dataEpoch: 0, deleteId: 'del1' }
  assert.equal((await h.main(deletion)).error, 'DELETE_ATTEMPTS_FAILED')
  assert.equal((await call({ operationId: 'old' })).error, 'STALE_EPOCH'); assert.equal((await list({})).error, 'STALE_EPOCH')
  h.fail.remove = null; assert.equal((await h.main(deletion)).ok, true)
  assert.equal(h.protectedAttempts.size, 1); assert.equal(h.protectedAttempts.has('other'), true); assert.equal(h.protectedStudyHeads.size, 0)
  assert.equal((await list({ dataEpoch: 1 })).attempts.length, 0)
})

test('跨设备恢复只在所有分页成功且账号未变时交付完整结果', async () => {
  const { h, service, input, call } = setup()
  for (let i = 0; i < 101; i++) assert.equal((await call({ operationId: 'r' + i })).ok, true)
  let session = { logged: true, openid: 'alice', token: 'tokA' }, calls = 0, failure = false, changeAccount = false
  const client = createProtectedStudyClient({ getSession: () => session, call: async data => {
    calls++
    if (failure && data.afterSequence === 100) throw new Error('offline')
    const result = await service(data, { OPENID: session.openid })
    if (changeAccount && data.afterSequence === 100) session = { logged: true, openid: 'bob', token: 'tokB' }
    return result
  } })
  let ctx = client.capture(), restored = await client.restore('exam_a', 0, ctx)
  assert.equal(restored.attempts.length, 101); assert.equal(restored.correct, 101); assert.equal(calls, 2)
  assert.equal(JSON.stringify(restored).includes('付费题干机密'), false)
  calls = 0; failure = true; await assert.rejects(client.restore('exam_a', 0, ctx), /NETWORK_ERROR/); assert.equal(calls, 2)
  failure = false; changeAccount = true; await assert.rejects(client.restore('exam_a', 0, ctx), /STALE_CONTEXT/)
  ctx = client.capture(); assert.deepEqual((await client.restore('exam_a', 0, ctx)).attempts, [])
  session = { logged: true, openid: 'alice', token: 'tokA' }; ctx = client.capture()
  const receipt = await client.commit({ ...input, operationId: 'r0' }, ctx)
  assert.equal(receipt.duplicate, true); assert.equal(h.protectedAttempts.size, 101)
})

test('本机先持久化无题目内容的待提交事实，回执丢失并重启后幂等确认', async () => {
  const { h, service, input } = setup(), rows = new Map(); let writeError = false
  const storage = { getStorageSync: key => rows.has(key) ? clone(rows.get(key)) : '',
    setStorageSync(key, value) { if (writeError) throw new Error('full'); rows.set(key, clone(value)) } }
  const client = createProtectedStudyClient({ getSession: () => ({ logged: true, openid: 'alice', token: 'tokA' }), call: data => service(data, { OPENID: 'alice' }) })
  const { examId, dataEpoch, operationId, releaseId, publicationRevision, questionId, questionVersionId, selected, costMs } = input
  const op = { examId, dataEpoch, operationId, releaseId, publicationRevision, questionId, questionVersionId, selected, costMs }
  let outbox = createProtectedOutbox(storage)
  writeError = true; assert.throws(() => outbox.enqueue('alice', op), /OUTBOX_WRITE_FAILED/); assert.equal(h.protectedAttempts.size, 0)
  writeError = false; outbox.enqueue('alice', op); assert.equal(JSON.stringify([...rows.values()]).includes('付费题干机密'), false)
  const first = await client.commit(op, client.capture()); assert.equal(first.duplicate, false)
  outbox = createProtectedOutbox(storage)
  const pending = outbox.read('alice').pending[0], receipt = await client.commit(pending, client.capture())
  assert.equal(receipt.duplicate, true); assert.equal(h.protectedAttempts.size, 1)
  assert.throws(() => outbox.acknowledge('alice', pending, { attempt: { ...receipt.attempt, score: 4 } }), /INVALID_RECEIPT/)
  writeError = true; assert.throws(() => outbox.acknowledge('alice', pending, receipt), /OUTBOX_WRITE_FAILED/)
  writeError = false; assert.equal(outbox.acknowledge('alice', pending, receipt), true); assert.equal(outbox.read('alice').pending.length, 0)
})

test('本机队列严格隔离账户、拒绝存储题目字段，确认清空后仅移除旧代次操作', () => {
  const { input } = setup(), rows = new Map()
  const box = createProtectedOutbox({ getStorageSync: key => rows.has(key) ? clone(rows.get(key)) : '', setStorageSync: (key, value) => rows.set(key, clone(value)) })
  const { examId, dataEpoch, operationId, releaseId, publicationRevision, questionId, questionVersionId, selected, costMs } = input
  const op = { examId, dataEpoch, operationId, releaseId, publicationRevision, questionId, questionVersionId, selected, costMs }
  assert.throws(() => box.enqueue('alice', { ...op, questionSnapshot: { stem: '不应写入' } }), /BAD_PROTECTED_ATTEMPT/)
  box.enqueue('alice', op); box.enqueue('alice', { ...op, dataEpoch: 1, operationId: 'next' }); box.enqueue('bob', op)
  assert.equal(box.retireAfterConfirmedClear('alice', 1), 1)
  assert.deepEqual(box.read('alice').pending.map(item => item.operationId), ['next']); assert.equal(box.read('bob').pending.length, 1)
  assert.throws(() => box.enqueue('bob', { ...op, costMs: 500 }), /OPERATION_CONFLICT/)
})

test('提交回执丢失后，重新进入练习先恢复队列且不重复统计', async () => {
  const { h, service, input } = setup(), rows = new Map(); let loseAck = true
  const client = createProtectedStudyClient({ getSession: () => ({ logged: true, openid: 'alice', token: 'tokA' }), call: async data => {
    const result = await service(data, { OPENID: 'alice' })
    if (data.action === 'commitProtectedAttempt' && loseAck) { loseAck = false; throw new Error('lost ACK') }
    return result
  } })
  const outbox = createProtectedOutbox({ getStorageSync: key => rows.has(key) ? clone(rows.get(key)) : '', setStorageSync: (key, value) => rows.set(key, clone(value)) })
  const create = () => createProtectedStudySession({ client, outbox, captureSync: () => ({ scope: 'alice', token: 'tokA', dataEpoch: 0 }), syncCurrent: () => true })
  const { examId, dataEpoch, operationId, releaseId, publicationRevision, questionId, questionVersionId, selected, costMs } = input
  const operation = { examId, dataEpoch, operationId, releaseId, publicationRevision, questionId, questionVersionId, selected, costMs }
  let current = create(); await assert.rejects(current.submit(current.capture(), operation), /NETWORK_ERROR/)
  assert.equal(outbox.read('alice').pending.length, 1); assert.equal(h.protectedAttempts.size, 1)
  current = create(); const history = await current.prepare('exam_a', current.capture())
  assert.equal(outbox.read('alice').pending.length, 0); assert.equal(history.snapshotSequence, 1); assert.equal(history.correct, 1)
})

test('清空与在途作答交错时保留待确认操作，服务端确认新代次后安全丢弃旧队列', async () => {
  const { h, service, input } = setup({ enablePurge: true }), rows = new Map(); let live = true, epoch = 0
  const outbox = createProtectedOutbox({ getStorageSync: key => rows.has(key) ? clone(rows.get(key)) : '', setStorageSync: (key, value) => rows.set(key, clone(value)) })
  const client = createProtectedStudyClient({ getSession: () => ({ logged: true, openid: 'alice', token: 'tokA' }), call: async data => {
    const result = await service(data, { OPENID: 'alice' }); if (data.action === 'commitProtectedAttempt') live = false
    return result
  } })
  const workflow = createProtectedStudySession({ client, outbox, captureSync: () => ({ scope: 'alice', token: 'tokA', dataEpoch: epoch }), syncCurrent: () => live })
  const { examId, dataEpoch, operationId, releaseId, publicationRevision, questionId, questionVersionId, selected, costMs } = input
  const op = { examId, dataEpoch, operationId, releaseId, publicationRevision, questionId, questionVersionId, selected, costMs }
  await assert.rejects(workflow.submit(workflow.capture(), op), /STALE_CONTEXT/); assert.equal(outbox.read('alice').pending.length, 1)
  assert.equal((await h.main({ action: 'delete', token: 'tokA', dataEpoch: 0, deleteId: 'delete_1' })).ok, true)
  epoch = 1; live = true; const history = await workflow.prepare('exam_a', workflow.capture())
  assert.equal(history.snapshotSequence, 0); assert.equal(outbox.read('alice').pending.length, 0); assert.equal(h.protectedAttempts.size, 0)
})

test('在线练习提交、丢失回执和重新打开页面可恢复内容无关的记录', async t => {
  __wxStorage.clearAll()
  const { h, service } = setup(); let loseAck = true, definition
  const session = { logged: true, openid: 'alice', token: 'tokA' }
  const identity = () => session, ctx = { scope: 'alice', token: 'tokA', dataEpoch: 0 }
  const protectedRead = createProtectedReader({ db: h.db, now: () => NOW })
  const reader = createProtectedPracticeClient({ getSession: identity, call: data => protectedRead(data, { OPENID: 'alice' }) })
  const client = createProtectedStudyClient({ getSession: identity, call: async data => {
    const result = await service(data, { OPENID: 'alice' })
    if (data.action === 'commitProtectedAttempt' && loseAck) { loseAck = false; throw new Error('lost ACK') }
    return result
  } })
  const outbox = createProtectedOutbox(wx)
  const recorder = createProtectedStudySession({ client, outbox, captureSync: () => ctx, syncCurrent: value => value === ctx })
  t.mock.method(user, 'whenReady', callback => callback()); t.mock.method(store, 'getCurrentExam', () => 'exam_a')
  const before = { practice: config.protectedPracticePreview, records: config.protectedRecordsPreview }
  config.protectedPracticePreview = true; config.protectedRecordsPreview = true
  global.Page = value => { definition = value }
  const pagePath = require.resolve('../pages/protected-practice/protected-practice.js'); delete require.cache[pagePath]; require(pagePath)
  const p = Object.assign({}, definition, { data: clone(definition.data), setData(value) { Object.assign(this.data, value) } })
  p.onLoad(); p._client = reader; p._recorder = recorder; p.onShow()
  t.after(() => { p.onUnload(); config.protectedPracticePreview = before.practice; config.protectedRecordsPreview = before.records; delete require.cache[pagePath]; __wxStorage.clearAll() })
  await new Promise(setImmediate); assert.equal(p.data.question.stem, '付费题干机密')
  p.onSelect({ detail: { key: p.data.question.answer[0] } }); await p.onSubmit()
  assert.equal(p.data.question, null); assert.match(p.data.error, /未确认/); assert.equal(outbox.read('alice').pending.length, 1)
  assert.equal(h.protectedAttempts.size, 1); assert.equal(JSON.stringify(wx.getStorageInfoSync().keys.map(key => wx.getStorageSync(key))).includes('付费题干机密'), false)
  await p.restart(); assert.equal(p.data.historyCount, 1); assert.equal(p.data.historyCorrect, 1); assert.equal(outbox.read('alice').pending.length, 0)
  p.onHide(); p.onShow(); await new Promise(setImmediate); assert.equal(p.data.historyCount, 1)
})

test('真实学习仓储在清空待确认和标记读取故障时阻止受保护作答上下文', async () => {
  const server = makeHarness(), d = device(server, undefined, false)
  const initial = d.store.captureProtectedSyncContext(); assert.equal(d.store.isProtectedSyncContextCurrent(initial), true)
  d.store.clearAll(); assert.equal(d.store.isProtectedSyncContextCurrent(initial), false)
  assert.throws(() => d.store.captureProtectedSyncContext(), /PROTECTED_SYNC_UNAVAILABLE/)
  d.controls.failDeleteRead = true; assert.equal(d.store.isProtectedSyncContextCurrent(initial), false)
  assert.throws(() => d.store.captureProtectedSyncContext(), /PROTECTED_SYNC_UNAVAILABLE/)
  d.controls.failDeleteRead = false; d.wx.__cloudReady = true; d.store.flush(); await d.settle()
  const fresh = d.store.captureProtectedSyncContext(); assert.equal(fresh.dataEpoch, 1)
  assert.equal(d.store.isProtectedSyncContextCurrent(fresh), true); d.store.__clearFlushTimer()
})
