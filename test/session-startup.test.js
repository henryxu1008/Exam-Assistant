/** 启动认证竞态：使用真实 App/user/页面生命周期，仅替换微信网络与导航。 */
require('./wx-shim.js')
const { test, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const root = path.resolve(__dirname, '..')

let app, user, store, verify, pages, navigation, definition

beforeEach(() => {
  Object.keys(require.cache).forEach((key) => {
    if (key.startsWith(root + '/utils/') || key.startsWith(root + '/pages/') || key === root + '/app.js') delete require.cache[key]
  })
  global.__wxStorage.clearAll()
  wx.setStorageSync('exam_quiz_session_v1', {
    logged: true, openid: 'A', token: 'OLD', loginAt: Date.now()
  })
  verify = {}
  verify.promise = new Promise((resolve, reject) => { verify.resolve = resolve; verify.reject = reject })
  wx.cloud = {
    init() {},
    callFunction: ({ name }) => name === 'userProfile' ? verify.promise : Promise.reject(new Error('login network down'))
  }
  wx.login = ({ success }) => success({ code: 'code' })
  pages = []
  navigation = []
  wx.navigateTo = (options) => { navigation.push(options) }
  wx.showToast = () => {}
  global.getCurrentPages = () => pages
  global.App = (value) => { app = Object.assign({}, value, { globalData: JSON.parse(JSON.stringify(value.globalData)) }) }
  global.getApp = () => app
  global.Page = (value) => { definition = value }
  require('../app.js')
  user = require('../utils/user.js')
  store = require('../utils/store.js')
  app.onLaunch()
})

afterEach(() => {
  pages.forEach((page) => { if (page.onUnload) page.onUnload() })
  store.flush()
})

function makePage(name, options) {
  require(`../pages/${name}/${name}.js`)
  const page = Object.assign({}, definition)
  page.route = `pages/${name}/${name}`
  page.data = JSON.parse(JSON.stringify(definition.data))
  page.setData = function (patch, callback) { Object.assign(this.data, patch); if (callback) callback() }
  pages.push(page)
  if (page.onLoad) page.onLoad(options || {})
  return page
}

async function finish(result) {
  if (result instanceof Error) verify.reject(result)
  else verify.resolve({ result })
  for (let i = 0; i < 40 && !app.globalData.sessionReady; i++) await Promise.resolve()
  assert.equal(app.globalData.sessionReady, true)
}

test('缓存令牌尚在校验时 guard 返回 false，明确失效后只跳转一次登录', async () => {
  let allowed = 0
  assert.equal(user.requireLogin(() => { allowed += 1 }), false)
  assert.equal(user.requireLogin(() => { allowed += 1 }), false)
  assert.equal(navigation.length, 0)
  await finish({ ok: false, error: 'INVALID_TOKEN' })
  assert.equal(user.isLogged(), false)
  assert.equal(allowed, 0)
  assert.equal(navigation.length, 1)
  assert.equal(navigation[0].url, '/pages/login/login')
})

test('网络不可达仍须等校验结束，之后恢复全部等待回调和离线登录', async () => {
  let allowed = 0
  assert.equal(user.requireLogin(() => { allowed += 1 }), false)
  assert.equal(user.requireLogin(() => { allowed += 1 }), false)
  await finish(new Error('offline'))
  assert.equal(allowed, 2)
  assert.equal(user.isLogged(), true)
  assert.equal(user.requireLogin(), true)
  assert.equal(navigation.length, 0)
})

for (const name of ['index', 'mistakes', 'analysis', 'profile']) {
  test(`${name} 等待启动校验后再刷新，异步通过也不遗漏初始化`, async () => {
    const page = makePage(name)
    let refreshed = 0
    page.refresh = () => { refreshed += 1 }
    page.onShow()
    assert.equal(refreshed, 0)
    await finish({ ok: true, profile: {} })
    assert.equal(refreshed, 1)
    assert.equal(navigation.length, 0)
  })
}

test('启动校验期间不创建练习，失效后也不能提交或切科创建会话', async () => {
  const page = makePage('practice')
  page.onShow()
  assert.equal(store.getPracticeSession(), null)
  assert.equal(page.data.question, null)
  const subject = require('../utils/questions.js').getSubjects()[0].name
  page.onSubjectChange({ currentTarget: { dataset: { subject } } })
  assert.equal(store.getPracticeSession(), null)
  await finish({ ok: false, error: 'INVALID_TOKEN' })
  page.onSubmit()
  assert.equal(store.getPracticeSession(), null)
  assert.equal(store.getAttempts().length, 0)
  assert.equal(navigation.length, 1)
})

test('校验异步通过后恢复初始章节参数并可正常提交', async () => {
  const bank = require('../utils/questions.js')
  const subject = bank.getSubjects()[0].name
  const chapter = bank.filterQuestions({ subject })[0].chapter
  const page = makePage('practice', { mode: 'chapter', subject: encodeURIComponent(subject), chapter: encodeURIComponent(chapter) })
  page.onShow()
  assert.equal(page.data.question, null)
  await finish({ ok: true, profile: {} })
  assert.equal(page.data.subject, subject)
  assert.equal(page.data.chapter, chapter)
  assert.ok(page.data.question)
  store.saveSettings({ autoNext: false })
  page.setData({ selected: page.data.question.answer })
  page.onSubmit()
  assert.equal(store.getAttempts().length, 1)
})

test('等待校验时保留单题 pending，离线恢复后只消费一次', async () => {
  const bank = require('../utils/questions.js')
  const id = bank.getAllQuestions()[0].id
  app.globalData.practiceParams = { mode: 'single', ids: [id], __stamp: 100 }
  const page = makePage('practice')
  page.onShow()
  page.loadPending()
  assert.equal(store.getPracticeSession(), null)
  await finish(new Error('offline'))
  assert.equal(page.data.total, 1)
  assert.equal(page.data.queue[0].id, id)
  const sessionId = store.getPracticeSession().id
  page.onShow()
  assert.equal(store.getPracticeSession().id, sessionId)
})

test('AI 校验期间不读取用户历史、不发送或消费预填，离线恢复后继续', async () => {
  store.pushAiMessage({ role: 'user', text: 'A 的历史' })
  const page = makePage('ai')
  let sent = 0
  const ai = require('../utils/ai.js')
  ai.requestLLM = () => { sent += 1; return Promise.resolve('回复') }
  app.globalData.aiPreInput = '你好'
  page.onShow()
  page.send('手动发送', {})
  assert.equal(sent, 0)
  assert.equal(page.data.messages.length, 0)
  assert.equal(app.globalData.aiPreInput, '你好')
  await finish(new Error('offline'))
  assert.equal(sent, 1)
  assert.deepEqual(page.data.messages.slice(0, 2).map((m) => m.text), ['A 的历史', '你好'])
  assert.equal(app.globalData.aiPreInput, '')
})

test('离开页面后启动回调不再初始化旧页面', async () => {
  const old = makePage('practice')
  old.onShow()
  pages.pop()
  const current = makePage('profile')
  let refreshed = 0
  current.refresh = () => { refreshed += 1 }
  current.onShow()
  await finish({ ok: true, profile: {} })
  assert.equal(old.data.question, null)
  assert.equal(store.getPracticeSession(), null)
  assert.equal(refreshed, 1)
})

test('登录跳转失败后允许下一次重试', async () => {
  await finish({ ok: false, error: 'INVALID_TOKEN' })
  assert.equal(user.requireLogin(), false)
  navigation[0].complete()
  assert.equal(user.requireLogin(), false)
  assert.equal(navigation.length, 2)
})
