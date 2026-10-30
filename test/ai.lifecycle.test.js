/** AI 页面缓存、预填输入和异步回复必须属于同一账号、同一轮对话。 */
require('./wx-shim.js')
const { test, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const store = require('../utils/store.js')
const ai = require('../utils/ai.js')
const user = require('../utils/user.js')

let definition
const app = { globalData: {} }
global.Page = (page) => { definition = page }
global.getApp = () => app
require('../pages/ai/ai.js')

let pages
let timers
let requests
let logged
let modal
let original

beforeEach(() => {
  store.flush()
  store.setUserScope('anon')
  global.__wxStorage.clearAll()
  store.clearAll()
  app.globalData = {}
  pages = []
  timers = new Map()
  requests = []
  logged = true
  modal = null
  original = {
    setTimeout: global.setTimeout, clearTimeout: global.clearTimeout,
    requestLLM: ai.requestLLM, chat: ai.chat,
    requireLogin: user.requireLogin, showModal: wx.showModal
  }
  let id = 0
  global.setTimeout = (fn) => { timers.set(++id, fn); return id }
  global.clearTimeout = (key) => timers.delete(key)
  ai.requestLLM = (...args) => new Promise((resolve, reject) => requests.push({ args, resolve, reject }))
  ai.chat = () => ({ reply: '本地回复', bullets: [], cards: [] })
  user.requireLogin = (onLogged) => { if (logged && onLogged) onLogged(); return logged }
  wx.showModal = (options) => { modal = options }
})

afterEach(() => {
  pages.forEach((page) => page.onUnload())
  store.flush()
  global.setTimeout = original.setTimeout
  global.clearTimeout = original.clearTimeout
  ai.requestLLM = original.requestLLM
  ai.chat = original.chat
  user.requireLogin = original.requireLogin
  wx.showModal = original.showModal
})

function makePage() {
  const page = Object.assign({}, definition)
  page.data = JSON.parse(JSON.stringify(definition.data))
  page.setData = function (patch, callback) {
    Object.assign(this.data, patch)
    if (callback) callback()
  }
  pages.push(page)
  page.onLoad()
  return page
}

function texts(page) { return page.data.messages.map((msg) => msg.text) }
function savedTexts() { return store.getAiMessages().map((msg) => msg.text) }
function save(text) { store.pushAiMessage({ role: 'user', text }) }
async function settle() { await Promise.resolve(); await Promise.resolve() }

function switchWithHistory(scope, text) {
  store.setUserScope(scope)
  save(text)
}

test('匿名页登录后先重载用户历史，再且仅消费一次预填输入', () => {
  switchWithHistory('A', 'A 的历史')
  switchWithHistory('anon', '匿名历史')
  logged = false
  const page = makePage()
  page.onInput({ detail: { value: '匿名草稿' } })
  app.globalData.aiPreInput = '这道题怎么解？'
  const context = { questionId: 'q1', userAnswer: ['B'] }
  app.globalData.aiContext = context
  page.onShow()
  assert.equal(requests.length, 0)
  assert.equal(app.globalData.aiPreInput, '这道题怎么解？')

  store.setUserScope('A')
  logged = true
  page.onShow()
  assert.deepEqual(texts(page), ['A 的历史', '这道题怎么解？'])
  assert.equal(page.data.input, '')
  assert.deepEqual(requests[0].args[0].map((msg) => msg.content), ['A 的历史', '这道题怎么解？'])
  assert.deepEqual(requests[0].args[2], context)
  assert.equal(app.globalData.aiPreInput, '')
  assert.equal(app.globalData.aiContext, null)
  page.onShow()
  assert.equal(requests.length, 1)
})

test('同一账号反复显示页面保留草稿、历史和正在等待的回复', async () => {
  store.setUserScope('A')
  save('历史')
  const page = makePage()
  page.send('你好', {})
  page.onInput({ detail: { value: '下一条草稿' } })
  page.onShow()
  assert.equal(page.data.input, '下一条草稿')
  assert.equal(page.data.loading, true)
  requests[0].resolve('正常回复')
  await settle()
  assert.deepEqual(texts(page), ['历史', '你好', '正常回复'])
  assert.deepEqual(savedTexts(), ['历史', '你好', '正常回复'])
})

test('切换账号后显示新账号历史，清除旧草稿和 loading', () => {
  switchWithHistory('B', 'B 的历史')
  switchWithHistory('A', 'A 的历史')
  const page = makePage()
  page.send('你好', {})
  page.onInput({ detail: { value: 'A 的草稿' } })
  store.setUserScope('B')
  page.onShow()
  assert.deepEqual(texts(page), ['B 的历史'])
  assert.equal(page.data.input, '')
  assert.equal(page.data.loading, false)
})

for (const outcome of ['resolve', 'reject', 'fallback']) {
  test(`页面尚未 onShow 就切换账号：丢弃旧远程结果 (${outcome})`, async () => {
    store.setUserScope('A')
    const page = makePage()
    page.send('你好', {})
    switchWithHistory('B', 'B 的历史')
    if (outcome === 'reject') requests[0].reject(new Error('network down'))
    else requests[0].resolve(outcome === 'fallback' ? null : 'A 的旧回复')
    await settle()
    // 手动触发可运行的 timer，检测错误回落是否读取了 B 的学习数据。
    Array.from(timers.values()).forEach((run) => run())
    assert.deepEqual(savedTexts(), ['B 的历史'])
    assert.ok(!texts(page).includes('A 的旧回复'))
    assert.ok(!texts(page).includes('本地回复'))
  })
}

test('A→B→A 后仍丢弃旧请求，且不干扰新请求的 loading', async () => {
  store.setUserScope('A')
  const page = makePage()
  page.send('第一个问题', {})
  store.setUserScope('B')
  store.setUserScope('A')
  page.onShow()
  page.send('第二个问题', {})
  assert.equal(requests.length, 2)
  requests[0].resolve('过期回复')
  await settle()
  assert.equal(page.data.loading, true)
  assert.ok(!savedTexts().includes('过期回复'))
  requests[1].resolve('新回复')
  await settle()
  assert.equal(page.data.loading, false)
  assert.equal(savedTexts().at(-1), '新回复')
})

test('账号切换使已排队的本地回复失效，不读取新用户学习数据', () => {
  store.setUserScope('A')
  const page = makePage()
  page.send('我的正确率多少', {})
  let reads = 0
  ai.chat = () => { reads += 1; return { reply: '旧回复' } }
  switchWithHistory('B', 'B 的历史')
  Array.from(timers.values()).forEach((run) => run())
  assert.equal(reads, 0)
  assert.deepEqual(savedTexts(), ['B 的历史'])
})

test('发消息前发现作用域变化，远程请求只包含新用户历史', () => {
  switchWithHistory('A', 'A 的历史')
  const page = makePage()
  switchWithHistory('B', 'B 的历史')
  page.send('你好', {})
  assert.deepEqual(requests[0].args[0].map((msg) => msg.content), ['B 的历史', '你好'])
  assert.deepEqual(savedTexts(), ['B 的历史', '你好'])
})

for (const action of ['clearAll', 'clearAiMessages', 'clearScope']) {
  test(`${action} 后同账号缓存和在途请求均失效`, async () => {
    store.setUserScope('A')
    save('旧历史')
    const page = makePage()
    page.send('你好', {})
    store[action]()
    requests[0].resolve('已删除对话的回复')
    await settle()
    assert.deepEqual(savedTexts(), [])
    page.onShow()
    assert.equal(page.data.messages.length, 1) // 欢迎语
    assert.ok(!texts(page).includes('旧历史'))
    assert.equal(page.data.loading, false)
  })
}

test('清空对话后新请求不受旧请求结果影响', async () => {
  store.setUserScope('A')
  const page = makePage()
  page.send('第一个问题', {})
  page.onClear()
  modal.success({ confirm: true })
  page.send('第二个问题', {})
  requests[0].resolve('旧回复')
  await settle()
  assert.equal(page.data.loading, true)
  assert.deepEqual(savedTexts(), ['第二个问题'])
  requests[1].resolve('新回复')
  await settle()
  assert.deepEqual(savedTexts(), ['第二个问题', '新回复'])
})

test('账号切换后旧清空确认框不能删除新用户对话', () => {
  switchWithHistory('A', 'A 的历史')
  const page = makePage()
  page.onClear()
  switchWithHistory('B', 'B 的历史')
  modal.success({ confirm: true })
  assert.deepEqual(savedTexts(), ['B 的历史'])
})

test('登出跳转登录前移除旧用户页面历史', () => {
  switchWithHistory('A', 'A 的历史')
  const page = makePage()
  store.setUserScope('anon')
  logged = false
  page.onShow()
  assert.ok(!texts(page).includes('A 的历史'))
})

test('卸载后到达的远程回复不能回写存储', async () => {
  store.setUserScope('A')
  const page = makePage()
  page.send('你好', {})
  page.onUnload()
  requests[0].resolve('卸载后的回复')
  await settle()
  assert.deepEqual(savedTexts(), ['你好'])
})
