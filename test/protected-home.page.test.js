require('./wx-shim.js')
const { test } = require('node:test')
const assert = require('node:assert/strict')
const config = require('../utils/config.js')
const user = require('../utils/user.js')
const store = require('../utils/store.js')
const catalogModule = require('../utils/protected-catalog.js')
const state = { exams: [{ id: 'a', name: '考试甲' }, { id: 'b', name: '考试乙' }], selected: 'a',
  subjects: [{ key: 'first', name: '科目甲', examId: 'a' }] }
let page, catalog
const app = { globalData: { sessionReady: true }, onRuntimeConfigChange: () => () => {}, startPractice: opts => { app.params = opts } }
global.getApp = () => app
global.Page = definition => { page = definition }
require('../pages/index/index.js')
function setup(t) {
  const original = config.protectedCatalog; config.protectedCatalog = true
  let current = { ...state }, pending = null
  catalog = { load: () => pending || Promise.resolve(current), clear: () => { current = null },
    select: exam => { if (!current || !['a', 'b'].includes(exam)) return false; current = { ...current, selected: exam, subjects: [{ key: exam === 'a' ? 'first' : 'second', name: '科目', examId: exam }] }; return true },
    snapshot: () => current }
  // Page has a destructured factory; replace the stable singleton's methods instead.
  const singleton = catalogModule.runtimeProtectedCatalog()
  for (const key of ['load', 'clear', 'select', 'snapshot']) t.mock.method(singleton, key, (...args) => catalog[key](...args))
  t.mock.method(user, 'whenReady', cb => { cb(); return true }); t.mock.method(user, 'isLogged', () => true)
  t.mock.method(store, 'onSyncRestored', () => () => {})
  const p = Object.assign({}, page, { data: { ...page.data }, setData(v) { Object.assign(this.data, v) } })
  p.onLoad(); p.onShow()
  t.after(() => { p.onUnload(); config.protectedCatalog = original })
  return { p, defer: promise => { pending = promise } }
}
test('首页使用受保护目录选择考试和科目并携带到练习入口', async t => {
  const { p } = setup(t); await new Promise(setImmediate)
  assert.equal(p.data.protectedMode, true); assert.equal(p.data.currentExam, 'a')
  p.onExamChange({ currentTarget: { dataset: { exam: 'b' } } })
  assert.equal(p.data.currentExam, 'b'); assert.equal(p.data.subjects[0].key, 'second')
  p.goPractice({ currentTarget: { dataset: { mode: 'all', subject: 'second' } } })
  assert.deepEqual(app.params, { mode: 'all', subject: 'second' })
})
test('隐藏页面后目录迟到响应不恢复界面，失败时不展示旧目录', async t => {
  const { p, defer } = setup(t); await new Promise(setImmediate)
  let resolve; defer(new Promise(r => { resolve = r }))
  const waiting = p.refreshProtectedCatalog(); p.onHide(); resolve(state); await waiting
  assert.deepEqual(p.data.exams, [])
  p._visible = true; defer(Promise.reject(new Error('network'))); await p.refreshProtectedCatalog()
  assert.match(p.data.catalogError, /失败/); assert.deepEqual(p.data.exams, [])
})
