const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createLocalRepository } = require('../utils/local-repository.js')
const { getDefaultState } = require('../shared/stats-merge.js')
const clone = v => JSON.parse(JSON.stringify(v))
function fixture(count) {
  return { ...getDefaultState(), attempts: Array.from({ length: count }, (_, i) => ({ id: 'a' + i, questionId: 'q', selected: ['A'], answer: ['A'], score: 1, createdAt: i, content: 'synthetic'.repeat(80) })), attemptOutbox: { version: 1, pending: [] } }
}
function harness() {
  const data = new Map(), trace = [], faults = { get: null, set: null, remove: null }
  const storage = {
    getStorageSync(key) { if (faults.get && faults.get(key)) throw new Error('read unavailable'); return data.has(key) ? clone(data.get(key)) : '' },
    setStorageSync(key, value) { trace.push({ key, bytes: JSON.stringify(value).length }); if (faults.set && faults.set(key)) throw new Error('storage full'); data.set(key, clone(value)) },
    removeStorageSync(key) { if (faults.remove && faults.remove(key)) throw new Error('cleanup unavailable'); data.delete(key) },
    getStorageInfoSync: () => ({ keys: [...data.keys()], currentSize: 0, limitSize: 1048576 })
  }
  return { data, trace, faults, storage, repo: createLocalRepository(storage), cold: () => createLocalRepository(storage) }
}
const history = h => [...h.data.keys()].filter(k => k.startsWith('exam_quiz_history_v1__'))
const ids = s => s.attempts.map(a => a.id).sort()

test('首次分段前保留旧快照，重启恢复全部事实、聚合和待传项且领域版本不变', () => {
  const h = harness(), original = fixture(70)
  h.data.set(h.repo.rootKey('alice'), clone(original))
  h.repo.write('alice', original)
  assert.equal(h.data.get(h.repo.rootKey('alice')).version, 4)
  assert.equal(history(h).length, 3)
  assert.deepEqual(h.data.get(h.repo.backupKey('alice')), original)
  const restored = h.cold().read('alice')
  assert.equal(restored.version, 3); assert.deepEqual(ids(restored), ids(original))
  assert.equal(restored.localRepository, undefined); assert.deepEqual(restored.attemptOutbox.pending, [])
})

test('新作答只写活动检查点，确认只重写有界尾段，分段数不按每次 ACK 增长', () => {
  const h = harness(); h.repo.write('alice', fixture(64))
  const next = h.repo.read('alice'), pending = { id: 'pending', selected: ['B'], questionId: 'q' }
  next.attempts.push(pending); next.attemptOutbox.pending.push(clone(pending)); h.trace.length = 0
  h.repo.write('alice', next)
  assert.equal(h.trace.length, 1); assert.equal(h.trace[0].key, h.repo.rootKey('alice'))
  assert.ok(h.trace[0].bytes < JSON.stringify(next).length / 10)
  next.attemptOutbox.pending = []; h.repo.write('alice', next)
  for (let i = 0; i < 20; i++) { next.attempts.push({ id: 'new' + i }); h.repo.write('alice', next) }
  assert.equal(history(h).length, 3)
  assert.equal(h.cold().read('alice').attempts.length, 85)
})

test('写分段或最终检查点失败不能发布半份档案，重试不重复事实', () => {
  const h = harness(), original = fixture(65)
  h.data.set(h.repo.rootKey('alice'), clone(original))
  let calls = 0
  h.faults.set = key => key.startsWith('exam_quiz_history') && ++calls === 2
  h.repo.write('alice', original)
  assert.equal(h.repo.status('alice').migrationDeferred, true)
  assert.deepEqual(h.cold().read('alice'), original); assert.equal(history(h).length, 0)
  h.faults.set = null; h.repo.retryMigration('alice'); h.repo.write('alice', original)
  const updated = h.repo.read('alice'); updated.attempts.push({ id: 'new' })
  const before = clone(h.data.get(h.repo.rootKey('alice')))
  h.faults.set = key => key === h.repo.rootKey('alice')
  assert.throws(() => h.repo.write('alice', updated), /storage full/)
  assert.deepEqual(h.data.get(h.repo.rootKey('alice')), before)
  assert.equal(h.cold().read('alice').attempts.length, 65)
  h.faults.set = null; h.repo.write('alice', updated)
  assert.equal(h.cold().read('alice').attempts.length, 66)
})

test('冷启动分段缺失/损坏或根读取失败必须失败，不能以空档案覆盖', () => {
  for (const corrupt of [(h, key) => h.data.delete(key), (h, key) => { h.data.get(key).rows[0].selected = ['tamper'] }]) {
    const h = harness(); h.repo.write('alice', fixture(5)); corrupt(h, history(h)[0])
    const repo = h.cold(), before = clone(h.data.get(repo.rootKey('alice')))
    assert.throws(() => repo.read('alice'), /LOCAL_HISTORY_UNAVAILABLE/)
    assert.equal(repo.status('alice').state, 'read_error')
    assert.throws(() => repo.write('alice', fixture(0)), /LOCAL_HISTORY_UNAVAILABLE/)
    assert.deepEqual(h.data.get(repo.rootKey('alice')), before)
  }
  const h = harness(); h.faults.get = () => true
  assert.throws(() => h.repo.read('alice'), /read unavailable/); assert.equal(h.repo.status('alice').error, 'LOCAL_READ_FAILED')
})

test('账号、代次和本地清空意图隔离，复制其他账号的根或改代次均拒绝', () => {
  const h = harness(); h.repo.write('alice', fixture(3)); h.repo.write('bob', fixture(4))
  const alice = clone(h.data.get(h.repo.rootKey('alice')))
  h.data.set(h.repo.rootKey('alice'), clone(h.data.get(h.repo.rootKey('bob'))))
  assert.throws(() => h.cold().read('alice'), /INVALID_LOCAL_CHECKPOINT/)
  h.data.set(h.repo.rootKey('alice'), alice); alice.dataEpoch = 1
  assert.throws(() => h.cold().read('alice'), /LOCAL_EPOCH_MISMATCH/)
  h.data.set(h.repo.rootKey('alice'), clone({ ...alice, dataEpoch: 0 }))
  const changed = h.repo.read('alice'); changed.dataEpoch = 1
  h.repo.write('alice', changed)
  assert.equal(h.cold().read('bob').attempts.length, 4)
  assert.equal(h.cold().read('alice').dataEpoch, 1)
})

test('清空先提交空墓碑，物理清理失败不复活备份，且不删除其他账号', () => {
  const h = harness(); h.data.set(h.repo.rootKey('alice'), fixture(4)); h.repo.write('alice', fixture(4)); h.repo.write('bob', fixture(2))
  h.faults.remove = () => true; h.repo.clear('alice')
  assert.equal(h.cold().read('alice'), null); assert.equal(h.repo.status('alice').cleanupPending, true)
  assert.equal(h.cold().read('bob').attempts.length, 2)
  h.faults.remove = null; h.repo.clear('alice')
  assert.equal(h.data.has(h.repo.backupKey('alice')), false)
  assert.equal(history(h).length, 1)
})

test('回滚导出最新完整状态，失败不先删除仍被引用的历史', () => {
  const h = harness(), original = fixture(2); h.data.set(h.repo.rootKey('alice'), clone(original)); h.repo.write('alice', original)
  const updated = h.repo.read('alice'); updated.attempts.push({ id: 'latest' }); h.repo.write('alice', updated)
  h.faults.set = key => key === h.repo.rootKey('alice')
  assert.throws(() => h.repo.rollback('alice'), /storage full/)
  assert.equal(h.repo.status('alice').state, 'write_error')
  assert.equal(h.cold().read('alice').attempts.length, 3)
  h.faults.set = null; assert.equal(h.repo.rollback('alice').ok, true)
  assert.equal(h.data.get(h.repo.rootKey('alice')).version, 3)
  assert.deepEqual(ids(h.data.get(h.repo.rootKey('alice'))), ['a0', 'a1', 'latest'])
  assert.equal(history(h).length, 0)
})

test('服务端规范 ID 事实可以和原待传操作共存，恢复证据不能替代显式出队确认', () => {
  const h = harness(), operation = { id: 'provisional', sessionId: 's', questionId: 'q', clientOpId: 'one', selected: ['A'] }
  const snapshot = fixture(0); snapshot.attempts = [{ ...operation, id: 'canonical' }]; snapshot.attemptOutbox.pending = [operation]
  h.repo.write('alice', snapshot)
  const restored = h.cold().read('alice')
  assert.equal(restored.attempts[0].id, 'canonical'); assert.equal(restored.attemptOutbox.pending[0].id, 'provisional')
})

test('热缓存不能掩盖分段被移除，后续检查点不得提交缺失引用', () => {
  const h = harness(); h.repo.write('alice', fixture(35))
  const next = h.repo.read('alice'), root = clone(h.data.get(h.repo.rootKey('alice')))
  h.data.delete(history(h)[0])
  assert.throws(() => h.repo.read('alice'), /LOCAL_HISTORY_UNAVAILABLE/)
  assert.throws(() => h.repo.write('alice', next), /LOCAL_HISTORY_UNAVAILABLE/)
  assert.deepEqual(h.data.get(h.repo.rootKey('alice')), root)
})

test('检查点实际写入后 API 仍报错时，保留准备好的分段供重启恢复，不能按失败删除引用', () => {
  const h = harness(); h.repo.write('alice', fixture(32))
  const next = h.repo.read('alice'); next.attempts.push({ id: 'possibly-committed' })
  const storage = { ...h.storage, setStorageSync(key, value) {
    h.storage.setStorageSync(key, value)
    if (key === h.repo.rootKey('alice')) throw new Error('ambiguous checkpoint result')
  } }
  const writer = createLocalRepository(storage)
  assert.throws(() => writer.write('alice', next), /ambiguous checkpoint result/)
  assert.equal(h.cold().read('alice').attempts.length, 33)
  assert.equal(writer.status('alice').cleanupPending, true)
})

test('释放账号缓存后重新校验历史内容，不跨账号长期保留热历史', () => {
  const h = harness(); h.repo.write('alice', fixture(2)); h.repo.read('alice')
  h.repo.release('alice'); h.data.get(history(h)[0]).rows[0].score = 9
  assert.throws(() => h.repo.read('alice'), /LOCAL_HISTORY_UNAVAILABLE/)
})

test('首次迁移准备失败可完整保存原格式并延后重试，不因优化阻断作答或丢掉新队列', () => {
  const h = harness(), snapshot = fixture(3)
  snapshot.attempts.push({ id: 'pending', selected: ['B'] }); snapshot.attemptOutbox.pending.push({ id: 'pending', selected: ['B'] })
  h.data.set(h.repo.rootKey('alice'), fixture(3))
  h.faults.set = key => key.startsWith('exam_quiz_backup')
  h.repo.write('alice', snapshot)
  assert.equal(h.data.get(h.repo.rootKey('alice')).version, 3)
  assert.equal(h.repo.status('alice').migrationDeferred, true)
  assert.equal(h.cold().read('alice').attemptOutbox.pending[0].id, 'pending')
  h.trace.length = 0; h.repo.write('alice', snapshot)
  assert.equal(h.trace.length, 1, '本进程已延期后继续使用完整原格式，不每次作答重复尝试迁移')
})

test('热缓存直接写入也先校验完整旧根；读写错误分别保留，读取修复不冒充写入成功', () => {
  const h = harness(); h.repo.write('alice', fixture(35))
  const next = h.repo.read('alice'), key = history(h)[0], page = clone(h.data.get(key))
  h.data.delete(key)
  assert.throws(() => h.repo.write('alice', next), /LOCAL_HISTORY_UNAVAILABLE/)
  assert.equal(h.repo.status('alice').state, 'read_error')
  assert.equal(h.repo.status('alice').readError, 'LOCAL_HISTORY_UNAVAILABLE')
  assert.equal(h.repo.status('alice').writeError, 'LOCAL_HISTORY_UNAVAILABLE')
  const damaged = clone(page); damaged.rows[0].score = 999; h.data.set(key, damaged)
  assert.throws(() => h.repo.read('alice'), /LOCAL_HISTORY_UNAVAILABLE/, '读失败释放旧缓存，错误内容不能仅凭同名 key 解除保护')
  h.data.set(key, page); h.repo.read('alice')
  assert.equal(h.repo.status('alice').readError, null)
  assert.equal(h.repo.status('alice').state, 'write_error')
  h.repo.write('alice', next)
  assert.equal(h.repo.status('alice').readError, null)
  assert.equal(h.repo.status('alice').writeError, null)
  assert.equal(h.repo.status('alice').state, 'ready')
})
