const { test } = require('node:test')
const assert = require('node:assert/strict')
const { makeHarness } = require('./support/study-sync-harness.js')
const update = (h, ids, extra = {}) => h.main({ token: 'tokA', action: 'update', attempts: ids.map((id, i) => ({ id, createdAt: 100 - i, serverSequence: 9999 })), ...extra })
const pull = (h, extra = {}) => h.main({ token: 'tokA', syncProtocol: 2, ...extra })

test('并发提交由事务分配顺序，客户端时间和伪造序号不影响；重放不消耗新序号', async () => {
  const h = makeHarness()
  await Promise.all([update(h, ['a', 'b']), update(h, ['c', 'd'])])
  assert.deepEqual([...h.attempts.values()].map(a => a.serverSequence), [1, 2, 3, 4])
  await update(h, ['a', 'b'])
  assert.equal(h.studyStats.get('alice').attemptSequence, 4)
  const page = await pull(h, { cursor: { dataEpoch: 0, sequence: 1 }, limit: 2 })
  assert.deepEqual(Array.from(page.attempts, a => a.id), ['b', 'c'])
  assert.equal(page.nextSequence, 3)
  assert.equal(page.attempts[0].serverSequence, undefined)
  assert.equal(page.cursor.sequence, 4)
  const tail = await pull(h, { cursor: { dataEpoch: 0, sequence: 1 }, afterSequence: page.nextSequence, syncRevision: page.syncRevision, dataEpoch: 0 })
  assert.equal(tail.stats, null, '同轮后续页不重复传完整聚合快照')
  assert.deepEqual(Array.from(tail.attempts, a => a.id), ['d'])
})

test('历史无序号事实先全量恢复，新事实走增量且不需要改写旧记录', async () => {
  const h = makeHarness()
  h.attempts.set('alice__old', { _id: 'alice__old', openid: 'alice', id: 'old', createdAt: 1000000 })
  const full = await pull(h)
  assert.equal(full.mode, 'bootstrap')
  assert.equal(full.attempts[0].id, 'old')
  assert.equal(full.cursor.sequence, 0)
  await update(h, ['new'])
  const delta = await pull(h, { cursor: full.cursor })
  assert.equal(delta.mode, 'delta')
  assert.deepEqual(Array.from(delta.attempts, a => a.id), ['new'])
  assert.equal(delta.cursor.sequence, 1)
  assert.equal(h.attempts.get('alice__old').serverSequence, undefined)
})

test('分页中并发写入拒绝混合修订，从持久游标重试可见全部事实', async () => {
  const h = makeHarness()
  const baseline = (await pull(h)).cursor
  await update(h, ['a', 'b'])
  const first = await pull(h, { cursor: baseline, limit: 1 })
  await update(h, ['c'])
  const second = await pull(h, { cursor: baseline, afterSequence: first.nextSequence, syncRevision: first.syncRevision, dataEpoch: 0 })
  assert.equal(second.error, 'SNAPSHOT_CHANGED')
  assert.equal(second.cursor, undefined)
  const retry = await pull(h, { cursor: baseline })
  assert.deepEqual(Array.from(retry.attempts, a => a.id), ['a', 'b', 'c'])
})

test('流水/档案写失败回滚序号，重试不会留下空洞或确认未提交事实', async () => {
  const h = makeHarness()
  h.fail.statsWrite = new Error('stats unavailable')
  assert.equal((await update(h, ['a'])).error, 'TX_FAILED')
  assert.equal(h.attempts.size, 0)
  h.fail.statsWrite = null
  await update(h, ['a'])
  assert.equal(h.attempts.get('alice__a').serverSequence, 1)
  h.fail.attempts = new Error('index unavailable')
  const bad = await pull(h, { cursor: { dataEpoch: 0, sequence: 0 } })
  assert.equal(bad.error, 'READ_ATTEMPTS_FAILED')
  assert.equal(bad.cursor, undefined)
})

test('AI 清空保留事实序号，整体清空要求重新建立当前代次基线', async () => {
  const h = makeHarness()
  await update(h, ['same'])
  const old = (await pull(h)).cursor
  await h.main({ token: 'tokA', action: 'clearAI', dataEpoch: 0, clearId: 'clear' })
  assert.equal(h.studyStats.get('alice').attemptSequence, 1)
  assert.equal((await pull(h, { cursor: old })).attempts.length, 0)
  await h.main({ token: 'tokA', action: 'delete', dataEpoch: 0, deleteId: 'reset' })
  await update(h, ['same'], { dataEpoch: 1 })
  assert.equal((await pull(h, { cursor: old })).error, 'CURSOR_RESET_REQUIRED')
  const fresh = await pull(h)
  assert.equal(fresh.cursor.dataEpoch, 1)
  assert.equal(fresh.cursor.sequence, 1)
  assert.equal(fresh.attempts.length, 1)
})

test('增量查询限定当前账号，非法或超前游标不能冒充同步完成', async () => {
  const h = makeHarness()
  await update(h, ['alice'])
  await update(h, ['bob'], { token: 'tokB' })
  assert.deepEqual(Array.from((await pull(h, { token: 'tokB', cursor: { dataEpoch: 0, sequence: 0 } })).attempts, a => a.id), ['bob'])
  for (const cursor of [{ dataEpoch: 0, sequence: 99 }, { dataEpoch: 0, sequence: -1 }, { dataEpoch: 0, sequence: '0' }, { dataEpoch: 1, sequence: 0 }]) {
    const bad = await pull(h, { cursor })
    assert.equal(bad.error, 'CURSOR_RESET_REQUIRED')
    assert.equal(bad.cursor, undefined)
  }
  h.studyStats.get('alice').attemptSequence = 'broken'
  assert.equal((await pull(h)).error, 'READ_STATS_FAILED')
})

test('混跑旧写入器后重新建基线，新写入不能掩盖未编号事实', async () => {
  const h = makeHarness()
  await update(h, ['numbered'])
  const baseline = (await pull(h)).cursor
  // 模拟上一版处理器：追加无序号事实并推进原有修订，保留未知元数据。
  h.attempts.set('alice__legacy', { _id: 'alice__legacy', openid: 'alice', id: 'legacy', createdAt: 1 })
  h.studyStats.get('alice').syncRevision += 1
  assert.equal((await pull(h, { cursor: baseline })).error, 'CURSOR_RESET_REQUIRED')
  await update(h, ['after-legacy'])
  assert.equal((await pull(h, { cursor: baseline })).error, 'CURSOR_RESET_REQUIRED')
  const fresh = await pull(h)
  assert.equal(fresh.cursor.generation, 1)
  assert.deepEqual(Array.from(fresh.attempts, a => a.id).sort(), ['after-legacy', 'legacy', 'numbered'])
  assert.equal((await pull(h, { cursor: fresh.cursor })).attempts.length, 0)
  assert.equal(h.attempts.get('alice__legacy').serverSequence, undefined)
})
