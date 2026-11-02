const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createLocalRepository } = require('../utils/local-repository.js')
const { getDefaultState } = require('../shared/stats-merge.js')
const copy = value => JSON.parse(JSON.stringify(value))
function harness() {
  const data = new Map(), writes = [], controls = { fail: null, quotaKB: 10240 }
  const storage = {
    getStorageSync: key => data.has(key) ? copy(data.get(key)) : '',
    setStorageSync(key, value) {
      writes.push({ key, bytes: Buffer.byteLength(JSON.stringify(value)) })
      if (controls.fail && controls.fail(key)) throw new Error('injected write failure')
      const size = Buffer.byteLength(key + JSON.stringify(value))
      if (size > 1048576) throw new Error('native single key limit')
      const current = [...data].filter(([k]) => k !== key).reduce((n, [k, v]) => n + Buffer.byteLength(k + JSON.stringify(v)), 0)
      if (current + size > controls.quotaKB * 1024) throw new Error('native total quota')
      data.set(key, copy(value))
    },
    removeStorageSync: key => data.delete(key),
    getStorageInfoSync: () => ({ keys: [...data.keys()], currentSize: [...data].reduce((n, [k, v]) => n + Buffer.byteLength(k + JSON.stringify(v)), 0) / 1024, limitSize: controls.quotaKB })
  }
  const repo = createLocalRepository(storage)
  return { data, writes, controls, storage, repo, cold: () => createLocalRepository(storage) }
}
function snapshot(count = 70, length = 400) {
  return { ...getDefaultState(), attempts: [{ id: 'confirmed' }], attemptOutbox: { version: 1, pending: [] },
    aiMessages: Array.from({ length: count }, (_, i) => ({ time: i, role: 'user', text: '合成对话'.repeat(length) })) }
}
const aiKeys = h => [...h.data.keys()].filter(k => k.startsWith('exam_quiz_ai_history_v1__'))

test('AI 历史按原顺序完整分段；新答案只写活动根，不重写 AI 页', () => {
  const h = harness(), original = snapshot()
  h.data.set(h.repo.rootKey('alice'), copy(original))
  h.repo.write('alice', original)
  const root = h.data.get(h.repo.rootKey('alice'))
  assert.equal(root.version, 5); assert.deepEqual(root.aiMessages, [])
  assert.ok(aiKeys(h).length > 1)
  assert.deepEqual(h.cold().read('alice').aiMessages, original.aiMessages)
  const next = h.repo.read('alice'), operation = { id: 'pending', selected: ['A'] }
  next.attempts.push(operation); next.attemptOutbox.pending.push(copy(operation))
  h.writes.length = 0; h.repo.write('alice', next)
  assert.deepEqual(h.writes.map(w => w.key), [h.repo.rootKey('alice')])
  assert.ok(h.writes[0].bytes < 10000)
  assert.deepEqual(h.cold().read('alice').attemptOutbox.pending, [operation])
})
test('追加仅重组 AI 尾页，重复消息和相同时间不被仓储去重；清空代次不复活旧页', () => {
  const h = harness(); h.repo.write('alice', snapshot(65, 10))
  const next = h.repo.read('alice'), repeated = { time: 65, role: 'user', text: '重复' }
  next.aiMessages.push(repeated, copy(repeated)); h.writes.length = 0
  h.repo.write('alice', next)
  assert.equal(h.writes.filter(w => w.key.startsWith('exam_quiz_ai_history_v1__')).length, 1)
  assert.equal(h.cold().read('alice').aiMessages.length, 67)
  const cleared = h.repo.read('alice'); cleared.aiMessages = []; cleared.aiEpoch = 1
  h.repo.write('alice', cleared)
  assert.equal(aiKeys(h).length, 0); assert.deepEqual(h.cold().read('alice').aiMessages, [])
})
test('AI 缺页、坏页和跨账号页拒绝恢复；已有分页错误不能降级成内联空历史', () => {
  for (const damage of [(h, k) => h.data.delete(k), (h, k) => { h.data.get(k).rows[0].text = 'tampered' }]) {
    const h = harness(); h.repo.write('alice', snapshot(5)); const next = h.repo.read('alice')
    damage(h, aiKeys(h)[0]); h.repo.release('alice')
    const before = copy(h.data.get(h.repo.rootKey('alice')))
    assert.throws(() => h.repo.read('alice'))
    assert.throws(() => h.repo.write('alice', next))
    assert.deepEqual(h.data.get(h.repo.rootKey('alice')), before)
  }
  const h = harness(); h.repo.write('alice', snapshot(2)); h.repo.write('bob', snapshot(3))
  const a = aiKeys(h).find(k => k.includes(h.data.get(h.repo.rootKey('alice')).localRepository.scope))
  const b = aiKeys(h).find(k => k.includes(h.data.get(h.repo.rootKey('bob')).localRepository.scope))
  h.data.set(a, copy(h.data.get(b)))
  assert.throws(() => h.cold().read('alice'), /LOCAL_AI_HISTORY_UNAVAILABLE/)
})

test('大迁移备份也分块并可完整只读导出，备份损坏不改变当前档案', () => {
  const h = harness(), original = snapshot(100, 1000)
  h.data.set(h.repo.rootKey('alice'), copy(original)) // Synthetic legacy import; never a native oversized write.
  h.repo.write('alice', original)
  assert.ok(h.writes.every(w => w.bytes < 900 * 1024))
  assert.ok([...h.data.keys()].some(k => k.startsWith('exam_quiz_backup_page_v1__')))
  assert.deepEqual(h.repo.readMigrationBackup('alice'), original)
  assert.deepEqual(h.cold().read('alice').aiMessages, original.aiMessages)
  const key = [...h.data.keys()].find(k => k.startsWith('exam_quiz_backup_page_v1__'))
  h.data.get(key).text += 'corrupt'
  assert.throws(() => h.repo.readMigrationBackup('alice'), /LOCAL_BACKUP_UNAVAILABLE/)
  assert.equal(h.cold().read('alice').aiMessages.length, 100)
  assert.throws(() => h.repo.rollback('alice'), /LOCAL_ENTRY_TOO_LARGE/)
  assert.equal(h.cold().read('alice').aiMessages.length, 100)
})
test('v4 升级 AI 准备失败可保持完整 v4 与待传项，延期不在每次保存重复迁移', () => {
  const h = harness(); h.repo.write('alice', snapshot(0))
  const next = h.repo.read('alice'), operation = { id: 'pending' }
  next.aiMessages = [{ time: 1, text: '保留对话' }]; next.attempts.push(operation); next.attemptOutbox.pending.push(operation)
  h.controls.fail = key => key.startsWith('exam_quiz_ai_history_v1__')
  h.repo.write('alice', next)
  assert.equal(h.data.get(h.repo.rootKey('alice')).version, 4)
  assert.equal(h.repo.status('alice').migrationDeferred, true)
  assert.deepEqual(h.cold().read('alice').aiMessages, next.aiMessages)
  assert.deepEqual(h.cold().read('alice').attemptOutbox.pending, [operation])
  h.writes.length = 0; h.repo.write('alice', next)
  assert.equal(h.writes.length, 1); assert.equal(h.repo.status('alice').migrationDeferred, true)
  h.controls.fail = null; h.repo.retryMigration('alice'); h.repo.write('alice', next)
  assert.equal(h.data.get(h.repo.rootKey('alice')).version, 5)
  assert.equal(h.repo.readMigrationBackup('alice').version, 3)
})
test('已有 AI 分段写新页失败必须失败，不使用旧备份或降级内联', () => {
  const h = harness(); h.repo.write('alice', snapshot(1))
  const next = h.repo.read('alice'), before = copy(h.data.get(h.repo.rootKey('alice')))
  next.aiMessages.push({ time: 99, text: '新回复' })
  h.controls.fail = key => key.startsWith('exam_quiz_ai_history_v1__')
  assert.throws(() => h.repo.write('alice', next), /injected write failure/)
  assert.deepEqual(h.data.get(h.repo.rootKey('alice')), before)
  assert.equal(h.cold().read('alice').aiMessages.length, 1)
})
test('活动根超过单项预算时拒绝提交，不删已有待传项且不进入原生超限写入', () => {
  const h = harness(), original = snapshot(2)
  h.repo.write('alice', original)
  const next = h.repo.read('alice'), before = copy(h.data.get(h.repo.rootKey('alice')))
  const operation = { id: 'huge-pending', evidence: 'x'.repeat(1100000) }
  next.attempts.push(operation); next.attemptOutbox.pending.push(copy(operation)); h.writes.length = 0
  assert.throws(() => h.repo.write('alice', next), /LOCAL_ENTRY_TOO_LARGE/)
  assert.equal(h.writes.length, 0)
  assert.deepEqual(h.data.get(h.repo.rootKey('alice')), before)
})
