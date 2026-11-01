/**
 * studySync 账号隔离 + 写操作串行化回归测试
 * （PR #10 评审 P1 4422339084 / P1 4422339092）
 *
 * 两条是同一类问题的两端：云端的写操作既没有「归属约束」，也没有「顺序保证」。
 */

const { test } = require('node:test')
const assert = require('node:assert/strict')


const clone = (v) => JSON.parse(JSON.stringify(v))

const { makeHarness } = require('./support/study-sync-harness.js')

/** 记录一次 update 上传，含本地流式编号，便于断言并发顺序 */
function updatePayload(n) {
  return {
    version: 3,
    records: { ['q' + n]: { id: 'q' + n, lastAt: 1000 + n } },
    daily: {},
    settings: {},
    practiceSession: null,
    aiMessages: [],
    aiEpoch: 0,
    attempts: [{ id: 'a' + n, questionId: 'q' + n, createdAt: 1000 + n }]
  }
}

/* ------------------------------------------------------------------ *
 * P1 4422339084：attempt 文档 _id 必须按账号隔离
 * ------------------------------------------------------------------ */

test('调用方无法用已知 id 覆盖他人作答流水', async () => {
  const h = makeHarness()

  // alice 先上传自己的一条作答
  await h.main({ token: 'tokA', action: 'update', stats: updatePayload(1), attempts: updatePayload(1).attempts })

  // bob 已知 alice 的 attempt id，试图覆盖并据为己有
  await h.main({
    token: 'tokB',
    action: 'update',
    stats: updatePayload(2),
    attempts: [{ id: 'a1', questionId: 'HACKED', createdAt: 9999 }]
  })

  const original = h.attempts.get('alice__a1')
  const bobCopy = h.attempts.get('bob__a1')

  assert.ok(original, 'alice 的流水应仍在其命名空间下')
  assert.strictEqual(original.questionId, 'q1', 'alice 的作答内容不得被篡改')
  assert.strictEqual(original.openid, 'alice', '归属不得被改写')

  // bob 凭 id 写入只会在自己的命名空间产生一条副本，不影响 alice
  assert.ok(bobCopy, 'bob 的写入落在其自身命名空间')
  assert.strictEqual(bobCopy.openid, 'bob')
})

test('作答流水写入时带上归属 openid', async () => {
  const h = makeHarness()
  await h.main({
    token: 'tokA',
    action: 'update',
    stats: updatePayload(7),
    attempts: updatePayload(7).attempts
  })

  const row = h.attempts.get('alice__a7')
  assert.ok(row, '应按 openid 前缀落库')
  assert.strictEqual(row.openid, 'alice')
})

test('并发上传的作答流水互不覆盖（按账号隔离 _id）', async () => {
  const h = makeHarness()
  await Promise.all([
    h.main({ token: 'tokA', action: 'update', stats: updatePayload(1), attempts: updatePayload(1).attempts }),
    h.main({ token: 'tokB', action: 'update', stats: updatePayload(2), attempts: updatePayload(2).attempts })
  ])

  assert.ok(h.attempts.get('alice__a1'), 'alice 的流水存在')
  assert.ok(h.attempts.get('bob__a2'), 'bob 的流水存在')
  assert.strictEqual(h.attempts.get('alice__a1').openid, 'alice')
  assert.strictEqual(h.attempts.get('bob__a2').openid, 'bob')
})

/* ------------------------------------------------------------------ *
 * P1 4422339092：删除必须排在在途上传之后
 * ------------------------------------------------------------------ */

test('不同账号的同名 attempt id 互不干扰', async () => {
  const h = makeHarness()
  // 两端各自生成了相同的 attempt id（客户端 ID 冲突）
  await h.main({
    token: 'tokA', action: 'update',
    stats: updatePayload(9), attempts: [{ id: 'same', questionId: 'qA', createdAt: 1 }]
  })
  await h.main({
    token: 'tokB', action: 'update',
    stats: updatePayload(9), attempts: [{ id: 'same', questionId: 'qB', createdAt: 2 }]
  })

  assert.strictEqual(h.attempts.get('alice__same').questionId, 'qA')
  assert.strictEqual(h.attempts.get('bob__same').questionId, 'qB')
})

test('跨账号删除不会误删他人数据', async () => {
  const h = makeHarness()
  await h.main({ token: 'tokA', action: 'update', stats: updatePayload(1), attempts: updatePayload(1).attempts })
  await h.main({ token: 'tokB', action: 'update', stats: updatePayload(2), attempts: updatePayload(2).attempts })

  await h.main({ token: 'tokA', action: 'delete', dataEpoch: 0, deleteId: 'delete-1' })

  assert.ok(!h.attempts.has('alice__a1'), 'alice 的流水应被删除')
  assert.ok(h.attempts.get('bob__a2'), 'bob 的流水必须保留')
})

test('删除失败时返回 ok:false，不得承认成功（评审 P2 4425946091）', async () => {
  const h = makeHarness()
  await h.main({ token: 'tokA', action: 'update', stats: updatePayload(1), attempts: updatePayload(1).attempts })

  // 模拟数据库抛出非「不存在」的失败（权限 / 网络 / 配额……）
  h.fail.statsWrite = Object.assign(new Error('permission denied'), { errCode: -502003 })

  const res = await h.main({ token: 'tokA', action: 'delete', dataEpoch: 0, deleteId: 'delete-1' })
  assert.strictEqual(res.ok, false, '删除失败不得报告成功')
  assert.strictEqual(res.error, 'DELETE_STATS_FAILED')
  assert.ok(h.studyStats.has('alice'), '失败时服务端数据应仍在')
})

test('快照读取失败时不得当成「没有云端数据」（评审 P1 4429855402）', async () => {
  const h = makeHarness()
  // 服务端先有一份含 q1 的备份
  await h.main({ token: 'tokA', action: 'update', stats: updatePayload(1), attempts: updatePayload(1).attempts })
  const before = clone(h.studyStats.get('alice'))

  // 模拟读取超时 / 数据库错误（非「不存在」）
  h.fail.get = Object.assign(new Error('read timeout'), { errCode: -502001 })

  let ok = null
  try {
    ok = (await h.main({ token: 'tokA', action: 'update', stats: updatePayload(2), attempts: [] })).ok
  } catch (e) {
    ok = false // 无事务兜底路径会直接抛出，同样不得静默成功
  }

  assert.notStrictEqual(ok, true, '读取失败不得报告成功')
  assert.ok(h.studyStats.get('alice').records.q1, '不得用不完整快照覆盖服务端备份')
  assert.strictEqual(
    h.studyStats.get('alice').records.q1.lastAt,
    before.records.q1.lastAt,
    '服务端已有记录必须原样保留'
  )
})

test('作答流水查询失败不得报告「恢复已完成」（评审 P2 4430849971）', async () => {
  const h = makeHarness()
  await h.main({ token: 'tokA', action: 'update', stats: updatePayload(1), attempts: updatePayload(1).attempts })

  // 模拟流水查询超时 / 数据库错误（非「不存在」）
  h.fail.attempts = Object.assign(new Error('attempts query timeout'), { errCode: -502001 })

  const res = await h.main({ token: 'tokA', action: 'get', skip: 0 })
  assert.strictEqual(res.ok, false, '查询失败必须返回应用层失败')
  assert.strictEqual(res.error, 'READ_ATTEMPTS_FAILED')
  // 决不能返回 {ok:true, attempts: [], hasMore:false}：
  // 端上会当作恢复已完成并停在 bootPulled=true
  assert.notStrictEqual(res.hasMore, false, '不得给出「没有更多了」的假象')
})

test('成功查询且没有作答流水时才返回空列表（评审 P2 4430849971）', async () => {
  const h = makeHarness()

  const res = await h.main({ token: 'tokA', action: 'get', skip: 0 })
  assert.strictEqual(res.ok, true, '成功查询的空页表示尚无流水')
  // 云函数跑在 vm 里，数组原型跨 realm，不能用 deepEqual
  assert.strictEqual(res.attempts.length, 0, '应为空列表')
  assert.strictEqual(res.hasMore, false)
})

test('流水查询的集合/索引缺失与权限错误均不得当成空页', async () => {
  const h = makeHarness()
  for (const error of [
    Object.assign(new Error('collection not exists'), { errCode: -502005 }),
    new Error('index does not exist'),
    new Error('document does not exist'),
    Object.assign(new Error('permission denied'), { errCode: -502003 })
  ]) {
    h.fail.attempts = error
    const res = await h.main({ token: 'tokA', action: 'get', skip: 100 })
    assert.strictEqual(res.ok, false, error.message)
    assert.strictEqual(res.error, 'READ_ATTEMPTS_FAILED')
    assert.strictEqual(res.stats, undefined, '失败时不发布局部档案')
    assert.strictEqual(res.hasMore, undefined, '失败时不发布完成游标')
  }
})

test('流水查询响应结构异常不得当成空页', async () => {
  const h = makeHarness()
  for (const result of [null, {}, { data: null }, { data: {} }]) {
    h.fail.attemptsResult = result
    const res = await h.main({ token: 'tokA', action: 'get' })
    assert.strictEqual(res.ok, false)
    assert.strictEqual(res.error, 'READ_ATTEMPTS_FAILED')
  }
})

test('文档不存在时删除仍算成功（幂等，评审 P2 4425946091）', async () => {
  const h = makeHarness()
  // 从未上传过，studyStats 里没有该文档
  const res = await h.main({ token: 'tokA', action: 'delete', dataEpoch: 0, deleteId: 'delete-1' })
  assert.strictEqual(res.ok, true, '确认不存在应视为已清空')
})

test('无令牌 / 无效令牌时删除被拒绝', async () => {
  const h = makeHarness()
  await h.main({ token: 'tokA', action: 'update', stats: updatePayload(1), attempts: updatePayload(1).attempts })

  assert.strictEqual((await h.main({ action: 'delete', dataEpoch: 0, deleteId: 'delete-1' })).error, 'NO_TOKEN')
  assert.strictEqual((await h.main({ action: 'delete', dataEpoch: 0, deleteId: 'delete-1', token: 'nope' })).error, 'INVALID_TOKEN')
  assert.strictEqual(h.studyStats.size, 1, '被拒绝的删除不得生效')
})

test('运行时不支持事务时拒绝学习档案合并，不能静默退回非原子写入', async () => {
  const h = makeHarness()
  const original = { _id: 'alice', records: { old: { id: 'old', right: 1 } } }
  h.studyStats.set('alice', clone(original))
  delete h.db.runTransaction
  const result = await h.main({ token: 'tokA', action: 'update',
    stats: updatePayload(2), attempts: updatePayload(2).attempts })
  assert.strictEqual(result.ok, false)
  assert.strictEqual(result.error, 'TRANSACTION_REQUIRED')
  assert.deepEqual(h.studyStats.get('alice'), original)
  assert.strictEqual(h.attempts.size, 0)
})

test('原子提交：流水写失败时档案和已写的流水全部回滚', async () => {
  const h = makeHarness()
  await h.main({ token: 'tokA', action: 'update', stats: updatePayload(1), attempts: updatePayload(1).attempts })
  const before = clone(h.studyStats.get('alice'))
  let writes = 0
  h.fail.pauseAttempt = () => { if (++writes === 2) throw new Error('injected second write timeout') }
  const result = await h.main({ token: 'tokA', action: 'update', stats: updatePayload(2),
    attempts: [{ id: 'a2', createdAt: 2 }, { id: 'a3', createdAt: 3 }] })
  assert.equal(result.ok, false)
  assert.deepEqual(h.studyStats.get('alice'), before)
  assert.equal(h.attempts.size, 1)
})

test('原子可见性：流水提交暂停时其他设备不能看见对应提交标记', async () => {
  const h = makeHarness()
  let release, started
  const gate = new Promise(resolve => { release = resolve })
  const ready = new Promise(resolve => { started = resolve })
  h.fail.pauseAttempt = async () => { started(); await gate }
  const stats = updatePayload(1)
  stats.practiceSession = { id: 's1', queueIds: ['q1'], submitted: { q1: { score: 1, createdAt: 1 } } }
  const writing = h.main({ token: 'tokA', action: 'update', stats,
    attempts: [{ id: 'a1', sessionId: 's1', questionId: 'q1', score: 1, createdAt: 1 }] })
  await ready
  const during = await h.main({ token: 'tokA', action: 'get' })
  assert.equal(during.ok, true)
  assert.equal(during.stats, null)
  assert.equal(during.attempts.length, 0)
  release()
  assert.equal((await writing).ok, true)
  const after = await h.main({ token: 'tokA', action: 'get' })
  assert.equal(after.stats.practiceSession.submitted.q1.score, 1)
  assert.equal(after.attempts.length, 1)
})

test('清空代次：其他设备的旧快照和旧流水均不能复活', async () => {
  const h = makeHarness()
  const old = { token: 'tokA', action: 'update', stats: updatePayload(1), attempts: updatePayload(1).attempts }
  await h.main(old)
  const reset = await h.main({ token: 'tokA', action: 'delete', dataEpoch: 0, deleteId: 'reset-a' })
  assert.equal(reset.dataEpoch, 1)
  const stale = await h.main(old)
  assert.equal(stale.error, 'STALE_EPOCH')
  const got = await h.main({ token: 'tokA', action: 'get' })
  assert.equal(got.stats, null)
  assert.equal(got.attempts.length, 0)
  assert.equal(got.dataEpoch, 1)
})

test('清空重试：ACK 丢失及被新清空取代都不会再次删除新代次作答', async () => {
  const h = makeHarness()
  const reset = { token: 'tokA', action: 'delete', dataEpoch: 0, deleteId: 'reset-a' }
  await h.main(reset)
  await h.main({ token: 'tokA', action: 'update', dataEpoch: 1, stats: updatePayload(2), attempts: updatePayload(2).attempts })
  assert.equal((await h.main(reset)).dataEpoch, 1)
  assert.ok((await h.main({ token: 'tokA' })).stats.records.q2)
  await h.main({ token: 'tokA', action: 'delete', dataEpoch: 1, deleteId: 'reset-b' })
  await h.main({ token: 'tokA', action: 'update', dataEpoch: 2, stats: updatePayload(3), attempts: updatePayload(3).attempts })
  assert.equal((await h.main(reset)).dataEpoch, 2)
  const got = await h.main({ token: 'tokA' })
  assert.ok(got.stats.records.q3)
  assert.equal(got.attempts.length, 1)
})

test('清空清理失败：旧代次立即不可恢复，重试只删除旧流水', async () => {
  const h = makeHarness()
  await h.main({ token: 'tokA', action: 'update', stats: updatePayload(1), attempts: updatePayload(1).attempts })
  h.fail.remove = new Error('injected delete timeout')
  const reset = { token: 'tokA', action: 'delete', dataEpoch: 0, deleteId: 'reset-a' }
  assert.equal((await h.main(reset)).error, 'DELETE_ATTEMPTS_FAILED')
  assert.equal((await h.main({ token: 'tokA' })).attempts.length, 0)
  await h.main({ token: 'tokA', action: 'update', dataEpoch: 1, stats: updatePayload(1), attempts: updatePayload(1).attempts })
  h.fail.remove = null
  assert.equal((await h.main(reset)).ok, true)
  assert.equal(h.attempts.size, 1, '同名流水的新代次必须保留')
  assert.equal([...h.attempts.values()][0].dataEpoch, 1)
})

test('分页恢复期间有并发写入时拒绝混合修订号', async () => {
  const h = makeHarness()
  await h.main({ token: 'tokA', action: 'update', stats: updatePayload(1), attempts: updatePayload(1).attempts })
  const first = await h.main({ token: 'tokA', action: 'get', limit: 1 })
  await h.main({ token: 'tokA', action: 'update', stats: updatePayload(2), attempts: updatePayload(2).attempts })
  const second = await h.main({ token: 'tokA', action: 'get', limit: 1, skip: 1,
    syncRevision: first.syncRevision, dataEpoch: first.dataEpoch })
  assert.equal(second.error, 'SNAPSHOT_CHANGED')
  assert.equal(second.stats, undefined)
  assert.equal(second.hasMore, undefined)
})

test('超事务上限的批次和缺少清空协议的调用在写入前拒绝', async () => {
  const h = makeHarness()
  const result = await h.main({ token: 'tokA', action: 'update', stats: updatePayload(1),
    attempts: Array.from({ length: 49 }, (_, i) => ({ id: String(i) })) })
  assert.equal(result.error, 'BATCH_TOO_LARGE')
  assert.equal((await h.main({ token: 'tokA', action: 'delete' })).error, 'RESET_PROTOCOL_REQUIRED')
  assert.equal(h.studyStats.size, 0)
})

test('已接受流水不可变：同 ID 重试不重复，改答案会回滚整份上传', async () => {
  const h = makeHarness()
  const event = { token: 'tokA', action: 'update', stats: updatePayload(1), attempts: [{ id: 'a1', score: 1 }] }
  assert.equal((await h.main(event)).ok, true)
  assert.equal((await h.main(event)).ok, true)
  assert.equal(h.attempts.size, 1)
  const before = clone(h.studyStats.get('alice'))
  const result = await h.main({ ...event, stats: updatePayload(2), attempts: [{ id: 'a2', score: 0 }, { id: 'a1', score: 0 }] })
  assert.equal(result.error, 'ATTEMPT_CONFLICT')
  assert.deepEqual(h.studyStats.get('alice'), before)
  assert.equal(h.attempts.has('alice__a2'), false)
  assert.equal(h.attempts.get('alice__a1').score, 1)
})

test('物理清理暂停时可提交新代次同名流水，清理完成后仍保留', async () => {
  const h = makeHarness()
  await h.main({ token: 'tokA', action: 'update', stats: updatePayload(1), attempts: updatePayload(1).attempts })
  let release, started
  const gate = new Promise(resolve => { release = resolve })
  const ready = new Promise(resolve => { started = resolve })
  h.fail.pauseRemove = async () => { started(); await gate }
  const resetting = h.main({ token: 'tokA', action: 'delete', dataEpoch: 0, deleteId: 'reset-a' })
  await ready
  assert.equal((await h.main({ token: 'tokA', action: 'update', dataEpoch: 1,
    stats: updatePayload(1), attempts: updatePayload(1).attempts })).ok, true)
  release()
  assert.equal((await resetting).ok, true)
  const got = await h.main({ token: 'tokA' })
  assert.equal(got.attempts.length, 1)
  assert.equal(got.attempts[0].id, 'a1')
  assert.equal([...h.attempts.values()][0].dataEpoch, 1)
})
