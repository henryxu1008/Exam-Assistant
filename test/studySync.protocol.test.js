/** 真实 store 与真实云函数组合，独立设备存储 + 模拟传输故障，不访问云数据库。 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { makeHarness } = require('./support/study-sync-harness.js')

function device(server, saved, cloudReady = true) {
  const storage = saved ? new Map([...saved].map(([key, value]) => [key, JSON.parse(JSON.stringify(value))]))
    : new Map([['exam_quiz_session_v1', { logged: true, token: 'tokA', openid: 'alice' }]])
  const inflight = new Set()
  const controls = { offline: false, loseDeleteAck: false, loseClearAck: false, clearAckGate: null, failStorage: false, requests: [] }
  const clone = value => value === undefined ? '' : JSON.parse(JSON.stringify(value))
  const wx = {
    __cloudReady: cloudReady,
    getStorageSync: key => clone(storage.get(key)),
    setStorageSync: (key, value) => storage.set(key, clone(value)),
    removeStorageSync: key => storage.delete(key),
    setStorage: opts => {
      if (controls.failStorage) { if (opts.fail) opts.fail(new Error('injected local storage failure')); return }
      storage.set(opts.key, clone(opts.data)); if (opts.success) opts.success()
    },
    cloud: {
      callFunction(opts) {
        controls.requests.push(clone(opts.data))
        const promise = (async () => {
          if (controls.offline) { opts.fail(new Error('offline')); return }
          const result = await server.main(clone(opts.data))
          if (opts.data.action === 'clearAI') {
            if (controls.clearAckGate) await controls.clearAckGate
            if (controls.loseClearAck) { controls.loseClearAck = false; opts.fail(new Error('clear ack lost')); return }
          }
          if (controls.loseDeleteAck && opts.data.action === 'delete') {
            controls.loseDeleteAck = false
            opts.fail(new Error('ack lost'))
          } else opts.success({ result: clone(result) })
        })()
        inflight.add(promise)
        promise.finally(() => inflight.delete(promise))
        return promise
      }
    }
  }
  const module = { exports: {} }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../utils/store.js'), 'utf8'), {
    module, wx, console, setTimeout, clearTimeout,
    require(name) {
      if (name === './questions.js') return { getSubjects: () => [{ name: '公基' }] }
      if (name === './config.js') return require('../utils/config.js')
      if (name === '../shared/stats-merge.js') return require('../shared/stats-merge.js')
      throw new Error('Unexpected module ' + name)
    }
  })
  const store = module.exports
  store.setUserScope('alice')
  store.load()
  return {
    store, controls, storage, wx,
    async settle() {
      await new Promise(setImmediate)
      while (inflight.size) { await Promise.all([...inflight]); await new Promise(setImmediate) }
    },
    answer(id) { store.submitAttempt({ id, subject: '公基', chapter: '测试', type: 'single', answer: ['A'] }, ['A'], true, 10, id); store.flush() }
  }
}

test('双设备协议：清空后旧设备的离线快照被拒绝并恢复新代次', async () => {
  const server = makeHarness()
  const a = device(server)
  await a.settle()
  a.answer('old')
  await a.settle()
  const b = device(server)
  await b.settle()
  assert.ok(b.store.getRecord('old'))
  b.controls.offline = true
  b.answer('offline-old')
  await b.settle()
  a.store.clearAll()
  await a.settle()
  a.answer('fresh')
  await a.settle()
  b.controls.offline = false
  b.store.flush()
  await b.settle()
  assert.equal(b.store.getRecord('old'), null)
  assert.equal(b.store.getRecord('offline-old'), null)
  assert.ok(b.store.getRecord('fresh'))
  assert.equal(b.store.load().dataEpoch, 1)
  const cloud = await server.main({ token: 'tokA' })
  assert.equal(cloud.attempts.length, 1)
  assert.equal(cloud.attempts[0].questionId, 'fresh')
  a.store.__clearFlushTimer()
  b.store.__clearFlushTimer()
})

test('双设备协议：清空成功但 ACK 丢失，重试不删除其他设备的新数据', async () => {
  const server = makeHarness()
  const a = device(server)
  await a.settle()
  a.answer('old')
  await a.settle()
  a.controls.loseDeleteAck = true
  a.store.clearAll()
  await a.settle()
  assert.ok(a.storage.get('exam_quiz_pending_delete_v1__alice').deleteId)
  const b = device(server)
  await b.settle()
  b.answer('after-reset')
  await b.settle()
  a.store.flush()
  await a.settle()
  assert.equal(a.storage.has('exam_quiz_pending_delete_v1__alice'), false)
  const cloud = await server.main({ token: 'tokA' })
  assert.equal(cloud.dataEpoch, 1)
  assert.equal(cloud.attempts.length, 1)
  assert.equal(cloud.attempts[0].questionId, 'after-reset')
  a.store.__clearFlushTimer()
  b.store.__clearFlushTimer()
})

test('双设备协议：离线清空被另一台设备的新清空取代，不能把未获代次的作答带入当前代次', async () => {
  const server = makeHarness()
  const a = device(server)
  const b = device(server)
  await a.settle()
  await b.settle()
  a.controls.offline = true
  a.store.clearAll()
  a.answer('obsolete-after-local-clear')
  await a.settle()
  b.store.clearAll()
  await b.settle()
  b.answer('current')
  await b.settle()
  a.controls.offline = false
  a.store.flush()
  await a.settle()
  const cloud = await server.main({ token: 'tokA' })
  assert.equal(a.store.getRecord('obsolete-after-local-clear'), null)
  assert.ok(a.store.getRecord('current'))
  assert.equal(cloud.attempts.length, 1)
  assert.equal(cloud.attempts[0].questionId, 'current')
  a.store.__clearFlushTimer()
  b.store.__clearFlushTimer()
})

test('独立 AI 清空由服务端排序：B 的旧本地代次不能让 A 的清空后消息复活', async () => {
  const server = makeHarness()
  const a = device(server)
  const b = device(server)
  await a.settle()
  await b.settle()
  a.store.clearAiMessages()
  await a.settle()
  a.store.pushAiMessage({ time: 101, role: 'user', text: 'A 清空后、B 清空前的消息' })
  a.store.flush()
  await a.settle()
  assert.equal(b.store.load().aiEpoch, 0, 'B 未观察到 A 的清空')
  b.store.clearAiMessages()
  await b.settle()
  const cloud = await server.main({ token: 'tokA' })
  assert.equal(cloud.stats.aiMessages.length, 0, '较晚的独立清空必须删除云端已有消息')
  assert.equal(cloud.stats.aiEpoch, 2, '两个独立清空必须获得不同服务端代次')
  const reopened = device(server)
  await reopened.settle()
  assert.equal(reopened.store.getAiMessages().length, 0, '重新打开不能恢复被删除消息')
  for (const client of [a, b, reopened]) client.store.__clearFlushTimer()
})

test('AI 清空 ACK 丢失并重启后重试：识别被取代的旧操作，保留另一设备的新消息', async () => {
  const server = makeHarness()
  const a = device(server)
  const b = device(server)
  await a.settle()
  await b.settle()
  a.controls.loseClearAck = true
  a.store.clearAiMessages()
  await a.settle()
  const first = a.controls.requests.find(r => r.action === 'clearAI')
  a.store.pushAiMessage({ time: 101, role: 'user', text: '旧清空后的未确认消息' })
  a.store.flush()
  // 不让本次 flush 在重启前自动重试；先保留已写盘队列，立即离线。
  a.controls.offline = true
  await a.settle()
  b.store.clearAiMessages()
  await b.settle()
  b.store.pushAiMessage({ time: 202, role: 'user', text: '最新消息' })
  b.store.flush()
  await b.settle()
  const reopened = device(server, a.storage)
  await reopened.settle()
  assert.equal(reopened.controls.requests.find(r => r.action === 'clearAI').clearId, first.clearId)
  assert.equal(reopened.store.getAiMessages().length, 1)
  assert.equal(reopened.store.getAiMessages()[0].text, '最新消息')
  const cloud = await server.main({ token: 'tokA' })
  assert.equal(cloud.stats.aiEpoch, 2)
  assert.equal(cloud.stats.aiMessages[0].text, '最新消息')
  for (const client of [a, b, reopened]) client.store.__clearFlushTimer()
})

test('AI 清空失败保留意图和后续消息，恢复后先清空再提交学习数据', async () => {
  const server = makeHarness()
  const a = device(server)
  await a.settle()
  a.store.pushAiMessage({ time: 1, role: 'user', text: '旧消息' })
  a.store.flush()
  await a.settle()
  server.fail.receiptWrite = new Error('injected timeout')
  a.store.clearAiMessages()
  await a.settle()
  a.store.pushAiMessage({ time: 2, role: 'user', text: '清空后新消息' })
  a.answer('after-clear')
  await a.settle()
  assert.ok(a.store.load().aiClearQueue.length)
  assert.equal((await server.main({ token: 'tokA' })).stats.records['after-clear'], undefined)
  server.fail.receiptWrite = null
  a.store.flush()
  await a.settle()
  const cloud = await server.main({ token: 'tokA' })
  assert.equal(cloud.stats.aiMessages.length, 1)
  assert.equal(cloud.stats.aiMessages[0].text, '清空后新消息')
  assert.ok(cloud.stats.records['after-clear'])
  assert.equal(cloud.attempts.length, 1)
  assert.equal(a.store.load().aiClearQueue.length, 0)
  a.store.__clearFlushTimer()
})

test('同一设备连续清空分别确认，较早 ACK 不会确认较晚的意图', async () => {
  const server = makeHarness()
  const a = device(server)
  await a.settle()
  let release
  a.controls.clearAckGate = new Promise(resolve => { release = resolve })
  a.store.clearAiMessages()
  await new Promise(setImmediate)
  a.store.pushAiMessage({ time: 10, role: 'user', text: '第一次之后' })
  a.store.clearAiMessages()
  a.store.pushAiMessage({ time: 20, role: 'user', text: '第二次之后' })
  a.store.flush()
  a.controls.clearAckGate = null
  release()
  await a.settle()
  const clears = a.controls.requests.filter(r => r.action === 'clearAI')
  assert.equal(clears.length, 2)
  assert.notEqual(clears[0].clearId, clears[1].clearId)
  const cloud = await server.main({ token: 'tokA' })
  assert.equal(cloud.stats.aiEpoch, 2)
  assert.equal(cloud.stats.aiMessages.length, 1)
  assert.equal(cloud.stats.aiMessages[0].text, '第二次之后')
  a.store.__clearFlushTimer()
})

test('旧设备上传时只作废旧 AI 片段，不丢新学习流水或当前云端对话', async () => {
  const server = makeHarness()
  const a = device(server)
  const b = device(server)
  await a.settle()
  await b.settle()
  a.store.clearAiMessages()
  await a.settle()
  a.store.pushAiMessage({ time: 10, role: 'user', text: '已被 B 清空' })
  a.store.flush()
  await a.settle()
  b.store.clearAiMessages()
  await b.settle()
  b.store.pushAiMessage({ time: 20, role: 'user', text: 'B 的当前消息' })
  b.store.flush()
  await b.settle()
  a.answer('keep-answer')
  await a.settle()
  const cloud = await server.main({ token: 'tokA' })
  assert.ok(cloud.stats.records['keep-answer'])
  assert.equal(cloud.attempts.length, 1)
  assert.equal(cloud.stats.aiMessages.length, 1)
  assert.equal(a.store.getAiMessages()[0].text, 'B 的当前消息')
  assert.equal(a.store.load().aiEpoch, 2)
  for (const client of [a, b]) client.store.__clearFlushTimer()
})

test('AI 清空前发出的恢复回包不能把旧对话合并回来', async () => {
  const real = makeHarness()
  await real.main({ token: 'tokA', action: 'update', stats: { aiEpoch: 0,
    aiMessages: [{ time: 1, role: 'user', text: '待清空旧消息' }] } })
  let release, snapshotReady
  const gate = new Promise(resolve => { release = resolve })
  const ready = new Promise(resolve => { snapshotReady = resolve })
  let first = true
  const server = { main: async event => {
    const result = await real.main(event)
    if (event.action === 'get' && first) { first = false; snapshotReady(); await gate }
    return result
  } }
  const a = device(server)
  await ready
  a.store.clearAiMessages()
  await new Promise(setImmediate)
  release()
  await a.settle()
  assert.equal(a.store.getAiMessages().length, 0)
  assert.equal((await real.main({ token: 'tokA' })).stats.aiMessages.length, 0)
  a.store.__clearFlushTimer()
})

test('切账号后 AI 清空迟到 ACK 不改写新账号，重登录原账号仍可幂等确认', async () => {
  const server = makeHarness()
  await server.main({ token: 'tokB', action: 'update', stats: { aiEpoch: 0,
    aiMessages: [{ time: 9, role: 'user', text: 'Bob 历史' }] } })
  const a = device(server)
  await a.settle()
  let release
  a.controls.clearAckGate = new Promise(resolve => { release = resolve })
  a.store.clearAiMessages()
  await new Promise(setImmediate)
  a.storage.set('exam_quiz_session_v1', { logged: true, token: 'tokB', openid: 'bob' })
  a.store.setUserScope('bob')
  a.store.load()
  a.controls.clearAckGate = null
  release()
  await a.settle()
  assert.equal(a.store.getAiMessages()[0].text, 'Bob 历史')
  assert.equal(a.store.load().aiEpoch, 0)
  a.storage.set('exam_quiz_session_v1', { logged: true, token: 'tokA', openid: 'alice' })
  a.store.setUserScope('alice')
  a.store.load()
  await a.settle()
  assert.equal(a.store.load().aiClearQueue.length, 0)
  assert.equal((await server.main({ token: 'tokA' })).stats.aiEpoch, 1)
  assert.equal((await server.main({ token: 'tokB' })).stats.aiMessages[0].text, 'Bob 历史')
  a.store.__clearFlushTimer()
})

test('离线 AI 清空遇到整体清空时被 dataEpoch 作废，不能删除新学习代次的消息', async () => {
  const server = makeHarness()
  const a = device(server)
  const b = device(server)
  await a.settle()
  await b.settle()
  a.controls.offline = true
  a.store.clearAiMessages()
  await a.settle()
  b.store.clearAll()
  await b.settle()
  b.store.pushAiMessage({ time: 2, role: 'user', text: '整体清空后的新消息' })
  b.store.flush()
  await b.settle()
  a.controls.offline = false
  a.store.flush()
  await a.settle()
  const cloud = await server.main({ token: 'tokA' })
  assert.equal(cloud.dataEpoch, 1)
  assert.equal(cloud.stats.aiMessages[0].text, '整体清空后的新消息')
  assert.equal(a.store.getAiMessages()[0].text, '整体清空后的新消息')
  assert.equal(a.store.load().dataEpoch, 1)
  for (const client of [a, b]) client.store.__clearFlushTimer()
})

test('清空意图写盘失败时不发送，写盘恢复后仍按同一 ID 清空', async () => {
  const server = makeHarness()
  const a = device(server)
  await a.settle()
  a.controls.failStorage = true
  a.store.clearAiMessages()
  await a.settle()
  const id = a.store.load().aiClearQueue[0].clearId
  assert.equal(a.controls.requests.filter(r => r.action === 'clearAI').length, 0)
  a.store.flush()
  await a.settle()
  assert.equal(a.controls.requests.filter(r => r.action === 'clearAI').length, 0)
  a.controls.failStorage = false
  a.store.flush()
  await a.settle()
  const requests = a.controls.requests.filter(r => r.action === 'clearAI')
  assert.equal(requests.length, 1)
  assert.equal(requests[0].clearId, id)
  assert.equal(a.store.load().aiClearQueue.length, 0)
  assert.equal((await server.main({ token: 'tokA' })).stats.aiEpoch, 1)
  a.store.__clearFlushTimer()
})

test('云初始化失败时清空仍持久化账号删除意图，且不发出请求', async () => {
  const server = makeHarness()
  const a = device(server)
  await a.settle()
  a.answer('old-cloud-record')
  await a.settle()
  const requestsBefore = a.controls.requests.length
  a.wx.__cloudReady = false
  a.store.clearAll()
  await a.settle()
  const operation = a.storage.get('exam_quiz_pending_delete_v1__alice')
  assert.ok(operation && operation.deleteId, '初始化不可用也必须保留可重试的删除 ID')
  assert.equal(operation.dataEpoch, 0)
  assert.equal(a.controls.requests.length, requestsBefore, '云未就绪不得发送请求')
  assert.equal(a.store.getRecord('old-cloud-record'), null)
  assert.ok((await server.main({ token: 'tokA' })).stats.records['old-cloud-record'])
  a.store.__clearFlushTimer()
})

test('云不可用清空后重启，恢复云端时先补删除而不能恢复旧备份', async () => {
  const server = makeHarness()
  const a = device(server)
  await a.settle()
  a.answer('must-stay-deleted')
  await a.settle()
  a.wx.__cloudReady = false
  a.store.clearAll()
  await a.settle()
  const reopened = device(server, a.storage, false)
  await reopened.settle()
  assert.equal(reopened.controls.requests.length, 0)
  reopened.wx.__cloudReady = true
  reopened.store.pullFromCloud()
  await reopened.settle()
  assert.equal(reopened.store.getRecord('must-stay-deleted'), null, '不能恢复被用户清空的旧记录')
  assert.equal(reopened.controls.requests[0].action, 'delete', '恢复传输后必须先处理持久删除意图')
  const cloud = await server.main({ token: 'tokA' })
  assert.equal(cloud.dataEpoch, 1)
  assert.equal(cloud.stats && cloud.stats.records['must-stay-deleted'], undefined)
  assert.equal(cloud.attempts.length, 0)
  for (const client of [a, reopened]) client.store.__clearFlushTimer()
})

test('同一进程恢复云连接时绕过已完成启动拉取，先删除再补传清空后的新作答', async () => {
  const server = makeHarness()
  const a = device(server)
  await a.settle()
  a.answer('old')
  await a.settle()
  a.wx.__cloudReady = false
  a.store.clearAll()
  const operation = a.storage.get('exam_quiz_pending_delete_v1__alice')
  a.answer('new-offline-answer')
  await a.settle()
  const start = a.controls.requests.length
  a.wx.__cloudReady = true
  a.store.pullFromCloud()
  await a.settle()
  assert.equal(a.controls.requests[start].action, 'delete')
  assert.equal(a.controls.requests[start].deleteId, operation.deleteId)
  const cloud = await server.main({ token: 'tokA' })
  assert.equal(cloud.dataEpoch, 1)
  assert.equal(cloud.stats.records.old, undefined)
  assert.ok(cloud.stats.records['new-offline-answer'])
  assert.equal(cloud.attempts.length, 1)
  assert.equal(cloud.attempts[0].questionId, 'new-offline-answer')
  a.store.__clearFlushTimer()
})

test('无可用登录令牌仍保存原账号删除意图，切换账号不会以新身份执行', async () => {
  const server = makeHarness()
  const a = device(server)
  await a.settle()
  a.answer('alice-old')
  await a.settle()
  await server.main({ token: 'tokB', action: 'update', stats: { records: { bob: { id: 'bob', attempts: 1 } } } })
  a.storage.set('exam_quiz_session_v1', { logged: false, token: '', openid: 'alice' })
  const before = a.controls.requests.length
  a.store.clearAll()
  await a.settle()
  assert.ok(a.storage.get('exam_quiz_pending_delete_v1__alice').deleteId)
  assert.equal(a.controls.requests.length, before)
  a.storage.set('exam_quiz_session_v1', { logged: true, token: 'tokB', openid: 'bob' })
  a.store.setUserScope('bob')
  a.store.load()
  await a.settle()
  assert.ok((await server.main({ token: 'tokB' })).stats.records.bob)
  assert.equal(a.controls.requests.filter(r => r.action === 'delete').length, 0)
  a.storage.set('exam_quiz_session_v1', { logged: true, token: 'tokA', openid: 'alice' })
  a.store.setUserScope('alice')
  a.store.load()
  await a.settle()
  const deletion = a.controls.requests.find(r => r.action === 'delete')
  assert.equal(deletion.token, 'tokA')
  assert.equal((await server.main({ token: 'tokA' })).stats.records['alice-old'], undefined)
  assert.ok((await server.main({ token: 'tokB' })).stats.records.bob)
  a.store.__clearFlushTimer()
})

test('匿名本地清空不创建云端删除意图，也不能使用缓存令牌删除账号备份', async () => {
  const server = makeHarness()
  const a = device(server)
  await a.settle()
  a.answer('account-backup')
  await a.settle()
  a.store.setUserScope(null)
  a.store.load()
  a.store.clearAll()
  await a.settle()
  assert.equal(a.storage.has('exam_quiz_pending_delete_v1__anon'), false)
  assert.equal(a.controls.requests.filter(r => r.action === 'delete').length, 0)
  assert.ok((await server.main({ token: 'tokA' })).stats.records['account-backup'])
  a.store.__clearFlushTimer()
})
