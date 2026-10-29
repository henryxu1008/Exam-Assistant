/**
 * Issue 1：会话安全与本地数据隔离测试
 * 覆盖：服务端令牌校验（取代仅 wx.checkSession）、伪造/失效令牌强制重登、
 *       按 openid 绑定数据作用域、登出切回匿名、断网时保留本地会话。
 * 通过可控的 wx.cloud.callFunction mock 模拟云函数响应。
 */
require('./wx-shim.js')
const { test } = require('node:test')
const assert = require('node:assert')

let cloudHandler = () => ({ ok: true })

function installCloud() {
  global.wx.login = (opts) => {
    if (opts && opts.success) opts.success({ code: 'CODE123' })
  }
  global.wx.checkSession = (opts) => {
    if (opts && opts.success) opts.success()
  }
  global.wx.cloud = {
    init() {
      return true
    },
    callFunction({ name, data }) {
      return Promise.resolve({ result: cloudHandler(name, data) })
    }
  }
}

const CACHE_KEYS = [
  '../utils/user.js',
  '../utils/store.js',
  '../utils/analytics.js',
  '../utils/questions.js',
  '../utils/bank/index.js',
  '../utils/bank/manifest.js',
  '../utils/bank/gk.js',
  '../utils/bank/nl.js',
  '../utils/bank/it.js'
]

function freshUser() {
  global.__wxStorage.clearAll()
  CACHE_KEYS.forEach((m) => {
    try {
      delete require.cache[require.resolve(m)]
    } catch (e) {
      /* not loaded */
    }
  })
  cloudHandler = () => ({ ok: true })
  installCloud()
  return require('../utils/user.js')
}

const { SUBJECT } = require('./helpers.js')

test('未登录时 ensureSession 返回 null', () => {
  const user = freshUser()
  assert.strictEqual(user.isLogged(), false)
  return user.ensureSession().then((p) => assert.strictEqual(p, null))
})

test('登录成功后按 openid 切换数据作用域', () => {
  const user = freshUser()
  cloudHandler = (name) => {
    if (name === 'userLogin')
      return { ok: true, openid: 'OPENID_X', token: 'TOK_X', profile: { nickName: '小明', avatarUrl: 'cloud://a', exam: '公考' } }
    if (name === 'userProfile') return { ok: true, profile: { nickName: '小明', avatarUrl: 'cloud://a', exam: '公考' } }
    return { ok: true }
  }
  return user.login().then(() => {
    assert.strictEqual(user.isLogged(), true)
    const store = require('../utils/store.js')
    assert.strictEqual(store.getUserScope(), 'OPENID_X') // 数据落在用户命名空间
    store.recordAnswer({ id: 'q1', subject: SUBJECT, chapter: 'c', type: 'single', answer: ['A'] }, true, 100)
    store.flush()
    assert.strictEqual(Object.keys(store.getRecords()).length, 1)
  })
})

test('服务端确认令牌有效时保留会话（不重复登录）', () => {
  const user = freshUser()
  let loginCalls = 0
  cloudHandler = (name) => {
    if (name === 'userLogin') {
      loginCalls += 1
      return { ok: true, openid: 'OPENID_X', token: 'TOK_X', profile: {} }
    }
    if (name === 'userProfile') return { ok: true, profile: {} }
    return { ok: true }
  }
  return user
    .login()
    .then(() => user.ensureSession())
    .then((p) => {
      assert.ok(p)
      assert.strictEqual(loginCalls, 1) // 仅初次登录，校验未触发二次登录
      assert.strictEqual(user.getProfile().token, 'TOK_X')
    })
})

test('伪造/失效令牌：服务端不认时强制重新登录', () => {
  const user = freshUser()
  cloudHandler = (name) => {
    if (name === 'userLogin') return { ok: true, openid: 'OPENID_X', token: 'TOK_NEW', profile: {} }
    if (name === 'userProfile') return { ok: false, error: 'INVALID_TOKEN' } // 旧令牌失效
    return { ok: true }
  }
  // 先以 TOK_OLD 登录
  cloudHandler = (name) => {
    if (name === 'userLogin') return { ok: true, openid: 'OPENID_X', token: 'TOK_OLD', profile: {} }
    if (name === 'userProfile') return { ok: false, error: 'INVALID_TOKEN' }
    return { ok: true }
  }
  return user
    .login()
    .then(() => {
      assert.strictEqual(user.getProfile().token, 'TOK_OLD')
      // 服务端校验时把 TOK_OLD 视为失效 -> 重新登录拿到 TOK_NEW
      cloudHandler = (name) => {
        if (name === 'userLogin') return { ok: true, openid: 'OPENID_X', token: 'TOK_NEW', profile: {} }
        if (name === 'userProfile') return { ok: false, error: 'INVALID_TOKEN' }
        return { ok: true }
      }
      return user.ensureSession()
    })
    .then((p) => {
      assert.ok(p)
      assert.strictEqual(user.getProfile().token, 'TOK_NEW') // 已换新令牌
    })
})

test('无云环境（断网）时保留本地会话，不踢出用户', () => {
  const user = freshUser()
  cloudHandler = (name) =>
    name === 'userLogin'
      ? { ok: true, openid: 'OPENID_X', token: 'TOK_X', profile: {} }
      : { ok: true, profile: {} }
  return user.login().then(() => {
    global.wx.cloud = undefined // 模拟断网
    return user.ensureSession().then((p) => {
      assert.ok(p) // 仍保留会话
      assert.strictEqual(user.getProfile().token, 'TOK_X') // 未换新
    })
  })
})

test('登出：清除会话并切回匿名作用域', () => {
  const user = freshUser()
  cloudHandler = (name) => {
    if (name === 'userLogin') return { ok: true, openid: 'OPENID_X', token: 'TOK_X', profile: {} }
    if (name === 'userProfile') return { ok: true }
    return { ok: true }
  }
  return user
    .login()
    .then(() => {
      const store = require('../utils/store.js')
      assert.strictEqual(store.getUserScope(), 'OPENID_X')
      return user.logout()
    })
    .then(() => {
      assert.strictEqual(user.isLogged(), false)
      const store = require('../utils/store.js')
      assert.strictEqual(store.getUserScope(), 'anon')
    })
})
