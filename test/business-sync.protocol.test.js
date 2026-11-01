/** 真实 store + 新提交入口；仅合成数据。 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { device } = require('./support/study-sync-device.js')
const { makeHarness } = require('./support/study-sync-harness.js')
const { auditLearning } = require('../shared/learning-audit.js')
const question = id => ({ id, subject: '公基', chapter: '测试', type: 'single', answer: ['A'] })
const stop = (...clients) => clients.forEach(c => c.store.__clearFlushTimer())
const counts = client => Object.values(client.store.load().daily).reduce((n, day) => n + day.total, 0)
async function forkSession(server, ids = ['q']) {
  const first = device(server)
  await first.settle()
  first.store.createPracticeSession({ subject: '公基', questionIds: ids })
  first.store.flush()
  await first.settle()
  const a = device(server, first.storage), b = device(server, first.storage)
  await Promise.all([a.settle(), b.settle()])
  return [first, a, b]
}

test('双设备同一次业务操作不同本地 ID 收敛为一条事实，题目与每日只计一次', async () => {
  const server = makeHarness(), [first, a, b] = await forkSession(server)
  a.controls.offline = true; b.controls.offline = true
  a.controls.now = new Date('2026-11-01T23:00:00Z').getTime()
  b.controls.now = new Date('2026-11-03T01:00:00Z').getTime()
  const aa = a.store.submitAttempt(question('q'), ['A'], true, 50, 'shared-op')
  const bb = b.store.submitAttempt(question('q'), ['A'], true, 999, 'shared-op')
  assert.notEqual(aa.attempt.id, bb.attempt.id)
  await Promise.all([a.settle(), b.settle()])
  a.controls.offline = false
  await a.store.syncNow()
  b.controls.offline = false
  await b.store.syncNow()
  const cloud = await server.main({ token: 'tokA' })
  assert.equal(cloud.attempts.length, 1)
  assert.equal(cloud.stats.records.q.attempts, 1)
  assert.equal(Object.values(cloud.stats.daily).reduce((n, d) => n + d.total, 0), 1)
  assert.equal(Object.values(cloud.stats.daily).reduce((n, d) => n + d.timeMs, 0), 50)
  for (const client of [a, b]) {
    assert.equal(client.store.getAttempts().length, 1)
    assert.equal(client.store.getAttempts()[0].id, cloud.attempts[0].id)
    assert.equal(client.store.getRecord('q').attempts, 1)
    assert.equal(counts(client), 1)
    assert.equal(client.store.getPracticeSession().submitted.q.attemptId, cloud.attempts[0].id)
    assert.equal(client.store.load().attemptOutbox.pending.length, 0)
  }
  assert.equal(auditLearning(a.store.load()).status, 'consistent')
  assert.equal(auditLearning(b.store.load()).status, 'consistent')
  assert.equal(auditLearning({ ...cloud.stats, attempts: cloud.attempts }).status, 'consistent')
  stop(first, a, b)
})

test('不同业务操作仍分别累计；相同业务改变答案失败且不丢待处理数据', async () => {
  const server = makeHarness(), [first, a, b] = await forkSession(server)
  a.controls.offline = true; b.controls.offline = true
  a.store.submitAttempt(question('q'), ['A'], true, 1, 'one')
  b.store.submitAttempt(question('q'), ['B'], false, 2, 'one')
  await Promise.all([a.settle(), b.settle()])
  a.controls.offline = false; await a.store.syncNow()
  b.controls.offline = false
  const conflict = await b.store.syncNow()
  assert.equal(conflict.error, 'OPERATION_CONFLICT')
  assert.equal(conflict.attempts, 1, '业务冲突不能靠重复提交解决')
  assert.equal(b.store.load().attemptOutbox.pending.length, 1)
  assert.equal((await server.main({ token: 'tokA' })).stats.records.q.attempts, 1)
  a.store.submitAttempt(question('q'), ['B'], false, 2, 'two')
  await a.settle()
  const cloud = await server.main({ token: 'tokA' })
  assert.equal(cloud.attempts.length, 2)
  assert.equal(cloud.stats.records.q.attempts, 2)
  assert.equal(cloud.stats.records.q.wrong, 1)
  stop(first, a, b)
})

test('确认丢失后重启先恢复 canonical 事实也不会暂时重复计数，随后原队列幂等确认', async () => {
  const server = makeHarness(), [first, a, b] = await forkSession(server)
  a.controls.loseUpdateAck = true
  const submitted = a.store.submitAttempt(question('q'), ['A'], true, 8, 'one')
  await a.settle()
  assert.equal(a.store.load().attemptOutbox.pending[0].id, submitted.attempt.id)
  const reopened = device(server, a.storage)
  const observed = []
  reopened.store.onSyncRestored(() => observed.push(reopened.store.getRecord('q').attempts))
  await reopened.settle()
  assert.ok(observed.length > 0)
  assert.ok(observed.every(n => n === 1))
  assert.equal(reopened.store.getAttempts().length, 1)
  assert.equal(reopened.store.load().attemptOutbox.pending.length, 0)
  assert.equal((await server.main({ token: 'tokA' })).attempts.length, 1)
  stop(first, a, b, reopened)
})

test('确认写盘失败保留原事实 ID 与队列，重启可以按原业务确认', async () => {
  const server = makeHarness(), [first, a, b] = await forkSession(server)
  a.controls.failAckWrite = true
  const submitted = a.store.submitAttempt(question('q'), ['A'], true, 1, 'one')
  await a.settle()
  assert.equal(a.store.getAttempts()[0].id, submitted.attempt.id)
  assert.equal(a.store.load().attemptOutbox.pending.length, 1)
  const reopened = device(server, a.storage)
  await reopened.settle()
  assert.equal(reopened.store.load().attemptOutbox.pending.length, 0)
  assert.equal(reopened.store.getRecord('q').attempts, 1)
  assert.equal((await server.main({ token: 'tokA' })).attempts.length, 1)
  stop(first, a, b, reopened)
})

test('分批确认及排队旧快照中的会话引用都归一化，恢复后每个提交都有实际答案', async () => {
  const server = makeHarness(), ids = Array.from({ length: 35 }, (_, i) => 'q' + i)
  const a = device(server, null, false)
  a.store.createPracticeSession({ subject: '公基', questionIds: ids })
  for (const id of ids) a.store.submitAttempt(question(id), ['A'], true, 1, id)
  a.wx.__cloudReady = true
  a.store.flush()
  await a.settle()
  const cloud = await server.main({ token: 'tokA' })
  const facts = new Map(cloud.attempts.map(f => [f.id, f]))
  assert.equal(facts.size, 35)
  for (const id of ids) assert.equal(facts.get(cloud.stats.practiceSession.submitted[id].attemptId).questionId, id)
  assert.equal(cloud.stats.practiceSession.sessionTotal, 35)
  const reopened = device(server)
  await reopened.settle()
  assert.equal(reopened.store.getAttempts().length, 35)
  assert.equal(counts(reopened), 35)
  stop(a, reopened)
})

test('在途期间追加作答，后一个捕获快照不会恢复前一次的临时 ID', async () => {
  const server = makeHarness(), [first, a, b] = await forkSession(server, ['q', 'q2'])
  let release
  a.controls.updateAckGate = new Promise(resolve => { release = resolve })
  a.store.submitAttempt(question('q'), ['A'], true, 1, 'one')
  await new Promise(setImmediate)
  a.store.submitAttempt(question('q2'), ['A'], true, 1, 'two')
  a.controls.updateAckGate = null; release()
  await a.settle()
  const cloud = await server.main({ token: 'tokA' })
  const facts = new Map(cloud.attempts.map(f => [f.id, f]))
  assert.equal(facts.get(cloud.stats.practiceSession.submitted.q.attemptId).questionId, 'q')
  assert.equal(facts.get(cloud.stats.practiceSession.submitted.q2.attemptId).questionId, 'q2')
  assert.equal(counts(a), 2)
  stop(first, a, b)
})

test('旧服务端明确拒绝新提交 action，不能把未知格式误写成成功；本地仍可作答', async () => {
  const server = { main: async data => data.action === 'get'
    ? { ok: true, stats: null, attempts: [], hasMore: false, dataEpoch: 0 }
    : { ok: false, error: 'BAD_ACTION' } }
  const a = device(server)
  await a.settle()
  a.store.createPracticeSession({ subject: '公基', questionIds: ['q'] })
  assert.equal(a.store.submitAttempt(question('q'), ['A'], true, 1, 'one').ok, true)
  await a.settle()
  assert.equal(a.store.load().attemptOutbox.pending.length, 1)
  assert.ok(a.controls.requests.filter(r => r.action !== 'get').every(r => r.action === 'commitAttempts'))
  assert.equal((await a.store.syncNow()).error, 'BAD_ACTION')
  stop(a)
})

for (const bad of ['missing', 'wrong-operation', 'wrong-score', 'invalid-date', 'unknown-submitted', 'missing-server-counts', 'unconfirmed-fact']) {
  test(`确认映射 ${bad} 时不能删除队列或改写本地事实`, async () => {
    const server = makeHarness(), [first, a, b] = await forkSession(server)
    a.controls.changeUpdateResult = result => {
      if (bad === 'missing') delete result.attemptReceipts
      else if (bad === 'unknown-submitted') result.attemptReceipts[0].submittedId = 'not-sent'
      else if (bad === 'wrong-operation') result.attemptReceipts[0].attempt.clientOpId = 'another'
      else if (bad === 'wrong-score') result.attemptReceipts[0].attempt.score = 0
      else if (bad === 'missing-server-counts') delete result.stats.records.q.answerBy.__server_facts_v1__
      else if (bad === 'unconfirmed-fact') result.attemptReceipts[0].attempt.projection.confirmed = false
      else result.attemptReceipts[0].attempt.projection.date = '2026-02-31'
      return result
    }
    const local = a.store.submitAttempt(question('q'), ['A'], true, 1, 'one')
    await a.settle()
    assert.equal(a.store.load().attemptOutbox.pending.length, 1)
    assert.equal(a.store.getAttempts()[0].id, local.attempt.id)
    assert.equal(a.store.getRecord('q').attempts, 1)
    a.controls.changeUpdateResult = null
    assert.equal((await a.store.syncNow()).ok, true)
    assert.equal(a.store.load().attemptOutbox.pending.length, 0)
    assert.equal((await server.main({ token: 'tokA' })).attempts.length, 1)
    stop(first, a, b)
  })
}

test('真实练习多批提交的后一批失败，已确认事实计数可恢复，剩余队列重启继续', async () => {
  const server = makeHarness(), ids = Array.from({ length: 35 }, (_, i) => 'q' + i)
  const a = device(server, null, false)
  a.store.createPracticeSession({ subject: '公基', questionIds: ids })
  for (const id of ids) a.store.submitAttempt(question(id), ['A'], true, 1, id)
  a.controls.failUpdate = 2
  a.wx.__cloudReady = true
  a.store.flush()
  await a.settle()
  assert.equal(a.store.load().attemptOutbox.pending.length, 3)
  const partial = await server.main({ token: 'tokA' })
  assert.equal(partial.attempts.length, 32)
  assert.equal(Object.values(partial.stats.records).reduce((n, r) => n + r.attempts, 0), 32)
  assert.equal(partial.stats.practiceSession, null, '不能把未完成全批的会话标成完成')
  assert.equal(auditLearning({ ...partial.stats, attempts: partial.attempts }).status, 'consistent')
  const reopened = device(server, a.storage)
  await reopened.settle()
  assert.equal(reopened.store.load().attemptOutbox.pending.length, 0)
  const full = await server.main({ token: 'tokA' })
  assert.equal(full.attempts.length, 35)
  assert.equal(full.stats.practiceSession.sessionTotal, 35)
  assert.equal(auditLearning({ ...full.stats, attempts: full.attempts }).status, 'consistent')
  stop(a, reopened)
})

test('升级前未上传的旧会话流水保留历史分区，不回填虚构日期，新作答继续事实计数', async () => {
  const server = makeHarness()
  const old = { id: 'old-local', sessionId: 'legacy-session', questionId: 'old', questionVersionId: 'v1',
    clientOpId: 'old-op', selected: ['A'], answer: ['A'], score: 1, createdAt: 1, costMs: 10 }
  const counter = { total: 1, correct: 1, timeMs: 10, by: { W: { total: 1, correct: 1, timeMs: 10 } } }
  const saved = new Map([
    ['exam_quiz_session_v1', { logged: true, token: 'tokA', openid: 'alice' }],
    ['exam_quiz_data_v1__alice', { version: 3, records: { old: { id: 'old', subject: '公基', chapter: '测试', attempts: 1, right: 1, wrong: 0,
      answerBy: { W: { attempts: 1, right: 1, wrong: 0 } } } },
    daily: { '2026-11-01': { ...counter, subjects: { 公基: counter }, chapters: { 测试: { ...counter, timeMs: 0, by: { W: { total: 1, correct: 1, timeMs: 0 } } } } } },
    attempts: [old], attemptOutbox: { version: 1, pending: [old] },
    practiceSession: { id: 'legacy-session', questionIds: ['old', 'new'], createdAt: 1, updatedAt: 1,
      submitted: { old: { attemptId: old.id, clientOpId: old.clientOpId, score: 1, createdAt: 1 } } } }]
  ])
  const a = device(server, saved)
  await a.settle()
  assert.equal(a.store.load().attemptOutbox.pending.length, 0)
  assert.equal(a.store.getAttempts()[0].projection, undefined)
  assert.equal(a.store.getRecord('old').attempts, 1)
  a.store.submitAttempt(question('new'), ['A'], true, 2, 'new-op')
  await a.settle()
  const cloud = await server.main({ token: 'tokA' })
  assert.equal(cloud.attempts.length, 2)
  assert.equal(cloud.stats.records.old.attempts, 1)
  assert.equal(cloud.stats.records.new.attempts, 1)
  assert.equal(cloud.attempts.find(f => f.questionId === 'old').projection, undefined)
  const report = auditLearning({ ...cloud.stats, attempts: cloud.attempts })
  assert.equal(report.status, 'incomplete')
  assert.equal(report.issues.length, 0)
  assert.ok(report.unknown.some(i => i.code === 'UNATTRIBUTED_LEGACY_FACT'))
  stop(a)
})
