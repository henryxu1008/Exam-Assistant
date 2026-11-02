const { test } = require('node:test')
const assert = require('node:assert/strict')
const { makeHarness } = require('./support/study-sync-harness.js')
const { device } = require('./support/study-sync-device.js')
const question = id => ({ id, subject: '公基', chapter: '测试', type: 'single', answer: ['A'] })
const pending = client => Array.from(client.store.load().attemptOutbox.pending, a => a.id)
const stop = (...clients) => clients.forEach(client => client.store.__clearFlushTimer())

test('作答成功返回前事实与队列一起落盘，保存失败不计数也不锁题', async () => {
  const server = makeHarness()
  const a = device(server)
  await a.settle()
  a.store.createPracticeSession({ subject: '公基', questionIds: ['q'] })
  a.store.flush()
  await a.settle()
  const before = JSON.stringify(a.store.load())
  const calls = a.controls.requests.length
  a.controls.failDataSyncWrite = true
  const failed = a.store.submitAttempt(question('q'), ['A'], true, 10, 'one')
  assert.equal(failed.error, 'PERSIST_ATTEMPT_FAILED')
  assert.equal(JSON.stringify(a.store.load()), before)
  assert.equal(a.controls.requests.length, calls)
  a.controls.failDataSyncWrite = false
  a.controls.offline = true
  const answer = a.store.submitAttempt(question('q'), ['A'], true, 10, 'one')
  assert.equal(answer.ok, true)
  const saved = a.storage.get('exam_quiz_data_v1__alice')
  assert.equal(saved.attempts[0].id, answer.attempt.id)
  assert.equal(saved.attemptOutbox.pending[0].id, answer.attempt.id)
  const reopened = device(server, a.storage, false)
  assert.equal(reopened.store.getRecord('q').attempts, 1)
  assert.equal(pending(reopened)[0], answer.attempt.id)
  stop(a, reopened)
})

test('离线流水数组重排后重启，仍按 ID 补传未确认作答', async () => {
  const server = makeHarness()
  const a = device(server)
  await a.settle()
  a.controls.now = 200000
  a.answer('already-accepted')
  await a.settle()
  a.controls.offline = true
  a.controls.now = 100000
  a.answer('must-upload')
  await a.settle()
  const expected = a.store.getAttempts().find(a => a.questionId === 'must-upload').id
  // 注入历史数组重排：待传事实移到旧下标游标之前，队列本身保持不变。
  const saved = a.storage.get('exam_quiz_data_v1__alice')
  saved.attempts.reverse()
  a.storage.set('exam_quiz_data_v1__alice', saved)
  const reopened = device(server, a.storage, false)
  reopened.wx.__cloudReady = true
  reopened.store.saveSettings({ autoNext: false })
  reopened.store.flush()
  await reopened.settle()
  const cloud = await server.main({ token: 'tokA' })
  assert.equal(cloud.attempts.length, 2)
  assert.ok(cloud.attempts.some(a => a.id === expected))
  assert.equal(pending(reopened).length, 0)
  stop(a, reopened)
})

test('升级不信任旧数组游标，真实流水只重放一次，云端幂等确认', async () => {
  const server = makeHarness()
  const a = device(server)
  await a.settle()
  a.answer('legacy')
  await a.settle()
  const saved = a.store.exportLocalSnapshot()
  delete saved.attemptOutbox
  a.storage.set('exam_quiz_data_v1__alice', saved)
  a.storage.set('exam_quiz_attempt_cursor_v1__alice', 99999)
  const first = device(server, a.storage)
  await first.settle()
  assert.equal(first.controls.requests.filter(r => r.action === 'commitAttempts').flatMap(r => r.attempts).length, 1)
  assert.equal(pending(first).length, 0)
  const again = device(server, first.storage)
  await again.settle()
  assert.equal(again.controls.requests.filter(r => r.action === 'commitAttempts').flatMap(r => r.attempts).length, 0)
  assert.equal((await server.main({ token: 'tokA' })).attempts.length, 1)
  stop(a, first, again)
})

test('前一批确认后后一批失败，重启只补传剩余 ID，最后才发布完整档案', async () => {
  const server = makeHarness()
  const a = device(server, null, false)
  for (let i = 0; i < 49; i++) a.answer('q-' + i)
  const all = pending(a)
  a.wx.__cloudReady = true
  a.controls.failUpdate = 2
  a.store.flush()
  await a.settle()
  assert.deepEqual(pending(a), all.slice(32))
  const partial = await server.main({ token: 'tokA' })
  assert.equal(partial.attempts.length, 32)
  assert.equal(Object.keys(partial.stats.records).length, 0)
  const reopened = device(server, a.storage)
  await reopened.settle()
  const uploads = reopened.controls.requests.filter(r => r.action === 'commitAttempts')
  assert.deepEqual(uploads.flatMap(r => r.attempts.map(a => a.id)), all.slice(32))
  const cloud = await server.main({ token: 'tokA' })
  assert.equal(cloud.attempts.length, 49)
  assert.equal(Object.keys(cloud.stats.records).length, 49)
  assert.equal(pending(reopened).length, 0)
  stop(a, reopened)
})

test('云端成功但回包丢失，重启重传不会重复写流水或计数', async () => {
  const server = makeHarness()
  const a = device(server)
  await a.settle()
  a.controls.loseUpdateAck = true
  a.answer('once')
  await a.settle()
  const id = pending(a)[0]
  assert.ok(id)
  const reopened = device(server, a.storage)
  await reopened.settle()
  const cloud = await server.main({ token: 'tokA' })
  assert.equal(cloud.attempts.length, 1)
  assert.equal(cloud.stats.records.once.attempts, 1)
  assert.equal(pending(reopened).length, 0)
  assert.equal(reopened.controls.requests.find(r => r.action === 'commitAttempts').attempts[0].id, id)
  stop(a, reopened)
})

for (const bad of ['missing', 'unknown', 'epoch']) {
  test(`缺失/非法确认 (${bad}) 不能使作答出队`, async () => {
    const server = makeHarness()
    const a = device(server)
    await a.settle()
    a.controls.changeUpdateResult = result => {
      if (bad === 'missing') { delete result.acceptedAttemptIds; return result }
      return bad === 'epoch' ? { ...result, dataEpoch: 999 } : { ...result, acceptedAttemptIds: ['not-sent'] }
    }
    a.answer('q')
    await a.settle()
    assert.equal(pending(a).length, 1)
    a.controls.changeUpdateResult = null
    a.store.flush()
    await a.settle()
    assert.equal(pending(a).length, 0)
    assert.equal((await server.main({ token: 'tokA' })).attempts.length, 1)
    stop(a)
  })
}

test('确认落盘失败保留队列，重启可幂等确认；不能只修改内存出队', async () => {
  const server = makeHarness()
  const a = device(server)
  await a.settle()
  a.controls.failAckWrite = true
  a.answer('durable-ack')
  await a.settle()
  assert.equal(pending(a).length, 1)
  assert.equal(a.storage.get('exam_quiz_data_v1__alice').attemptOutbox.pending.length, 1)
  const reopened = device(server, a.storage)
  await reopened.settle()
  assert.equal(pending(reopened).length, 0)
  assert.equal((await server.main({ token: 'tokA' })).attempts.length, 1)
  stop(a, reopened)
})

test('确认在途期间追加新作答，只删除被本次明确确认的 ID', async () => {
  const server = makeHarness()
  const a = device(server)
  await a.settle()
  let release
  a.controls.updateAckGate = new Promise(resolve => { release = resolve })
  a.answer('first')
  await new Promise(setImmediate)
  a.answer('second')
  assert.equal(pending(a).length, 2)
  a.controls.updateAckGate = null
  release()
  await a.settle()
  const uploads = a.controls.requests.filter(r => r.action === 'commitAttempts')
  assert.deepEqual(uploads.map(r => r.attempts.map(a => a.questionId)), [['first'], ['second']])
  assert.equal(pending(a).length, 0)
  assert.equal((await server.main({ token: 'tokA' })).attempts.length, 2)
  stop(a)
})


test('新协议事务确认缺少部分 ID 时保留全批，重启后幂等重传', async () => {
  const server = makeHarness()
  const a = device(server, null, false)
  a.answer('first')
  a.answer('second')
  const all = pending(a)
  a.wx.__cloudReady = true
  a.controls.changeUpdateResult = result => ({ ...result, acceptedAttemptIds: [all[0]], attemptReceipts: result.attemptReceipts.filter(r => r.submittedId === all[0]) })
  a.store.flush()
  await a.settle()
  assert.deepEqual(pending(a), all)
  const reopened = device(server, a.storage)
  await reopened.settle()
  assert.deepEqual(reopened.controls.requests.filter(r => r.action === 'commitAttempts').flatMap(r => r.attempts.map(a => a.id)), all)
  assert.equal((await server.main({ token: 'tokA' })).attempts.length, 2)
  stop(a, reopened)
})

test('损坏的队列元数据保留原档案并阻止上传，不把待传记录重建为空', async () => {
  const server = makeHarness()
  const a = device(server, null, false)
  a.answer('original')
  const saved = a.storage.get('exam_quiz_data_v1__alice')
  saved.attemptOutbox.version = 999
  a.storage.set('exam_quiz_data_v1__alice', saved)
  const reopened = device(server, a.storage)
  await reopened.settle()
  assert.equal(reopened.store.getAttempts().length, 1)
  assert.equal(reopened.controls.requests.filter(r => r.action === 'commitAttempts').length, 0)
  assert.equal(reopened.store.submitAttempt(question('new'), ['A'], true, 10, 'new').error, 'PERSIST_ATTEMPT_FAILED')
  assert.deepEqual(reopened.storage.get('exam_quiz_data_v1__alice'), saved)
  stop(a, reopened)
})

test('切换账号后迟到确认不能清除原账号队列或写入新账号；重登后可重放', async () => {
  const server = makeHarness()
  const a = device(server)
  await a.settle()
  let release
  a.controls.updateAckGate = new Promise(resolve => { release = resolve })
  a.answer('alice-only')
  await new Promise(setImmediate)
  a.wx.setStorageSync('exam_quiz_session_v1', { logged: true, token: 'tokB', openid: 'bob' })
  a.store.setUserScope('bob')
  a.store.load()
  a.controls.updateAckGate = null
  release()
  await a.settle()
  assert.equal(a.storage.get('exam_quiz_data_v1__alice').attemptOutbox.pending.length, 1)
  assert.equal(a.store.getAttempts().length, 0)
  assert.equal((await server.main({ token: 'tokB' })).attempts.length, 0)
  a.wx.setStorageSync('exam_quiz_session_v1', { logged: true, token: 'tokA', openid: 'alice' })
  a.store.setUserScope('alice')
  a.store.load()
  await a.settle()
  assert.equal(pending(a).length, 0)
  assert.equal((await server.main({ token: 'tokA' })).attempts.length, 1)
  stop(a)
})
