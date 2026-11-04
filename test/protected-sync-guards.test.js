const { test } = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path')
const { makeHarness } = require('./support/study-sync-harness.js')
function setup() {
  const file = path.join(__dirname, '../cloudfunctions/studySync/index.js')
  const source = fs.readFileSync(file, 'utf8').replace('const PROTECTED_STUDY_ONLY = false', 'const PROTECTED_STUDY_ONLY = true')
  return makeHarness({ source })
}
test('受保护服务端拒绝旧快照读写，只返回已认证账号的数据代次', async () => {
  const h = setup(); h.studyStats.set('alice', { _id: 'alice', dataEpoch: 3, aiMessages: [{ text: 'secret' }], practiceSession: { questionSnapshots: [{ stem: 'secret' }] } })
  for (const action of ['get', 'update', 'commitAttempts', 'commitVersionedAttempts', 'commitPagedAttempts', 'clearAI']) {
    const result = await h.main({ token: 'tokA', action }); assert.equal(result.error, 'PROTECTED_SYNC_REQUIRED', action)
    assert.doesNotMatch(JSON.stringify(result), /secret/)
  }
  assert.deepEqual(JSON.parse(JSON.stringify(await h.main({ token: 'tokA', action: 'getProtectedEpoch' }))), { ok: true, dataEpoch: 3 })
  h.fail.openid = 'bob'; assert.equal((await h.main({ token: 'tokA', action: 'getProtectedEpoch' })).error, 'INVALID_TOKEN')
  h.fail.openid = 'alice'; h.studyStats.set('alice', { _id: 'alice', dataEpoch: '3' })
  assert.equal((await h.main({ token: 'tokA', action: 'getProtectedEpoch' })).error, 'INVALID_EPOCH')
  h.fail.get = name => name === 'studyStats'
  assert.equal((await h.main({ token: 'tokA', action: 'getProtectedEpoch' })).error, 'READ_STATS_FAILED')
})
test('默认环境不启用受保护代次接口', async () => {
  const h = makeHarness(); assert.equal((await h.main({ token: 'tokA', action: 'getProtectedEpoch' })).error, 'PROTECTED_READ_DISABLED')
})

test('受保护客户端只同步代次，远端清空使旧上下文失效且读取或落盘故障不推进', async t => {
  const config = require('../utils/config.js'), { device } = require('./support/study-sync-device.js')
  const original = config.protectedCatalog; config.protectedCatalog = true; t.after(() => { config.protectedCatalog = original })
  const h = setup(); h.studyStats.set('alice', { _id: 'alice', dataEpoch: 2 })
  const d = device(h, undefined, false); d.wx.__cloudReady = true
  const old = d.store.captureProtectedSyncContext()
  h.fail.get = name => name === 'studyStats'; assert.equal(await d.store.syncNow(), false)
  assert.equal(d.store.isProtectedSyncContextCurrent(old), true)
  h.fail.get = null; d.controls.failStorage = true; assert.equal(await d.store.syncNow(), false)
  assert.equal(d.store.isProtectedSyncContextCurrent(old), true)
  d.controls.failStorage = false; assert.equal(await d.store.syncNow(), true)
  assert.equal(d.store.isProtectedSyncContextCurrent(old), false)
  assert.equal(d.store.captureProtectedSyncContext().dataEpoch, 2)
  assert.equal(d.controls.requests.some(item => ['get', 'update', 'commitAttempts', 'commitPagedAttempts'].includes(item.action)), false)
  h.studyStats.set('alice', { _id: 'alice', dataEpoch: 1 }); assert.equal(await d.store.syncNow(), false)
  assert.equal(d.store.captureProtectedSyncContext().dataEpoch, 2)
  d.store.__clearFlushTimer()
})

test('代次回执迟到时 A→B→A 不复用旧账号上下文', async t => {
  const config = require('../utils/config.js'), { device } = require('./support/study-sync-device.js')
  const old = config.protectedCatalog; config.protectedCatalog = true; t.after(() => { config.protectedCatalog = old })
  const h = setup(); h.studyStats.set('alice', { _id: 'alice', dataEpoch: 3 })
  const d = device(h, undefined, false); d.wx.__cloudReady = true
  let unblock; d.controls.protectedEpochAckGate = new Promise(r => { unblock = r })
  const pending = d.store.syncNow(); await new Promise(setImmediate)
  d.wx.setStorageSync('exam_quiz_session_v1', { logged: true, openid: 'bob', token: 'tokB' }); d.store.setUserScope('bob')
  d.wx.setStorageSync('exam_quiz_session_v1', { logged: true, openid: 'alice', token: 'tokA' }); d.store.setUserScope('alice')
  unblock(); assert.equal(await pending, false); await d.settle()
  d.controls.protectedEpochAckGate = null; assert.equal(await d.store.syncNow(), true)
  assert.equal(d.store.captureProtectedSyncContext().dataEpoch, 3); d.store.__clearFlushTimer()
})


test('受保护清空事务开始前令牌被撤销时不能删除数据', async () => {
  const h = setup(); h.studyStats.set('alice', { _id: 'alice', dataEpoch: 0, records: { keep: { attempts: 1 } } })
  h.fail.beforeTransaction = () => { h.users.get('u1').token = 'revoked' }
  const result = await h.main({ action: 'delete', token: 'tokA', dataEpoch: 0, deleteId: 'race' })
  assert.equal(result.error, 'INVALID_TOKEN')
  assert.equal(h.studyStats.get('alice').dataEpoch, 0); assert.ok(h.studyStats.get('alice').records.keep)
})

test('受保护清空时身份读取故障或令牌时间非法均不得改写数据', async () => {
  const h = setup(); h.studyStats.set('alice', { _id: 'alice', dataEpoch: 0, records: { keep: { attempts: 1 } } })
  const event = { action: 'delete', token: 'tokA', dataEpoch: 0, deleteId: 'readfail' }
  h.fail.get = name => name === 'users'
  assert.equal((await h.main(event)).error, 'DELETE_STATS_FAILED'); assert.equal(h.studyStats.get('alice').dataEpoch, 0)
  h.fail.get = null; h.users.get('u1').tokenAt += 1000
  assert.equal((await h.main(event)).error, 'INVALID_TOKEN'); assert.equal(h.studyStats.get('alice').dataEpoch, 0)
})
