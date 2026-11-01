const { test } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const domain = require('../shared/question-domain.js')
const { harness, ADMIN_TOKEN, USER_TOKEN } = require('./support/bank-harness.js')
const copy = value => JSON.parse(JSON.stringify(value))
function fixture() {
  return { manifest: { subjects: [{ key: 'gk', name: '公基', chapters: [{ key: 'law', name: '法律' }] }] },
    questions: { gk: [{ id: 'q1', subject: '公基', chapter: '法律', stem: '旧题面', type: 'single',
      options: [{ key: 'A', text: '甲' }, { key: 'B', text: '乙' }], answer: ['A'], explain: '旧解析' }] } }
}
const publish = (h, bank = fixture(), extra = {}) => h.main({ action: 'publish', token: ADMIN_TOKEN, reviewed: true, expectedRevision: 0, bank, ...extra })

test('可移植 SHA-256 与 Node 标准实现一致，包括 UTF-8 和多块输入', () => {
  for (const value of ['', 'abc', '中文😀', 'x'.repeat(55), '中'.repeat(4096)]) {
    assert.equal(domain.sha256(value), crypto.createHash('sha256').update(value).digest('hex'))
  }
})

test('内容版本稳定，题面/答案/解析变化产生新版本，伪造字段不能指定版本', () => {
  const first = fixture(), before = copy(first), q = first.questions.gk[0]
  const one = domain.buildRelease(first)
  assert.deepEqual(first, before)
  assert.equal(domain.validRelease(one), true)
  for (const patch of [{ stem: '改题面' }, { answer: ['B'] }, { explain: '改解析' }]) {
    const two = domain.buildRelease({ ...first, questions: { gk: [{ ...q, ...patch }] } })
    assert.notEqual(two.questions.gk[0].versionId, one.questions.gk[0].versionId)
    assert.notEqual(two.releaseId, one.releaseId)
  }
  q.versionId = 'spoof'; q.bankReleaseId = 'spoof'
  assert.equal(domain.buildRelease(first).releaseId, one.releaseId)
  const bad = copy(one); bad.questions.gk[0].answer = ['B']
  assert.equal(domain.validRelease(bad), false)
})

test('发布必须由管理员显式确认审核；无效凭据不能回退，未经审核内容不可读', async () => {
  const h = harness({ env: { ADMIN_SECRET: 'secret' } })
  for (const extra of [{ token: USER_TOKEN }, { token: '' }, { adminSecret: 'wrong' }]) {
    assert.equal((await publish(h, fixture(), extra)).ok, false)
  }
  assert.equal((await publish(h, fixture(), { reviewed: false })).error, 'REVIEW_REQUIRED')
  assert.equal(h.documents.size, 0)
  assert.equal((await h.main({ action: 'getPublished' })).bank, null)
  const result = await publish(h, fixture(), { token: '', adminSecret: 'secret' })
  assert.equal(result.ok, true)
  assert.equal(h.documents.get('bank_publication_1').by, 'admin')
})

test('JSON 发布全量校验失败不写入，重复题号/坏答案/章节错配均拒绝', async () => {
  for (const change of [b => b.questions.gk.push(copy(b.questions.gk[0])), b => { b.questions.gk[0].answer = ['Z'] },
    b => { b.questions.gk[0].chapter = '未知' }, b => { b.manifest.subjects[0].key = '__proto__' }]) {
    const h = harness(), bank = fixture(); change(bank)
    assert.equal((await publish(h, bank)).ok, false)
    assert.equal(h.documents.size, 0)
  }
})

test('发布后纠错/撤回不改变旧版本，回滚复用不可变快照并留激活审计', async () => {
  const h = harness(), first = await publish(h)
  const v1 = domain.buildRelease(fixture()).questions.gk[0]
  const archived = copy(h.documents.get(first.releaseId))
  const secondBank = fixture(); secondBank.questions.gk[0].answer = ['B']; secondBank.questions.gk[0].stem = '新题面'
  const second = await publish(h, secondBank, { expectedRevision: 1 })
  assert.equal(second.ok, true)
  assert.equal((await h.main({ action: 'getPublished' })).bank.questions.gk[0].answer[0], 'B')
  const old = await h.main({ action: 'getVersion', releaseId: first.releaseId, versionId: v1.versionId })
  assert.equal(old.question.stem, '旧题面'); assert.equal(old.question.answer[0], 'A'); assert.equal(old.question.explain, '旧解析')
  const withdrawn = fixture(); withdrawn.questions.gk = []
  assert.equal((await publish(h, withdrawn, { expectedRevision: 2 })).ok, true)
  assert.equal((await h.main({ action: 'getPublished' })).bank.questions.gk.length, 0)
  assert.equal((await h.main({ action: 'getVersion', releaseId: first.releaseId, versionId: v1.versionId })).question.stem, '旧题面')
  assert.equal((await publish(h, fixture(), { expectedRevision: 3 })).ok, true)
  assert.deepEqual(h.documents.get(first.releaseId), archived, '激活不能覆盖原发布审计或内容')
  assert.equal(h.documents.get('bank_publication_4').releaseId, first.releaseId)
  assert.equal(h.transactions.every(t => t.length <= 8), true)
})

test('并发发布采用修订 CAS；旧强制 set 不能覆盖新发布协议', async () => {
  const h = harness(), changed = fixture(); changed.questions.gk[0].stem = '另一个发布'
  const results = await Promise.all([publish(h), publish(h, changed)])
  assert.equal(results.filter(r => r.ok).length, 1)
  assert.equal(results.filter(r => r.error === 'STALE_PUBLICATION').length, 1)
  const before = copy([...h.documents])
  assert.equal((await h.main({ action: 'set', token: ADMIN_TOKEN, force: true, bank: changed })).error, 'PUBLICATION_REQUIRED')
  assert.deepEqual([...h.documents], before)
  assert.equal((await h.main({ action: 'get' })).bank.schemaVersion, 2, '旧读者仍读取已发布镜像')
})

test('读失败、无事务、发布中途写失败都不改变当前题库或留下半批版本', async () => {
  const h = harness()
  const legacy = { manifest: { subjects: [] }, questions: {} }; h.seedBank(legacy)
  const before = copy([...h.documents])
  h.fail.get = (name, id) => id === 'bank'
  assert.equal((await publish(h)).ok, false)
  assert.deepEqual([...h.documents], before)
  assert.equal((await h.main({ action: 'getPublished' })).error, 'READ_BANK_FAILED')
  h.fail.get = null; h.fail.write = (name, id) => id === 'bank'
  assert.equal((await publish(h)).error, 'PUBLISH_FAILED')
  assert.deepEqual([...h.documents], before)
  h.fail.write = null
  assert.equal((await publish(h)).ok, true)
  assert.deepEqual(h.documents.get('bank_legacy_backup').bank, legacy)
  const fresh = harness(); delete fresh.db.runTransaction
  assert.equal((await publish(fresh)).error, 'TRANSACTION_REQUIRED')
  assert.equal(fresh.documents.size, 0)
})

test('历史版本读取区分不存在、损坏和访问失败', async () => {
  const h = harness(), result = await publish(h), versionId = domain.buildRelease(fixture()).questions.gk[0].versionId
  const query = { action: 'getVersion', releaseId: result.releaseId, versionId }
  h.fail.get = true
  assert.equal((await h.main(query)).error, 'READ_VERSION_FAILED')
  h.fail.get = null
  assert.equal((await h.main({ ...query, releaseId: 'qb_' + '0'.repeat(64) })).question, null)
  const archive = h.documents.get(result.releaseId); archive.bank.questions.gk[0].stem = '损坏'
  assert.equal((await h.main(query)).error, 'INVALID_RELEASE')
  assert.equal((await publish(h, fixture(), { expectedRevision: 1 })).error, 'RELEASE_CONFLICT')
})

test('旧流水无法从当前题库推断版本，新快照必须与事实身份一致', () => {
  const bank = domain.buildRelease(fixture()), q = { ...bank.questions.gk[0], bankReleaseId: bank.releaseId }
  const fact = { answer: q.answer, questionId: q.id, questionVersionId: q.versionId, bankReleaseId: q.bankReleaseId, questionSnapshot: q }
  assert.deepEqual(domain.attemptQuestion(fact), q)
  assert.equal(domain.attemptQuestion({ questionId: q.id, questionVersionId: 'v1' }), null)
  assert.equal(domain.attemptQuestion({ ...fact, questionVersionId: 'v1' }), null)
  const bad = copy(fact); bad.questionSnapshot.stem = '伪改'
  assert.equal(domain.attemptQuestion(bad), null)
})

test('新作答快照经真实提交/恢复入口保留，伪改版本或丢失快照时整批拒绝', async () => {
  const { makeHarness } = require('./support/study-sync-harness.js')
  const h = makeHarness(), bank = domain.buildRelease(fixture())
  const q = { ...bank.questions.gk[0], bankReleaseId: bank.releaseId }
  const fact = { id: 'local', sessionId: 'session', clientOpId: 'op', questionId: q.id, questionVersionId: q.versionId,
    selected: ['A'], answer: q.answer, score: 1, costMs: 10, createdAt: 1, bankReleaseId: bank.releaseId, questionSnapshot: q,
    projection: { version: 1, subject: q.subject, chapter: q.chapter, date: '2026-11-01' } }
  const commit = attempts => h.main({ action: 'commitVersionedAttempts', questionProtocol: 1, attemptProtocol: 2, token: 'tokA', dataEpoch: 0, attempts })
  assert.equal((await h.main({ action: 'commitAttempts', attemptProtocol: 2, token: 'tokA', attempts: [fact] })).error, 'QUESTION_PROTOCOL_REQUIRED')
  const result = await commit([fact])
  assert.equal(result.ok, true)
  const { validateReceipts } = require('../shared/attempt-domain.js')
  assert.ok(validateReceipts(result, [fact], ['local']))
  const missing = copy(result); delete missing.attemptReceipts[0].attempt.questionSnapshot
  assert.equal(validateReceipts(missing, [fact], ['local']), null, '丢掉原题证据的确认不能出队')
  const restored = (await h.main({ token: 'tokA', action: 'get' })).attempts[0]
  assert.equal(restored.questionSnapshot.stem, '旧题面')
  assert.equal(domain.attemptQuestion(restored).versionId, q.versionId)
  for (const change of [a => { a.questionSnapshot.stem = '变造' }, a => { delete a.questionSnapshot },
    a => { a.answer = ['B'] }, a => { a.questionVersionId = 'qv_' + '0'.repeat(64) }]) {
    const invalid = copy(fact); invalid.id = 'bad'; invalid.clientOpId = 'next'; change(invalid)
    assert.equal((await commit([invalid])).error, 'BAD_QUESTION_VERSION')
    assert.equal(h.attempts.size, 1)
  }
})

test('跨设备合并保留各自新增题目的版本，同题版本冲突保持不可恢复状态', () => {
  const { mergeSession } = require('../shared/stats-merge.js')
  const q = domain.buildRelease(fixture()).questions.gk[0], other = { ...q, id: 'q2' }
  const a = { id: 's', questionIds: ['q1'], questionSnapshots: { q1: q }, submitted: {}, updatedAt: 1 }
  const b = { id: 's', questionIds: ['q2'], questionSnapshots: { q2: other }, submitted: {}, updatedAt: 2 }
  assert.deepEqual(mergeSession(a, b, []).questionSnapshots, { q1: q, q2: other })
  const changed = domain.versionQuestion({ ...q, stem: '另一版' })
  const conflict = mergeSession(a, { ...a, questionSnapshots: { q1: changed }, updatedAt: 2 }, [])
  assert.equal(conflict.questionSnapshots.q1, null)
  const legacy = { id: 's', questionIds: ['q1'], submitted: {}, questionSnapshots: null }
  assert.equal(mergeSession(legacy, legacy, []).questionSnapshots, null, '缺少版本字段不能变成显式版本冲突')
})
