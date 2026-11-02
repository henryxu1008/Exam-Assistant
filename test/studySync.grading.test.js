const { test } = require('node:test')
const assert = require('node:assert/strict')
const { makeHarness } = require('./support/study-sync-harness.js')
const { device } = require('./support/study-sync-device.js')
const { release, question, fact, seed, commit } = require('./support/grading-fixture.js')
const questionDomain = require('../shared/question-domain.js')
const grading = require('../shared/grading-domain.js')
const { validateReceipts, addServerCounts } = require('../shared/attempt-domain.js')
const copy = value => JSON.parse(JSON.stringify(value))
const stateOf = h => JSON.stringify([[...h.attempts], [...h.studyStats]])

test('六类题型从发布归档判分，正确/错误选择与同义填空均生成服务端证据', async () => {
  const h = makeHarness(), bank = seed(h, release())
  for (const type of ['single', 'multiple', 'judge', 'uncertain', 'fill', 'sort']) {
    const q = question(bank, type), correct = type === 'fill' ? [' Bei Jing ', '协 议'] : q.answer.slice().reverse()
    if (type === 'sort') correct.reverse()
    const wrong = type === 'fill' ? ['上海', '协议'] : ['multiple', 'uncertain'].includes(type) ? ['A'] : type === 'sort' ? ['A', 'B', 'C'] : ['B']
    for (const [selected, score] of [[correct, 1], [wrong, 0]]) {
      const sent = fact(q, selected, { id: type + score, clientOpId: 'op-' + score, grading: { score: 999 }, serverReceivedAt: 999 })
      const ack = await commit(h, [sent])
      assert.equal(ack.ok, true, JSON.stringify(ack))
      const received = ack.attemptReceipts[0].attempt
      assert.equal(received.score, score)
      assert.equal(ack.attemptReceipts[0].gradingStatus, 'graded')
      assert.equal(grading.validGrading(received), true)
      assert.notEqual(received.serverReceivedAt, 999, '客户端不能指定服务端时间或判分证据')
      assert.ok(validateReceipts(ack, [sent], [sent.id]))
    }
    assert.equal(h.studyStats.get('alice').records[q.id].right, 1)
    assert.equal(h.studyStats.get('alice').records[q.id].wrong, 1)
  }
  assert.equal(h.attempts.size, 12)
  const restored = await h.main({ action: 'get', token: 'tokA' })
  assert.equal(restored.attempts.every(grading.validGrading), true, '恢复保留服务端证据')
})

test('伪造分数整批拒绝，已处理的前一条和聚合/修订号一起回滚', async () => {
  const h = makeHarness(), bank = seed(h, release()), q = question(bank)
  await commit(h, [fact(q)])
  const before = stateOf(h)
  const result = await commit(h, [fact(q, ['A'], { id: 'valid', clientOpId: 'new' }), fact(q, ['B'], { id: 'fake', clientOpId: 'fake', score: 1 })])
  assert.equal(result.error, 'GRADE_MISMATCH')
  assert.equal(result.attemptReceipts, undefined)
  assert.equal(stateOf(h), before)
  assert.ok(h.transactions.at(-1).some(x => x.operation === 'set' && x.name === 'attempts'), '真实事务草稿曾写前一条，失败后回滚')
})

test('自签快照不等于可信发布：未发布、缺归档 ID、草稿、损坏和读失败有独立失败', async () => {
  const bank = release(), q = question(bank)
  for (const [setup, expected] of [
    [() => {}, 'PUBLISHED_RELEASE_NOT_FOUND'],
    [h => h.questions.set(bank.releaseId, { kind: 'catalogDraft', bank, publishedAt: 1 }), 'INVALID_PUBLISHED_RELEASE'],
    [h => { seed(h, copy(bank)).questions.gk[0].stem = '损坏' }, 'INVALID_PUBLISHED_RELEASE'],
    [h => { seed(h, bank); h.fail.releaseRead = new Error('network timeout') }, 'READ_RELEASE_FAILED']
  ]) {
    const h = makeHarness(); setup(h)
    assert.equal((await commit(h, [fact(q)])).error, expected)
    assert.equal(h.attempts.size, 0)
    assert.equal(h.studyStats.size, 0)
  }
  const h = makeHarness(), noRelease = { ...q }; delete noRelease.bankReleaseId
  assert.equal((await commit(h, [fact(noRelease)])).error, 'PUBLISHED_RELEASE_REQUIRED')
  const another = seed(h, release('-other')), fake = { ...q, bankReleaseId: another.releaseId }
  assert.equal((await commit(h, [fact(fake)])).error, 'PUBLISHED_QUESTION_NOT_FOUND')
})

test('非法选择不能成为事实：未知/重复选项、非字符串、空填空和不完整排序均拒绝', async () => {
  const h = makeHarness(), bank = seed(h, release())
  for (const [type, selection] of [['single', ['Z']], ['single', ['A', 'B']], ['multiple', ['A', 'A']], ['fill', [' ', '协议']],
    ['fill', [null, '协议']], ['sort', ['A']], ['single', 'A'], ['multiple', []]]) {
    const result = await commit(h, [fact(question(bank, type), selection)])
    assert.equal(result.error, 'BAD_SELECTION')
  }
  assert.equal(h.attempts.size, 0)
  assert.equal(h.studyStats.size, 0)
})

test('纠错/撤回后补传只使用原发布，后续重试保留首次时间且不重复计数', async () => {
  const h = makeHarness(), bank = seed(h, release()), q = question(bank), input = fact(q)
  const changed = copy(bank); changed.questions.gk[0].answer = ['B']
  const correction = seed(h, questionDomain.buildRelease(changed))
  h.questions.set('bank', { bank: correction })
  const first = await commit(h, [input])
  assert.equal(first.ok, true)
  const accepted = copy([...h.attempts.values()][0])
  h.questions.set('bank', { bank: questionDomain.buildRelease({ ...bank, questions: { gk: [] } }) })
  const late = await commit(h, [fact(q, ['A'], { id: 'late', clientOpId: 'late' })])
  assert.equal(late.ok, true, '撤回后仍能按原发布接受另一条离线作答')
  h.fail.releaseRead = new Error('archive temporarily unavailable')
  const retry = await commit(h, [{ ...input, id: 'retry', costMs: 999, createdAt: 999 }])
  assert.equal(retry.ok, true)
  assert.equal(retry.attemptReceipts[0].attempt.serverReceivedAt, accepted.serverReceivedAt)
  assert.equal(retry.attemptReceipts[0].attempt.costMs, 10)
  assert.deepEqual([...h.attempts.values()][0], accepted)
  assert.equal(h.studyStats.get('alice').records[q.id].attempts, 2)
  assert.equal(h.transactions.at(-1).some(x => x.name === 'questions'), false, '已接受事实不依赖重读发布归档')
})

test('旧已接受版本事实只确认原事实，不能补造判分/接收时间或改写分数', async () => {
  const h = makeHarness(), input = fact(question(release()), ['B'], { score: 1 })
  const old = { ...copy(input), _id: 'alice__old', openid: 'alice', dataEpoch: 0, projection: { ...input.projection, confirmed: true } }
  h.attempts.set(old._id, old)
  const stats = { _id: 'alice', openid: 'alice', dataEpoch: 0, attemptProtocol: 2, records: {}, daily: {} }
  addServerCounts(stats, old); h.studyStats.set('alice', stats)
  const before = copy([...h.attempts])
  const ack = await commit(h, [input])
  assert.equal(ack.ok, true)
  assert.equal(ack.attemptReceipts[0].gradingStatus, 'legacy_unverified')
  assert.equal(ack.attemptReceipts[0].attempt.grading, undefined)
  assert.equal(ack.attemptReceipts[0].attempt.serverReceivedAt, undefined)
  assert.equal(ack.attemptReceipts[0].attempt.score, 1)
  assert.deepEqual([...h.attempts], before)
  assert.ok(validateReceipts(ack, [input], [input.id]))
  assert.equal(h.transactions.at(-1).some(x => x.name === 'questions'), false)
})

test('版本化批次 24 个不同归档最多 98 次事务操作，25 条在写前拒绝且同归档只读一次', async () => {
  const h = makeHarness()
  const inputs = Array.from({ length: 25 }, (_, i) => fact(question(seed(h, release('-' + i)))))
  assert.equal((await commit(h, inputs)).error, 'BATCH_TOO_LARGE')
  assert.equal(h.transactions.length, 0)
  assert.equal((await commit(h, inputs.slice(0, 24))).ok, true)
  assert.equal(h.transactions.at(-1).length, 98)
  const one = makeHarness(), bank = seed(one, release())
  assert.equal((await commit(one, bank.questions.gk.map(q => fact({ ...q, bankReleaseId: bank.releaseId })))).ok, true)
  assert.equal(one.transactions.at(-1).filter(x => x.name === 'questions').length, 1)
})

test('无效身份/旧协议/旧 update 不读归档、不写流水，兼容 v1 只保留未验证事实', async () => {
  const h = makeHarness(), input = fact(question(release()))
  for (const extra of [{ token: '' }, { token: 'invalid' }, { questionProtocol: 1 }, { action: 'commitAttempts' }, { action: 'update' }]) {
    assert.equal((await commit(h, [input], extra)).ok, false)
  }
  assert.equal(h.transactions.length, 0)
  assert.equal(h.questions.size, 0)
  const legacy = { ...input, questionVersionId: 'v1', serverReceivedAt: 123, grading: { score: 1 } }
  delete legacy.questionSnapshot; delete legacy.bankReleaseId
  const result = await commit(h, [legacy], { action: 'commitAttempts' })
  assert.equal(result.ok, true)
  assert.equal(result.attemptReceipts[0].gradingStatus, 'legacy_unverified')
  assert.equal(result.attemptReceipts[0].attempt.grading, undefined)
  assert.equal(result.attemptReceipts[0].attempt.serverReceivedAt, undefined)
})

test('判分证明或协议确认缺失/损坏不能将待传事实出队', async () => {
  const h = makeHarness(), input = fact(question(seed(h, release()))), ack = await commit(h, [input])
  for (const change of [r => { delete r.questionProtocol }, r => { r.questionProtocol = 1 }, r => { delete r.gradingProtocol },
    r => { delete r.attemptReceipts[0].gradingStatus }, r => { delete r.attemptReceipts[0].attempt.grading },
    r => { delete r.attemptReceipts[0].attempt.serverReceivedAt }, r => { r.attemptReceipts[0].attempt.grading.score = 0 },
    r => { r.attemptReceipts[0].attempt.grading.releaseId = 'qb_' + '0'.repeat(64) },
    r => { r.attemptReceipts[0].gradingStatus = 'legacy_unverified' }]) {
    const invalid = copy(ack); change(invalid)
    assert.equal(validateReceipts(invalid, [input], [input.id]), null)
  }
})

test('存量判分证明损坏时不静默降级为旧事实，事务内统计写失败不留下半份判分', async () => {
  const h = makeHarness(), input = fact(question(seed(h, release())))
  await commit(h, [input])
  const stored = [...h.attempts.values()][0]; stored.grading.score = 0
  const before = stateOf(h)
  assert.equal((await commit(h, [input])).error, 'INVALID_STORED_GRADING')
  assert.equal(stateOf(h), before)
  stored.grading.score = 1
  const healthy = stateOf(h)
  h.fail.statsWrite = new Error('stats write failed')
  assert.equal((await commit(h, [{ ...input, id: 'new', clientOpId: 'new' }])).error, 'TX_FAILED')
  assert.equal(stateOf(h), healthy)
})

test('真实设备离线作答在纠错/撤回后补传，ACK 丢失与重启后只接受一次', async () => {
  const h = makeHarness(), bank = seed(h, release()), q = question(bank)
  const proxy = { getSubjects: () => bank.manifest.subjects, snapshotQuestion: questionDomain.snapshotQuestion }
  const first = device(h, undefined, true, proxy)
  let restarted
  try {
    await first.settle(); first.controls.offline = true
    first.store.createPracticeSession({ subject: q.subject, questions: [q], questionIds: [q.id] })
    assert.equal(first.store.submitAttempt(q, ['A'], true, 10, 'offline').ok, true)
    await first.settle()
    const queued = copy(first.store.load().attemptOutbox.pending)
    assert.equal(queued.length, 1)
    const changed = copy(bank); changed.questions.gk[0].answer = ['B']
    h.questions.set('bank', { bank: seed(h, questionDomain.buildRelease(changed)) })
    first.controls.offline = false; first.controls.loseUpdateAck = true
    first.store.flush(); await first.settle()
    assert.equal(h.attempts.size, 1)
    assert.deepEqual(copy(first.store.load().attemptOutbox.pending), queued, '丢 ACK 不改变待传事实')
    first.store.__clearFlushTimer()
    h.questions.set('bank', { bank: questionDomain.buildRelease({ ...bank, questions: { gk: [] } }) })
    restarted = device(h, first.storage, true, proxy)
    await restarted.settle(); restarted.store.flush(); await restarted.settle()
    assert.equal(h.attempts.size, 1)
    assert.equal(restarted.store.load().attemptOutbox.pending.length, 0)
    assert.equal(restarted.store.getAttempts()[0].grading.source, 'published_archive')
    assert.equal(restarted.store.getRecord(q.id).attempts, 1)
    assert.equal(h.studyStats.get('alice').records[q.id].right, 1)
  } finally { first.store.__clearFlushTimer(); if (restarted) restarted.store.__clearFlushTimer() }
})

test('真实设备遇到判分失败、归档读取失败或旧后端时保留待传队列和本地事实', async () => {
  for (const scenario of ['score', 'read', 'old', 'ack']) {
    const h = makeHarness(), bank = seed(h, release()), q = question(bank)
    const server = scenario === 'old' ? { main: data => data.action === 'commitVersionedAttempts' ? Promise.resolve({ ok: false, error: 'QUESTION_PROTOCOL_REQUIRED' }) : h.main(data) } : h
    const d = device(server, undefined, true, { getSubjects: () => bank.manifest.subjects, snapshotQuestion: questionDomain.snapshotQuestion })
    try {
      await d.settle(); d.controls.offline = true
      d.store.createPracticeSession({ subject: q.subject, questions: [q], questionIds: [q.id] })
      d.store.submitAttempt(q, ['B'], scenario === 'score', 10, 'reject')
      await d.settle()
      const queued = copy(d.store.load().attemptOutbox.pending)
      if (scenario === 'read') h.fail.releaseRead = new Error('timeout')
      if (scenario === 'ack') d.controls.changeUpdateResult = result => {
        if (result.ok) delete result.attemptReceipts[0].attempt.grading
        return result
      }
      d.controls.offline = false; d.store.flush(); await d.settle()
      assert.equal(h.attempts.size, scenario === 'ack' ? 1 : 0)
      assert.deepEqual(copy(d.store.load().attemptOutbox.pending), queued)
      assert.equal(d.store.getAttempts()[0].score, scenario === 'score' ? 1 : 0)
      const request = d.controls.requests.findLast(r => r.action === 'commitVersionedAttempts')
      assert.equal(request.questionProtocol, 2)
    } finally { d.store.__clearFlushTimer() }
  }
})

test('真实设备 50 条版本化待传按 24/24/2 分批，每批有证据确认且统计不重算', async () => {
  const h = makeHarness(), bank = seed(h, release()), q = question(bank)
  const d = device(h, undefined, true, { getSubjects: () => bank.manifest.subjects, snapshotQuestion: questionDomain.snapshotQuestion })
  try {
    await d.settle(); d.controls.offline = true
    d.store.createPracticeSession({ subject: q.subject, questions: [q], questionIds: [q.id] })
    for (let i = 0; i < 50; i++) assert.equal(d.store.submitAttempt(q, ['A'], true, 10, 'op-' + i).ok, true)
    await d.settle()
    assert.equal(d.store.load().attemptOutbox.pending.length, 50)
    const start = d.controls.requests.length
    d.controls.offline = false; d.store.flush(); await d.settle()
    assert.deepEqual(d.controls.requests.slice(start).filter(r => r.attempts?.length).map(r => r.attempts.length), [24, 24, 2])
    assert.equal(h.attempts.size, 50)
    assert.equal(d.store.load().attemptOutbox.pending.length, 0)
    assert.equal(d.store.getRecord(q.id).attempts, 50)
    assert.equal(d.store.getAttempts().every(grading.validGrading), true)
  } finally { d.store.__clearFlushTimer() }
})
