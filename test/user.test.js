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

test('服务端明确拒绝令牌且自动重登失败时清除会话（评审 P2）', () => {
  const user = freshUser()
  let loginCalls = 0
  cloudHandler = (name) => {
    if (name === 'userProfile') return { ok: false, error: 'INVALID_TOKEN' } // 校验时明确拒绝
    if (name === 'userLogin') {
      loginCalls += 1
      if (loginCalls === 1) return { ok: true, openid: 'OPENID_X', token: 'TOK_OLD', profile: {} } // 初始登录成功
      return { ok: false, error: 'LOGIN_FAILED' } // 自动重登失败
    }
    return { ok: true }
  }
  return user
    .login()
    .then(() => {
      assert.strictEqual(user.isLogged(), true) // 初始登录已建立会话
      return user.ensureSession()
    })
    .then((p) => {
      // 明确拒绝 + 无法刷新 -> 撤销会话并要求重新登录，不允许带着失效令牌继续
      assert.strictEqual(p, null)
      assert.strictEqual(user.isLogged(), false)
    })
})

test('评审 P2：网络不可达（callFunction 拒绝）时保留本地会话，不误踢出已登录用户', () => {
  const user = freshUser()
  cloudHandler = () => ({ ok: true, openid: 'OPENID_X', token: 'TOK_X', profile: {} })
  return user.login().then(() => {
    // 模拟传输层失败：callFunction 直接 reject（非服务端显式拒绝）
    global.wx.cloud.callFunction = () => Promise.reject(new Error('network down'))
    return user.ensureSession().then((p) => {
      assert.ok(p, '网络不可达应保留本地会话')
      assert.strictEqual(user.isLogged(), true)
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

test('令牌已被明确拒绝，自动重登网络失败也不能恢复旧令牌', async () => {
  const user = freshUser()
  cloudHandler = () => ({ ok: true, openid: 'OPENID_X', token: 'TOK_OLD', profile: {} })
  await user.login()
  global.wx.cloud.callFunction = ({ name }) => name === 'userProfile'
    ? Promise.resolve({ result: { ok: false, error: 'INVALID_TOKEN' } })
    : Promise.reject(new Error('network down'))
  assert.strictEqual(await user.ensureSession(), null)
  assert.strictEqual(user.isLogged(), false)
  assert.strictEqual(user.getProfile().token, '')
  assert.strictEqual(require('../utils/store.js').getUserScope(), 'anon')
})

test('服务端业务故障不等于令牌被拒绝，保留离线会话', async () => {
  const user = freshUser()
  cloudHandler = () => ({ ok: true, openid: 'OPENID_X', token: 'TOK_X', profile: {} })
  await user.login()
  let loginCalls = 0
  cloudHandler = (name) => {
    if (name === 'userLogin') loginCalls += 1
    return { ok: false, error: 'SERVICE_UNAVAILABLE' }
  }
  const profile = await user.ensureSession()
  assert.strictEqual(profile.token, 'TOK_X')
  assert.strictEqual(loginCalls, 0)
  assert.strictEqual(user.isLogged(), true)
})

/* ---------------- 游客档案并入账号 ---------------- */

const GUEST_Q = { id: 'q_guest', subject: SUBJECT, chapter: 'c', type: 'single', answer: ['A'], stem: '游客题' }

function loginAs(openid) {
  cloudHandler = (name) => {
    if (name === 'userLogin') return { ok: true, openid, token: `TOK_${openid}`, profile: {} }
    return { ok: true }
  }
}

test('游客记录在首次登录时并入账号，匿名档案保留', () => {
  const user = freshUser()
  const store = require('../utils/store.js')
  store.setUserScope('anon')
  store.recordAnswer(GUEST_Q, true, 100)
  store.submitAttempt(GUEST_Q, ['A'], true, 100, 'op-guest')
  store.flush()
  loginAs('OPENID_NEW')
  return user.login().then(() => {
    assert.strictEqual(store.getUserScope(), 'OPENID_NEW')
    assert.deepStrictEqual(Object.keys(store.getRecords()), ['q_guest'], '游客作答必须随登录并入账号')
    assert.strictEqual(store.getAttempts().length, 1)
    const info = user.takeGuestMergeInfo()
    assert.strictEqual(info.adopted, true)
    assert.strictEqual(info.questions, 1)
    // 一次性消费：再取一次必须为空，避免下次冷启动误报
    assert.strictEqual(user.takeGuestMergeInfo(), null)
    // 匿名档案不删除：退出登录后游客记录仍然在
    store.setUserScope('anon')
    assert.deepStrictEqual(Object.keys(store.getRecords()), ['q_guest'])
  })
})

test('升级用户登录：旧版全局档案与游客记录都保留（评审 P1）', () => {
  const user = freshUser()
  const store = require('../utils/store.js')
  const merge = require('../shared/stats-merge.js')
  // 升级前的老版本：学习档案在全局单 key，尚无作用域隔离
  const legacy = merge.getDefaultState()
  legacy.records.q_legacy = {
    id: 'q_legacy', subject: SUBJECT, chapter: 'c', attempts: 1, right: 1, wrong: 0,
    answerBy: { legacy: { attempts: 1, right: 1, wrong: 0 } }, updatedAt: Date.now() - 1000
  }
  wx.setStorageSync('exam_quiz_data_v1', legacy)
  // 升级后先以游客身份做了一题，随后登录
  store.setUserScope('anon')
  store.recordAnswer(GUEST_Q, true, 100)
  store.flush()
  loginAs('OPENID_UPGRADE')
  return user.login().then(() => {
    assert.deepStrictEqual(Object.keys(store.getRecords()).sort(), ['q_guest', 'q_legacy'],
      '并入游客档案不能把旧版全局档案挡在迁移之外')
    assert.strictEqual(wx.getStorageSync('exam_quiz_data_v1'), '', '旧全局 key 应已清理')
  })
})

test('账号在本机已有档案时不并入游客记录', () => {
  const user = freshUser()
  const store = require('../utils/store.js')
  store.setUserScope('OPENID_OLD')
  store.recordAnswer({ ...GUEST_Q, id: 'q_account' }, true, 100)
  store.flush()
  store.setUserScope('anon')
  store.recordAnswer(GUEST_Q, true, 100)
  store.flush()
  loginAs('OPENID_OLD')
  return user.login().then(() => {
    assert.deepStrictEqual(Object.keys(store.getRecords()), ['q_account'], '账号自己的档案不能被游客数据污染')
    assert.strictEqual(user.takeGuestMergeInfo().adopted, false)
  })
})

test('游客没有可并入的数据时不写入账号作用域', () => {
  const user = freshUser()
  const store = require('../utils/store.js')
  store.setUserScope('anon')
  loginAs('OPENID_EMPTY')
  return user.login().then(() => {
    assert.strictEqual(store.getUserScope(), 'OPENID_EMPTY')
    assert.deepStrictEqual(Object.keys(store.getRecords()), [])
    const snapshot = store.exportLocalSnapshot()
    assert.ok(!snapshot || !Object.keys(snapshot.records || {}).length)
    assert.strictEqual(user.takeGuestMergeInfo().adopted, false)
  })
})

test('并入的游客作答进入待传队列，且不携带匿名清空意图', () => {
  const user = freshUser()
  const store = require('../utils/store.js')
  store.setUserScope('anon')
  store.submitAttempt(GUEST_Q, ['A'], true, 100, 'op-guest-2')
  store.flush()
  loginAs('OPENID_SYNCED')
  return user.login().then(() => {
    assert.strictEqual(store.getAttempts().length, 1)
    store.flush()
    const snapshot = store.exportLocalSnapshot()
    // 未确认的事实必须重新进入 outbox，登录后才会真正上传到账号
    assert.deepStrictEqual(snapshot.attemptOutbox.pending.map((a) => a.id), [snapshot.attempts[0].id])
    // 游客的清空 / 删除意图不能替账号执行
    assert.strictEqual(snapshot.dataEpoch, undefined)
    assert.strictEqual(snapshot.pendingDeleteId, undefined)
    assert.strictEqual(snapshot.aiClearQueue, undefined)
    assert.strictEqual(snapshot.aiEpoch, 0)
  })
})
