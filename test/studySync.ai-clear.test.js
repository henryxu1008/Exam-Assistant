/** AI 清空协议：真实云函数，事务故障替身，不访问真实数据库。 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { makeHarness } = require('./support/study-sync-harness.js')

const clear = (clearId, extra = {}) => ({ token: 'tokA', action: 'clearAI', dataEpoch: 0, clearId, ...extra })
const update = (aiEpoch, text, extra = {}) => ({ token: 'tokA', action: 'update',
  stats: { aiEpoch, aiMessages: [{ time: 100 + aiEpoch, role: 'user', text }] }, ...extra })

test('独立清空按服务端事务递增，同一操作交错重试不再次清空', async () => {
  const h = makeHarness()
  assert.equal((await h.main(clear('a'))).aiEpoch, 1)
  await h.main(update(1, 'A 之后'))
  assert.equal((await h.main(clear('b'))).aiEpoch, 2)
  await h.main(update(2, 'B 之后'))
  const revision = h.studyStats.get('alice').syncRevision
  const replay = await h.main(clear('a'))
  assert.equal(replay.aiEpoch, 2)
  assert.equal(replay.superseded, true)
  assert.equal(h.studyStats.get('alice').syncRevision, revision)
  assert.equal((await h.main({ token: 'tokA' })).stats.aiMessages[0].text, 'B 之后')
})

test('清空回执按账号隔离，同名 clearId 不影响其他账号', async () => {
  const h = makeHarness()
  await h.main(update(0, 'Alice'))
  await h.main(update(0, 'Bob', { token: 'tokB' }))
  await h.main(clear('same'))
  assert.equal((await h.main({ token: 'tokB' })).stats.aiMessages[0].text, 'Bob')
  assert.equal((await h.main(clear('same', { token: 'tokB' }))).aiEpoch, 1)
  assert.equal((await h.main({ token: 'tokA' })).stats.aiEpoch, 1)
})

for (const incoming of [0, 50]) {
  test(`普通快照不能提交旧或自造 AI 代次 ${incoming}，学习数据仍正常提交`, async () => {
    const h = makeHarness()
    await h.main(clear('a'))
    await h.main(update(1, '当前消息'))
    const event = update(incoming, '不得恢复')
    event.stats.records = { q1: { id: 'q1', attempts: 1, right: 1, lastAt: 1 } }
    event.attempts = [{ id: 'answer-1', questionId: 'q1', score: 1 }]
    const result = await h.main(event)
    assert.equal(result.ok, true)
    assert.equal(result.aiStale, true)
    const got = await h.main({ token: 'tokA' })
    assert.equal(got.stats.aiEpoch, 1)
    assert.equal(got.stats.aiMessages.length, 1)
    assert.equal(got.stats.aiMessages[0].text, '当前消息')
    assert.ok(got.stats.records.q1)
    assert.equal(got.attempts.length, 1)
  })
}

for (const fault of ['receiptRead', 'receiptWrite']) {
  test(`清空回执${fault}失败时整个事务回滚，重试只清空一次`, async () => {
    const h = makeHarness()
    await h.main(update(0, '原消息'))
    const before = JSON.stringify(h.studyStats.get('alice'))
    h.fail[fault] = new Error('injected receipt timeout')
    assert.equal((await h.main(clear('a'))).error, 'CLEAR_AI_FAILED')
    assert.equal(JSON.stringify(h.studyStats.get('alice')), before)
    assert.equal(h.studyStats.size, 1, '失败不发布成功回执')
    h.fail[fault] = null
    assert.equal((await h.main(clear('a'))).aiEpoch, 1)
    assert.equal((await h.main(clear('a'))).aiEpoch, 1)
  })
}

test('整体清空清理旧 AI 回执，旧 AI 清空操作不能越过 dataEpoch', async () => {
  const h = makeHarness()
  await h.main(clear('a'))
  assert.equal(h.studyStats.size, 2)
  await h.main({ token: 'tokA', action: 'delete', dataEpoch: 0, deleteId: 'all' })
  assert.equal(h.studyStats.size, 1)
  assert.equal((await h.main(clear('a'))).error, 'STALE_EPOCH')
  assert.equal((await h.main(clear('a', { dataEpoch: 1 }))).aiEpoch, 1)
})

test('AI 清空无事务或操作参数无效时拒绝，不能降级成功', async () => {
  const h = makeHarness()
  for (const event of [clear(''), clear('a', { dataEpoch: -1 }), clear({ bad: true })]) {
    assert.equal((await h.main(event)).error, 'BAD_CLEAR_OPERATION')
  }
  delete h.db.runTransaction
  assert.equal((await h.main(clear('a'))).error, 'TRANSACTION_REQUIRED')
  assert.equal(h.studyStats.size, 0)
})

test('损坏的清空回执不能冒充成功确认', async () => {
  const h = makeHarness()
  await h.main(clear('a'))
  await h.main(update(1, '保留消息'))
  const receipt = [...h.studyStats.values()].find(row => row.kind === 'aiClearReceipt')
  delete receipt.aiEpoch
  const result = await h.main(clear('a'))
  assert.equal(result.error, 'CLEAR_AI_FAILED')
  assert.equal((await h.main({ token: 'tokA' })).stats.aiMessages[0].text, '保留消息')
})
