/** 独立设备存储与传输故障替身，运行真实 store，不连接真实云。 */
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

function device(server, saved, cloudReady = true, questionBank) {
  const storage = saved ? new Map([...saved].map(([key, value]) => [key, JSON.parse(JSON.stringify(value))]))
    : new Map([['exam_quiz_session_v1', { logged: true, token: 'tokA', openid: 'alice' }]])
  const inflight = new Set()
  const controls = { offline: false, loseDeleteAck: false, loseClearAck: false, clearAckGate: null, failStorage: false, failDeleteWrite: false, failDeleteRead: false, failDeleteRemove: false, failDataSyncWrite: false, failAckWrite: false, loseUpdateAck: false, failUpdate: 0, updateAckGate: null, changeUpdateResult: null, failGet: 0, pageLimit: null, getAckGate: null, afterGet: null, changeGetResult: null, failCursorWrite: false, now: null, requests: [] }
  const clone = value => value === undefined ? '' : JSON.parse(JSON.stringify(value))
  const wx = {
    __cloudReady: cloudReady,
    getStorageSync: key => {
      if (controls.failDeleteRead && key.startsWith('exam_quiz_pending_delete_v1__')) {
        if (typeof controls.failDeleteRead === 'number') controls.failDeleteRead -= 1
        throw new Error('injected pending marker read failure')
      }
      return clone(storage.get(key))
    },
    setStorageSync: (key, value) => {
      if (controls.failDeleteWrite && key.startsWith('exam_quiz_pending_delete_v1__')) throw new Error('injected storage full for delete marker')
      if ((controls.failDataSyncWrite || controls.failStorage) && key.startsWith('exam_quiz_data_v1__')) throw new Error('injected deletion ACK checkpoint failure')
      if (controls.failCursorWrite && key.startsWith('exam_quiz_data_v1__')) {
        const before = storage.get(key)
        if (value.syncCursor && JSON.stringify(before && before.syncCursor) !== JSON.stringify(value.syncCursor)) throw new Error('cursor checkpoint unavailable')
      }
      if (controls.failAckWrite && key.startsWith('exam_quiz_data_v1__')) {
        const before = storage.get(key)
        if (before && before.attemptOutbox && value.attemptOutbox && before.attemptOutbox.pending.length > value.attemptOutbox.pending.length) throw new Error('ACK checkpoint unavailable')
      }
      storage.set(key, clone(value))
    },
    removeStorageSync: key => {
      if (controls.failDeleteRemove && key.startsWith('exam_quiz_pending_delete_v1__')) throw new Error('injected pending marker remove failure')
      storage.delete(key)
    },
    setStorage: opts => {
      if (controls.failStorage) { if (opts.fail) opts.fail(new Error('injected local storage failure')); return }
      storage.set(opts.key, clone(opts.data)); if (opts.success) opts.success()
    },
    cloud: {
      callFunction(opts) {
        const request = clone(opts.data)
        if (request.action === 'get' && controls.pageLimit) request.limit = controls.pageLimit
        controls.requests.push(request)
        const promise = (async () => {
          if (controls.offline) { opts.fail(new Error('offline')); return }
          if (['commitAttempts', 'commitVersionedAttempts'].includes(opts.data.action) && controls.failUpdate && --controls.failUpdate === 0) { opts.fail(new Error('injected update transport failure')); return }
          if (request.action === 'get' && controls.failGet && --controls.failGet === 0) { opts.fail(new Error('injected get transport failure')); return }
          let result = await server.main(request)
          if (request.action === 'get') {
            if (controls.getAckGate) await controls.getAckGate
            if (controls.afterGet) await controls.afterGet(result, request)
            if (controls.changeGetResult) result = controls.changeGetResult(result, request)
          }
          if (['commitAttempts', 'commitVersionedAttempts'].includes(opts.data.action)) {
            if (controls.updateAckGate) await controls.updateAckGate
            if (controls.loseUpdateAck) { controls.loseUpdateAck = false; opts.fail(new Error('update ACK lost')); return }
            if (controls.changeUpdateResult) result = controls.changeUpdateResult(result, opts.data)
          }
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
  class DeviceDate extends Date {
    constructor(...args) { super(...(args.length ? args : [controls.now === null ? Date.now() : controls.now])) }
    static now() { return controls.now === null ? Date.now() : controls.now }
  }
  const module = { exports: {} }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../utils/store.js'), 'utf8'), {
    module, wx, console, setTimeout, clearTimeout, Date: DeviceDate,
    require(name) {
      if (name === './questions.js') return questionBank || { getSubjects: () => [{ name: '公基' }] }
      if (name === './sync-coordinator.js') return require('../../utils/sync-coordinator.js')
      if (name === './attempt-outbox.js') return require('../../utils/attempt-outbox.js')
      if (name === './config.js') return require('../../utils/config.js')
      if (name === '../shared/attempt-domain.js') return require('../../shared/attempt-domain.js')
      if (name === '../shared/stats-merge.js') return require('../../shared/stats-merge.js')
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

module.exports = { device }
