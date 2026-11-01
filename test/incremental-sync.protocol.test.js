/** 真实 store + 云函数 + 独立设备存储；不连接真实云。 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { makeHarness } = require('./support/study-sync-harness.js')
const { device } = require('./support/study-sync-device.js')
const snapshot = client => client.storage.get('exam_quiz_data_v1__alice')
const cursor = client => snapshot(client).syncCursor.sequence
const stop = (...clients) => clients.forEach(c => c.store.__clearFlushTimer())
const write = (server, ids) => server.main({ token: 'tokA', action: 'update', attempts: ids.map((id, i) => ({ id, questionId: id, createdAt: 1000 - i })) })

function appFor(client) {
  let app, network
  const user = {
    initCloud() { client.wx.__cloudReady = true }, bindStoredScope() {},
    ensureSession: async () => ({}), getRuntimeConfig: async () => null
  }
  client.wx.onNetworkStatusChange = callback => { network = callback }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8'), {
    App(value) { app = value }, wx: client.wx, console,
    require(name) {
      if (name === './utils/store.js') return client.store
      if (name === './utils/user.js') return user
      if (name === './utils/config.js') return { version: '2.0.0' }
      if (name === './utils/questions.js') return { loadCloudBank: async () => null }
      throw new Error(name)
    }
  })
  return { app, network: event => network(event), user }
}

test('已启动设备按游标只取新增事实，时钟回拨和重启不影响；拉取不回声上传', async () => {
  const server = makeHarness()
  const a = device(server), b = device(server)
  await Promise.all([a.settle(), b.settle()])
  a.controls.now = 2000
  a.answer('first')
  await a.settle()
  const before = b.controls.requests.length
  assert.equal((await b.store.syncNow()).ok, true)
  assert.equal(b.store.getAttempts().length, 1)
  assert.equal(cursor(b), 1)
  assert.deepEqual(b.controls.requests.slice(before).map(r => r.action), ['get'])
  assert.equal(b.controls.requests[before].cursor.sequence, 0)
  const reopened = device(server, b.storage)
  await reopened.settle()
  assert.equal(reopened.controls.requests[0].cursor.sequence, 1)
  a.controls.now = 1
  a.answer('clock-back')
  await a.settle()
  await reopened.store.syncNow()
  assert.equal(cursor(reopened), 2)
  assert.equal(reopened.store.getAttempts().length, 2)
  const again = reopened.controls.requests.length
  await reopened.store.syncNow()
  assert.deepEqual(reopened.controls.requests.slice(again).map(r => r.action), ['get'])
  assert.equal(reopened.controls.requests[again].cursor.sequence, 2)
  stop(a, b, reopened)
})

test('网络恢复先确认离线队列，再拉取另一设备事实，双方贡献不重复', async () => {
  const server = makeHarness()
  const a = device(server), b = device(server)
  await Promise.all([a.settle(), b.settle()])
  a.controls.offline = true
  a.answer('local')
  await a.settle()
  b.answer('remote')
  await b.settle()
  const before = a.controls.requests.length
  a.controls.offline = false
  assert.equal((await a.store.syncNow()).ok, true)
  assert.deepEqual(a.controls.requests.slice(before).map(r => r.action), ['update', 'get'])
  assert.equal(a.store.load().attemptOutbox.pending.length, 0)
  assert.equal(a.store.getAttempts().length, 2)
  assert.equal(a.store.getRecord('remote').attempts, 1)
  assert.equal(cursor(a), 2)
  stop(a, b)
})

test('分页期间新增作答会丢弃未完成批次，从持久游标重试后不漏项', async () => {
  const server = makeHarness(), b = device(server)
  await b.settle()
  await write(server, ['a', 'b', 'c', 'd', 'e'])
  b.controls.pageLimit = 2
  let inserted = false
  b.controls.afterGet = async result => {
    if (result.ok && result.hasMore && !inserted) {
      inserted = true
      assert.equal(cursor(b), 0)
      assert.equal(b.store.getAttempts().length, 0)
      await write(server, ['during-pagination'])
    }
  }
  const result = await b.store.syncNow()
  assert.equal(result.ok, true)
  assert.equal(result.attempts, 2)
  assert.equal(b.store.getAttempts().length, 6)
  assert.equal(cursor(b), 6)
  stop(b)
})

test('持续并发写入每轮最多三次，失败不发布半页；下次外部触发可继续', async () => {
  const server = makeHarness(), b = device(server)
  await b.settle()
  await write(server, ['a', 'b', 'c'])
  b.controls.pageLimit = 2
  let inserted = 0
  b.controls.afterGet = async result => { if (result.ok && result.hasMore) await write(server, ['racing-' + inserted++]) }
  const result = await b.store.syncNow()
  assert.equal(result.error, 'SYNC_RETRY_EXHAUSTED')
  assert.equal(result.attempts, 3)
  assert.equal(cursor(b), 0)
  assert.equal(b.store.getAttempts().length, 0)
  assert.equal(inserted, 3)
  b.controls.afterGet = null
  assert.equal((await b.store.syncNow()).ok, true)
  assert.equal(b.store.getAttempts().length, 6)
  stop(b)
})

test('分页传输失败不推进游标，重启后从上次持久检查点恢复', async () => {
  const server = makeHarness(), b = device(server)
  await b.settle()
  await write(server, ['a', 'b', 'c'])
  b.controls.pageLimit = 2
  b.controls.failGet = 2
  assert.equal(await b.store.pullFromCloud(undefined, { force: true }), false)
  assert.equal(cursor(b), 0)
  assert.equal(b.store.getAttempts().length, 0)
  const reopened = device(server, b.storage)
  await reopened.settle()
  assert.equal(reopened.controls.requests[0].cursor.sequence, 0)
  assert.equal(reopened.store.getAttempts().length, 3)
  assert.equal(cursor(reopened), 3)
  stop(b, reopened)
})

test('游标与恢复数据一起写盘；检查点失败保留内存与磁盘原状态', async () => {
  const server = makeHarness(), b = device(server)
  await b.settle()
  await write(server, ['new'])
  b.controls.failCursorWrite = true
  const result = await b.store.syncNow()
  assert.equal(result.ok, false)
  assert.equal(cursor(b), 0)
  assert.equal(b.store.load().syncCursor.sequence, 0)
  assert.equal(b.store.getAttempts().length, 0)
  b.controls.failCursorWrite = false
  assert.equal((await b.store.syncNow()).ok, true)
  assert.equal(cursor(b), 1)
  assert.equal(b.store.getAttempts().length, 1)
  stop(b)
})

test('非前进分页或非法终点不能被解释为恢复完成', async () => {
  const server = makeHarness(), b = device(server)
  await b.settle()
  await write(server, ['new'])
  for (const change of [result => ({ ...result, hasMore: true, nextSequence: 0 }), result => ({ ...result, nextSequence: 999 })]) {
    b.controls.changeGetResult = change
    assert.equal(await b.store.pullFromCloud(undefined, { force: true }), false)
    assert.equal(cursor(b), 0)
    assert.equal(b.store.getAttempts().length, 0)
  }
  b.controls.changeGetResult = null
  assert.equal((await b.store.syncNow()).ok, true)
  stop(b)
})

test('分页中另一设备整体清空后建立新基线，旧流水和游标不跨代次', async () => {
  const server = makeHarness(), a = device(server), b = device(server)
  await Promise.all([a.settle(), b.settle()])
  a.answer('old-1'); a.answer('old-2')
  await a.settle()
  b.controls.pageLimit = 1
  let reset = false
  b.controls.afterGet = async result => {
    if (result.ok && result.hasMore && !reset) {
      reset = true
      a.store.clearAll()
      await a.settle()
      a.answer('fresh')
      await a.settle()
    }
  }
  await b.store.syncNow() // 清空使旧协调器身份代次失效；新基线仍已原子恢复。
  assert.equal(b.store.load().dataEpoch, 1)
  assert.equal(b.store.getRecord('old-1'), null)
  assert.equal(b.store.getAttempts().length, 1)
  assert.equal(b.store.getAttempts()[0].questionId, 'fresh')
  assert.equal(snapshot(b).syncCursor.dataEpoch, 1)
  assert.equal(cursor(b), 1)
  stop(a, b)
})

test('账号切换期间迟到分页不能发布到新账号，原账号游标也不被推进', async () => {
  const server = makeHarness(), b = device(server)
  await b.settle()
  await write(server, ['alice-only'])
  await server.main({ token: 'tokB', action: 'update', attempts: [{ id: 'bob-only', createdAt: 1 }] })
  let release
  b.controls.getAckGate = new Promise(resolve => { release = resolve })
  const old = b.store.syncNow()
  await new Promise(setImmediate)
  b.wx.setStorageSync('exam_quiz_session_v1', { logged: true, token: 'tokB', openid: 'bob' })
  b.store.setUserScope('bob')
  b.store.load()
  b.controls.getAckGate = null
  release()
  assert.equal((await old).ok, false)
  await b.settle()
  assert.equal(b.store.getAttempts()[0].id, 'bob-only')
  assert.equal(cursor(b), 0)
  b.wx.setStorageSync('exam_quiz_session_v1', { logged: true, token: 'tokA', openid: 'alice' })
  b.store.setUserScope('alice')
  b.store.load()
  await b.settle()
  assert.equal(b.store.getAttempts()[0].id, 'alice-only')
  assert.equal(cursor(b), 1)
  stop(b)
})

test('旧服务端没有增量协议时安全全量恢复，不猜测保存新游标', async () => {
  const server = makeHarness()
  const legacy = { main: event => server.main({ ...event, syncProtocol: undefined }) }
  const b = device(legacy)
  await b.settle()
  await write(server, ['a'])
  assert.equal((await b.store.syncNow()).ok, true)
  assert.equal(snapshot(b).syncCursor, undefined)
  assert.equal(b.store.getAttempts().length, 1)
  await write(server, ['b'])
  await b.store.syncNow()
  assert.equal(b.store.getAttempts().length, 2)
  stop(b)
})

test('前台/网络恢复触发自动同步并合并并发触发，离线通知和退出登录不发请求', async () => {
  const server = makeHarness(), b = device(server)
  await b.settle()
  const runtime = appFor(b)
  runtime.app.onLaunch()
  await new Promise(setImmediate)
  await b.store.syncNow()
  await write(server, ['foreground'])
  const first = runtime.app.onShow()
  const same = runtime.network({ isConnected: true })
  assert.equal(first, same, '同一轮前台和网络事件共享任务')
  assert.equal((await first).ok, true)
  assert.equal(b.store.getAttempts().length, 1)
  const calls = b.controls.requests.length
  runtime.network({ isConnected: false })
  runtime.app.setLogged(false)
  runtime.app.onShow()
  runtime.network({ isConnected: true })
  await b.settle()
  assert.equal(b.controls.requests.length, calls)
  await write(server, ['after-login'])
  runtime.app.setLogged(true)
  await b.store.syncNow()
  assert.equal(b.store.getAttempts().length, 2)
  stop(b)
})

test('旧处理器的无序号写入触发同代次重建基线，不遗漏事实也不清空本地队列', async () => {
  const server = makeHarness(), b = device(server)
  await b.settle()
  await write(server, ['numbered'])
  await b.store.syncNow()
  server.attempts.set('alice__legacy', { _id: 'alice__legacy', openid: 'alice', id: 'legacy', createdAt: 1 })
  server.studyStats.get('alice').syncRevision += 1
  b.controls.offline = true
  b.answer('offline')
  await b.settle()
  b.controls.offline = false
  assert.equal((await b.store.syncNow()).ok, true)
  assert.equal(b.store.getAttempts().length, 3)
  assert.equal(b.store.getRecord('offline').attempts, 1)
  assert.equal(snapshot(b).syncCursor.generation, 1)
  assert.equal(b.store.load().attemptOutbox.pending.length, 0)
  stop(b)
})

test('拉取期间新增编辑的上传失败时不能提前报告整轮成功', async () => {
  const server = makeHarness(), b = device(server)
  await b.settle()
  let release
  b.controls.getAckGate = new Promise(resolve => { release = resolve })
  const syncing = b.store.syncNow()
  await new Promise(setImmediate)
  b.controls.changeUpdateResult = () => ({ ok: false, error: 'injected ACK rejection' })
  b.store.saveSettings({ dailyGoal: 80 })
  b.store.flush()
  b.controls.getAckGate = null
  release()
  assert.equal((await syncing).ok, false)
  assert.equal(b.store.getSettings().dailyGoal, 80)
  b.controls.changeUpdateResult = null
  assert.equal((await b.store.syncNow()).ok, true)
  assert.equal((await server.main({ token: 'tokA' })).stats.settings.dailyGoal, 80)
  stop(b)
})

test('前台恢复能看见启动后另一设备提交的作答', async () => {
  const server = makeHarness(), b = device(server)
  await b.settle()
  const runtime = appFor(b)
  runtime.app.onLaunch()
  await b.settle()
  await write(server, ['after-start'])
  if (runtime.app.onShow) await runtime.app.onShow()
  await b.settle()
  assert.equal(b.store.getAttempts().length, 1)
  assert.equal(b.store.getAttempts()[0].id, 'after-start')
  stop(b)
})
