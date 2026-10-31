/** 真实 store 与真实云函数组合，独立设备存储 + 模拟传输故障，不访问云数据库。 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { makeHarness } = require('./support/study-sync-harness.js')

function device(server) {
  const storage = new Map([['exam_quiz_session_v1', { logged: true, token: 'tokA', openid: 'alice' }]])
  const inflight = new Set()
  const controls = { offline: false, loseDeleteAck: false }
  const clone = value => value === undefined ? '' : JSON.parse(JSON.stringify(value))
  const wx = {
    __cloudReady: true,
    getStorageSync: key => clone(storage.get(key)),
    setStorageSync: (key, value) => storage.set(key, clone(value)),
    removeStorageSync: key => storage.delete(key),
    setStorage: opts => { storage.set(opts.key, clone(opts.data)); if (opts.success) opts.success() },
    cloud: {
      callFunction(opts) {
        const promise = (async () => {
          if (controls.offline) { opts.fail(new Error('offline')); return }
          const result = await server.main(clone(opts.data))
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
    store, controls, storage,
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
