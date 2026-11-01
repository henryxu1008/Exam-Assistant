const { test } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { SERVER_KEY, PREFIX } = require('../shared/attempt-domain.js')
const { makeHarness } = require('./support/study-sync-harness.js')
const fact = (id, extra = {}) => ({ id, sessionId: 's', questionId: 'q', clientOpId: 'one', questionVersionId: 'v1',
  selected: ['A'], answer: ['A'], score: 1, costMs: 100, createdAt: 1000,
  projection: { version: 1, subject: '公基', chapter: '测试', date: '2026-11-01' }, ...extra })
const commit = (h, attempts, extra = {}) => h.main({ token: 'tokA', action: 'commitAttempts', attemptProtocol: 2, dataEpoch: 0, attempts, ...extra })

test('业务重试即使换 ID、时间、用时和日期也只接受首次事实，题目/每日只计一次', async () => {
  const h = makeHarness()
  const first = await commit(h, [fact('local-a')])
  const again = await commit(h, [fact('local-b', { createdAt: 2000, costMs: 999,
    projection: { version: 1, subject: '公基', chapter: '测试', date: '2026-11-02' } })], {
    stats: { records: { q: { id: 'q', attempts: 999, right: 999, answerBy: { __fact__local_b: { attempts: 999, right: 999 } } } } }
  })
  assert.equal(first.ok, true)
  assert.equal(again.ok, true)
  assert.equal(first.attemptReceipts[0].attempt.id, again.attemptReceipts[0].attempt.id)
  assert.equal(again.attemptReceipts[0].attempt.createdAt, 1000)
  assert.equal(again.attemptReceipts[0].attempt.costMs, 100)
  assert.equal(again.stats.records.q.attempts, 1)
  assert.equal(again.stats.daily['2026-11-01'].total, 1)
  assert.equal(again.stats.daily['2026-11-01'].timeMs, 100)
  assert.equal(again.stats.daily['2026-11-02'], undefined)
  assert.equal(h.attempts.size, 1)
  assert.equal(h.studyStats.get('alice').attemptSequence, 1)
})

test('并发同业务提交收敛到一条事实；不同操作正常累计', async () => {
  const h = makeHarness()
  const results = await Promise.all([commit(h, [fact('a')]), commit(h, [fact('b')])])
  assert.ok(results.every(r => r.ok))
  assert.equal(new Set(results.map(r => r.attemptReceipts[0].attempt.id)).size, 1)
  await commit(h, [fact('a', { clientOpId: 'two', score: 0, selected: ['B'] })])
  const got = await h.main({ token: 'tokA' })
  assert.equal(got.attempts.length, 2)
  assert.equal(got.stats.records.q.attempts, 2)
  assert.equal(got.stats.records.q.right, 1)
  assert.equal(got.stats.records.q.wrong, 1)
})

test('同业务改答案回滚整批，查询失败或事务失败都不能产生确认', async () => {
  const h = makeHarness()
  await commit(h, [fact('a')])
  const before = JSON.stringify([...h.studyStats])
  const conflict = await commit(h, [fact('new', { clientOpId: 'new' }), fact('b', { selected: ['B'], score: 0 })])
  assert.equal(conflict.error, 'OPERATION_CONFLICT')
  assert.equal(conflict.attemptReceipts, undefined)
  assert.equal(h.attempts.size, 1)
  assert.equal(JSON.stringify([...h.studyStats]), before)
  h.fail.attempts = new Error('lookup timeout')
  assert.equal((await commit(h, [fact('c', { clientOpId: 'next' })])).error, 'READ_ATTEMPTS_FAILED')
  h.fail.attempts = null
  h.fail.statsWrite = new Error('commit failed')
  assert.equal((await commit(h, [fact('c', { clientOpId: 'next' })])).error, 'TX_FAILED')
  assert.equal(h.attempts.size, 1)
  assert.equal(JSON.stringify([...h.studyStats]), before)
})

test('单条旧事实可以作为业务确认，未知旧贡献不猜测扣减，旧客户端不能再绕过新协议', async () => {
  const h = makeHarness()
  const legacy = fact('legacy'); delete legacy.projection
  await h.main({ token: 'tokA', action: 'update', attempts: [legacy], stats: { records: { q: { id: 'q', attempts: 1, right: 1 } } } })
  const ack = await commit(h, [fact('new-alias')])
  assert.equal(ack.ok, true)
  assert.equal(ack.attemptReceipts[0].attempt.id, 'legacy')
  assert.equal(ack.stats.records.q.attempts, 1)
  assert.equal(h.attempts.size, 1)
  assert.equal((await h.main({ token: 'tokA', action: 'update', attempts: [] })).error, 'ATTEMPT_PROTOCOL_REQUIRED')
  assert.equal((await commit(h, [{ ...legacy, id: 'unknown-alias' }])).error, 'LEGACY_OPERATION_CONFLICT')
})

test('已重复的旧业务不自动选取或删除事实，只报告需对账', async () => {
  const h = makeHarness()
  const legacy = fact('old-a'); delete legacy.projection
  await h.main({ token: 'tokA', action: 'update', attempts: [legacy, { ...legacy, id: 'old-b' }] })
  const result = await commit(h, [fact('new')])
  assert.equal(result.error, 'LEGACY_OPERATION_CONFLICT')
  assert.equal(h.attempts.size, 2)
})

test('新业务 ID 与已有历史 ID 冲突时失败，不覆盖历史或生成重复公开 ID', async () => {
  const h = makeHarness(), input = fact('local')
  const key = JSON.stringify([input.sessionId, input.questionId, input.clientOpId])
  const id = 'op_' + crypto.createHash('sha256').update(JSON.stringify(['alice', 0, key])).digest('hex')
  await h.main({ token: 'tokA', action: 'update', attempts: [{ id, questionId: 'another' }] })
  assert.equal((await commit(h, [input])).error, 'ATTEMPT_ID_CONFLICT')
  assert.equal(h.attempts.size, 1)
})

test('新协议事务最多 32 条，超过上限在写入前拒绝', async () => {
  const h = makeHarness()
  const batch = Array.from({ length: 32 }, (_, i) => fact('a-' + i, { clientOpId: String(i) }))
  assert.equal((await commit(h, [...batch, fact('too-many')])).error, 'BATCH_TOO_LARGE')
  assert.equal(h.attempts.size, 0)
  assert.equal((await commit(h, batch)).ok, true)
  assert.equal(h.attempts.size, 32)
  assert.equal(h.studyStats.get('alice').attemptSequence, 32)
  assert.equal(h.transactions.at(-1).length, 98, '批次上限需符合真实文档操作计数')
  await commit(h, batch.map((f, i) => ({ ...f, id: 'next-' + i, clientOpId: 'next-' + i })))
  const stats = h.studyStats.get('alice')
  assert.equal(stats.records.q.answerBy[SERVER_KEY].attempts, 64)
  assert.equal(Object.keys(stats.records.q.answerBy).filter(k => k !== '__legacy__').length, 1, '确认历史不能逐条塞回聚合文档')
  assert.ok(Object.keys(stats.records.q.answerBy).every(k => !k.startsWith(PREFIX)))
  assert.equal(Object.keys(stats.daily['2026-11-01'].by).filter(k => k !== '__legacy__').length, 1)
})

test('业务地址按账号/清空代次隔离，整体清空后不会复用旧事实或开放旧写协议', async () => {
  const h = makeHarness()
  const a = await commit(h, [fact('a')])
  const b = await commit(h, [fact('a')], { token: 'tokB' })
  assert.notEqual(a.attemptReceipts[0].attempt.id, b.attemptReceipts[0].attempt.id)
  await h.main({ token: 'tokA', action: 'delete', dataEpoch: 0, deleteId: 'reset' })
  assert.equal((await h.main({ token: 'tokA', action: 'update', dataEpoch: 1 })).error, 'ATTEMPT_PROTOCOL_REQUIRED')
  assert.equal((await commit(h, [fact('old')])).error, 'STALE_EPOCH')
  const fresh = await commit(h, [fact('a')], { dataEpoch: 1 })
  assert.notEqual(fresh.attemptReceipts[0].attempt.id, a.attemptReceipts[0].attempt.id)
  assert.equal(fresh.stats.records.q.attempts, 1)
  assert.equal((await h.main({ token: 'tokB' })).attempts.length, 1)
  assert.equal((await h.main({ token: 'tokA' })).attempts[0].sourceAttemptId, undefined)
})

test('旧 update 不能接收新事实分区格式，即使账号尚未启用新协议', async () => {
  const h = makeHarness()
  const result = await h.main({ token: 'tokA', action: 'update', attempts: [fact('new')] })
  assert.equal(result.error, 'ATTEMPT_PROTOCOL_REQUIRED')
  assert.equal(h.attempts.size, 0)
  assert.equal(h.studyStats.size, 0)
})

test('累计用时超出安全整数时整批回滚，不能提交无法对账的计数', async () => {
  const h = makeHarness()
  assert.equal((await commit(h, [fact('a', { costMs: Number.MAX_SAFE_INTEGER })])).ok, true)
  const result = await commit(h, [fact('b', { clientOpId: 'next', costMs: 1 })])
  assert.equal(result.error, 'TX_FAILED')
  assert.equal(result.attemptReceipts, undefined)
  assert.equal(h.attempts.size, 1)
  assert.equal(h.studyStats.get('alice').attemptSequence, 1)
  assert.equal(h.studyStats.get('alice').daily['2026-11-01'].timeMs, Number.MAX_SAFE_INTEGER)
})
