const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createLocalRepository } = require('../utils/local-repository.js')
const { getDefaultState } = require('../shared/stats-merge.js')
const clone = value => JSON.parse(JSON.stringify(value))
function harness() {
  const data = new Map(), writes = [], controls = { limitKB: 40, infoFailed: false, writeFailed: false }
  const snapshot = { ...getDefaultState(), attempts: [{ id: 'confirmed', content: '合成历史'.repeat(1000) }], attemptOutbox: { version: 1, pending: [] } }
  const storage = {
    getStorageSync: key => data.has(key) ? clone(data.get(key)) : '',
    setStorageSync(key, value) {
      writes.push(key)
      if (controls.writeFailed) throw new Error('quota exhausted')
      const total = [...data].filter(([k]) => k !== key).reduce((n, [k, v]) => n + Buffer.byteLength(k + JSON.stringify(v)), 0) + Buffer.byteLength(key + JSON.stringify(value))
      if (total > controls.limitKB * 1024) throw new Error('quota exhausted')
      data.set(key, clone(value))
    },
    removeStorageSync: key => data.delete(key),
    getStorageInfoSync() {
      if (controls.infoFailed) throw new Error('inventory offline')
      return { keys: [...data.keys()], currentSize: [...data].reduce((n, [k, v]) => n + Buffer.byteLength(k + JSON.stringify(v)), 0) / 1024, limitSize: controls.limitKB }
    }
  }
  const repo = createLocalRepository(storage)
  data.set(repo.rootKey('alice'), clone(snapshot))
  return { data, writes, controls, snapshot, storage, repo }
}
test('容量预检不足时不准备备份/页，只保存完整旧格式和新待传作答', () => {
  const h = harness(), next = clone(h.snapshot)
  next.attempts.push({ id: 'pending', selected: ['A'] }); next.attemptOutbox.pending.push({ id: 'pending', selected: ['A'] })
  h.repo.write('alice', next)
  assert.deepEqual(h.writes, [h.repo.rootKey('alice')])
  assert.equal(h.repo.status('alice').migrationError, 'LOCAL_CAPACITY_INSUFFICIENT')
  assert.ok(h.repo.status('alice').capacity.requiredBytes > h.repo.status('alice').capacity.availableBytes)
  assert.deepEqual(createLocalRepository(h.storage).read('alice'), next)
  h.controls.limitKB = 1024; h.repo.retryMigration('alice'); h.repo.write('alice', next)
  assert.equal(h.repo.status('alice').migrationDeferred, false)
  assert.equal(h.data.get(h.repo.rootKey('alice')).version, 4)
  assert.deepEqual(createLocalRepository(h.storage).read('alice').attemptOutbox, next.attemptOutbox)
})
test('容量信息失败或不完整时延期迁移，不能当成无限容量，也不移除已有备份', () => {
  for (const info of [() => { throw new Error('inventory offline') }, () => ({ keys: [] }), () => ({ keys: [], currentSize: 0, limitSize: NaN })]) {
    const h = harness(); h.storage.getStorageInfoSync = info
    const backup = h.repo.backupKey('alice'); h.data.set(backup, clone(h.snapshot))
    h.repo.write('alice', h.snapshot)
    assert.deepEqual(h.writes, [h.repo.rootKey('alice')])
    assert.equal(h.repo.status('alice').migrationError, 'LOCAL_CAPACITY_UNKNOWN')
    assert.equal(h.data.has(backup), true)
  }
})
test('延期退路也写失败时明确失败，成功读取不能抹掉尚未解决的保存错误', () => {
  const h = harness(); h.controls.writeFailed = true
  assert.throws(() => h.repo.write('alice', h.snapshot), /quota exhausted/)
  assert.deepEqual(h.repo.read('alice'), h.snapshot)
  assert.equal(h.repo.status('alice').state, 'write_error')
  assert.equal(h.repo.status('alice').error, 'LOCAL_WRITE_FAILED')
})

test('准入后配额被占用仍走故障退路，不丢新答案；备份不是释放空间的任意删除对象', () => {
  const h = harness(); h.controls.limitKB = 1024
  const set = h.storage.setStorageSync
  h.storage.setStorageSync = (key, value) => {
    if (key.startsWith('exam_quiz_backup')) h.controls.limitKB = 15
    return set(key, value)
  }
  const next = clone(h.snapshot)
  next.attempts.push({ id: 'pending' }); next.attemptOutbox.pending.push({ id: 'pending' })
  h.repo.write('alice', next)
  assert.equal(h.repo.status('alice').migrationDeferred, true)
  assert.deepEqual(createLocalRepository(h.storage).read('alice'), next)
})
