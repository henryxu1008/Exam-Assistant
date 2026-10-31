/**
 * 云端同步一致性回归测试（PR #10 评审发现）
 *
 * 覆盖四条 P1：
 *  1) attempts 必须作为顶层字段发送，且仅在应用层 ok:true 时推进光标；
 *  2) 作用域与会话身份不一致时禁止上传，避免匿名态空档案覆盖账号备份；
 *  3) 拉取发起后账号若已切换 / 登出，回包（含每个分页）一律丢弃；
 *  4) 题库种子上传需要登录令牌（云端鉴权）。
 * 以及一条 P2：
 *  5) 云端合并结果必须真正落盘（flush 依赖 dirty 标记）。
 */

const test = require('node:test')
const assert = require('node:assert')
const { freshStore, q } = require('./helpers.js')

const SESSION_KEY = 'exam_quiz_session_v1'
const DATA_KEY = 'exam_quiz_data_v1'
const SEED_FLAG_KEY = 'exam_quiz_bank_seeded_v1'

/** 立即回包：success 同步触发，result 由 handler 决定 */
function mockCloud(handler) {
  const calls = []
  global.wx.__cloudReady = true
  global.wx.cloud = {
    callFunction: (opts) => {
      calls.push(opts)
      const result = handler ? handler(opts, calls.length - 1) : { ok: true }
      // store 以 success/fail 回调方式调用（非 .then），mock 需触发 success
      if (opts && typeof opts.success === 'function') opts.success({ result })
      return Promise.resolve({ result })
    }
  }
  return calls
}

/**
 * 延迟回包：只记录调用，不自动触发 success。
 * 用于模拟「请求在途期间账号发生切换」——等切换完成后再手动放回包。
 */
function mockDeferred() {
  const calls = []
  global.wx.__cloudReady = true
  global.wx.cloud = {
    callFunction: (opts) => {
      calls.push(opts)
      return new Promise(() => {}) // 永不 settle，store 只消费 success/fail 回调
    }
  }
  return {
    calls: calls,
    /** 触发第 index 次调用的 success 回包 */
    resolve(index, result) {
      const opts = calls[index]
      if (opts && typeof opts.success === 'function') opts.success({ result })
    }
  }
}

function tick(ms) {
  return new Promise((r) => setTimeout(r, ms || 30))
}

function login(openid, token) {
  global.wx.setStorageSync(SESSION_KEY, { logged: true, token: token, openid: openid })
}

/**
 * 取一个全新的 user 模块实例。
 * 必须在 freshStore() 之后调用：freshStore 已清空 store 的 require 缓存，
 * 这里再清掉 user 的缓存后重新 require，user 内部 require('./store.js')
 * 会拿到与 freshStore() 返回的同一个实例，两者作用域状态才是联动的。
 */
function freshUser() {
  delete require.cache[require.resolve('../utils/user.js')]
  return require('../utils/user.js')
}

/* ------------------------------------------------------------------ *
 * 1) attempts 顶层字段 + 光标推进条件
 * ------------------------------------------------------------------ */

test('上传时 attempts 作为顶层字段发送，而非塞进 stats', async () => {
  freshStore()
  const calls = mockCloud(() => ({ ok: true }))
  login('o1', 'tok')

  const store = require('../utils/store.js')
  store.setUserScope('o1')
  store.load()
  store.submitAttempt(q('x1'), ['A'], true, 100, 'op-1')

  store.flush()
  await tick() // 云端写操作在队列中执行

  const update = calls.filter((c) => c.data && c.data.action === 'update').pop()
  assert.ok(update, '应发起一次 update')
  assert.ok(Array.isArray(update.data.attempts), 'attempts 必须是顶层数组')
  assert.strictEqual(update.data.attempts.length, 1)
  assert.strictEqual(update.data.attempts[0].questionId, 'x1')
  // stats 内不应再携带 attempts（云函数白名单会把它丢掉）
  assert.strictEqual(update.data.stats.attempts, undefined)
})

test('云函数返回 ok:false 时不推进上传光标', async () => {
  freshStore()
  let failNext = true
  const calls = mockCloud(() => (failNext ? { ok: false, error: 'BOOM' } : { ok: true }))
  login('o1', 'tok')

  const store = require('../utils/store.js')
  store.setUserScope('o1')
  store.load()
  store.submitAttempt(q('x1'), ['A'], true, 100, 'op-1')

  // 第一次上传应用层失败 -> 光标不动
  store.flush()
  await tick()
  // 第二次成功 -> 应把之前那条一起补传
  failNext = false
  store.saveSettings({}) // 重新标记脏，触发下一次 flush
  store.flush()
  await tick()

  const updates = calls.filter((c) => c.data && c.data.action === 'update')
  assert.strictEqual(updates.length, 2)
  assert.strictEqual(updates[0].data.attempts.length, 1, '首次尝试应带上未同步的作答')
  assert.strictEqual(
    updates[1].data.attempts.length,
    1,
    '失败后重试必须补传同一条，说明光标未被错误推进'
  )
  assert.strictEqual(updates[1].data.attempts[0].questionId, 'x1')
})

test('上传成功后光标推进，后续只增量上传新增作答', async () => {
  freshStore()
  const calls = mockCloud(() => ({ ok: true }))
  login('o1', 'tok')

  const store = require('../utils/store.js')
  store.setUserScope('o1')
  store.load()
  store.submitAttempt(q('x1'), ['A'], true, 100, 'op-1')
  store.flush()
  await tick()

  store.submitAttempt(q('x2'), ['A'], false, 100, 'op-2')
  store.flush()
  await tick()

  const updates = calls.filter((c) => c.data && c.data.action === 'update')
  assert.strictEqual(updates.length, 2)
  assert.strictEqual(updates[0].data.attempts.length, 1)
  assert.strictEqual(updates[1].data.attempts.length, 1, '第二条只需增量上传新增部分')
  assert.strictEqual(updates[1].data.attempts[0].questionId, 'x2')
})

/* ------------------------------------------------------------------ *
 * 2) 作用域 / 会话身份校验
 * ------------------------------------------------------------------ */

test('anon 作用域下不上传学习档案（防止空档案覆盖账号备份）', () => {
  freshStore()
  const calls = mockCloud(() => ({ ok: true }))
  // 会话是已登录账号 o1，但 store 仍停留在 anon 作用域（未先绑定就 load 的场景）
  login('o1', 'tok')

  const store = require('../utils/store.js')
  store.load()
  store.recordAnswer(q('x1'), true, 100)
  store.flush()

  const updates = calls.filter((c) => c.data && c.data.action === 'update')
  assert.strictEqual(updates.length, 0, '作用域与会话身份不一致时必须拒绝上传')
})

test('绑定到账号作用域后可正常上传', async () => {
  freshStore()
  const calls = mockCloud(() => ({ ok: true }))
  login('o1', 'tok')

  const store = require('../utils/store.js')
  store.setUserScope('o1')
  store.load()
  store.recordAnswer(q('x1'), true, 100)
  store.flush()
  await tick()

  const updates = calls.filter((c) => c.data && c.data.action === 'update')
  assert.strictEqual(updates.length, 1, '作用域匹配后应允许上传')
})

test('切换到另一个账号后，旧账号数据不会以新账号身份上传', () => {
  freshStore()
  const calls = mockCloud(() => ({ ok: true }))
  login('o1', 'tokA')

  const store = require('../utils/store.js')
  store.setUserScope('o1')
  store.load()
  store.recordAnswer(q('x1'), true, 100)

  // 会话已切到 B，但 store 作用域还停在 A（本次 flush 携带的是 A 的数据）
  login('o2', 'tokB')
  store.flush()

  const updates = calls.filter((c) => c.data && c.data.action === 'update')
  assert.strictEqual(updates.length, 0, 'A 的数据不得以 B 的令牌上传')
})

test('登出后（会话清空）不再上传', () => {
  freshStore()
  const calls = mockCloud(() => ({ ok: true }))
  login('o1', 'tok')

  const store = require('../utils/store.js')
  store.setUserScope('o1')
  store.load()
  store.recordAnswer(q('x1'), true, 100)

  global.wx.setStorageSync(SESSION_KEY, { logged: false, token: '', openid: '' })
  store.flush()

  const updates = calls.filter((c) => c.data && c.data.action === 'update')
  assert.strictEqual(updates.length, 0, '会话已清空时不应上传')
})

/* ------------------------------------------------------------------ *
 * 2b) 启动期作用域绑定（user.bindStoredScope）
 * ------------------------------------------------------------------ */

test('bindStoredScope：有登录缓存时绑定到该账号作用域', () => {
  const store = freshStore()
  const user = freshUser()
  login('o1', 'tok')

  assert.strictEqual(user.bindStoredScope(), 'o1')
  assert.strictEqual(store.getUserScope(), 'o1')
})

test('bindStoredScope：无登录缓存时保持匿名作用域', () => {
  const store = freshStore()
  const user = freshUser()
  global.wx.setStorageSync(SESSION_KEY, { logged: false, token: '', openid: '' })

  assert.strictEqual(user.bindStoredScope(), 'anon')
  assert.strictEqual(store.getUserScope(), 'anon')
})

test('bindStoredScope：登录标记存在但无 openid 时回落匿名', () => {
  const store = freshStore()
  const user = freshUser()
  global.wx.setStorageSync(SESSION_KEY, { logged: true, token: 'tok', openid: '' })

  assert.strictEqual(user.bindStoredScope(), 'anon')
  assert.strictEqual(store.getUserScope(), 'anon')
})

test('bindStoredScope：重复绑定同一账号不重置内存态（不丢数据）', () => {
  const store = freshStore()
  const user = freshUser()
  login('o1', 'tok')

  user.bindStoredScope()
  store.load()
  store.recordAnswer(q('x1'), true, 100)

  user.bindStoredScope() // 再次绑定：不应清空
  assert.strictEqual(store.getUserScope(), 'o1')
  assert.ok(store.getRecord('x1'), '重复绑定同一作用域不应重置内存态')
})

test('冷启动先绑定作用域再 load：数据落在账号命名空间且可上传', async () => {
  const store = freshStore()
  const user = freshUser()
  const calls = mockCloud(() => ({ ok: true }))
  login('o1', 'tok')

  user.bindStoredScope()
  store.load()
  store.recordAnswer(q('x1'), true, 100)
  store.flush()
  await tick()

  const updates = calls.filter((c) => c.data && c.data.action === 'update')
  assert.strictEqual(updates.length, 1, '绑定后应允许上传')
  assert.strictEqual(updates[0].data.token, 'tok')
  assert.ok(
    global.wx.getStorageSync(`${DATA_KEY}__o1`),
    '数据应落在账号作用域 key，而非 anon'
  )
})

/* ------------------------------------------------------------------ *
 * 3) 在途拉取的回包丢弃
 * ------------------------------------------------------------------ */

test('在途拉取回包到达时账号已切换则丢弃，不并入当前内存态', async () => {
  freshStore()
  const cloud = mockDeferred()
  login('o1', 'tokA')

  const store = require('../utils/store.js')
  store.setUserScope('o1')
  store.load() // 触发在途拉取（第 0 次调用），此时尚未回包

  // 拉取在途时切到账号 B：作用域与令牌都变了
  login('o2', 'tokB')
  store.setUserScope('o2')
  store.load()

  // 旧的 A 拉取此时才返回
  cloud.resolve(0, {
    ok: true,
    stats: { version: 3, records: { 'from-A': { id: 'from-A', lastAt: 1 } } },
    attempts: [{ id: 'a-from-A' }],
    hasMore: false,
    nextSkip: null
  })
  await tick()

  assert.deepStrictEqual(
    store.getAttempts().map((a) => a.id),
    [],
    'A 的在途回包不得并入 B 的内存态'
  )
  assert.strictEqual(store.getRecord('from-A'), null, 'A 的答题记录不得并入 B')
})

test('在途拉取回包到达时已登出则丢弃', async () => {
  freshStore()
  const cloud = mockDeferred()
  login('o1', 'tokA')

  const store = require('../utils/store.js')
  store.setUserScope('o1')
  store.load() // 在途拉取

  global.wx.setStorageSync(SESSION_KEY, { logged: false, token: '', openid: '' })
  cloud.resolve(0, {
    ok: true,
    stats: null,
    attempts: [{ id: 'a-old' }],
    hasMore: false,
    nextSkip: null
  })
  await tick()

  assert.deepStrictEqual(store.getAttempts().map((a) => a.id), [], '登出后旧回包必须丢弃')
})

test('clearAll 后，在途拉取的回包不会把已清空的数据并回来', async () => {
  const store = freshStore()
  const cloud = mockDeferred()
  login('o1', 'tok')

  store.setUserScope('o1')
  store.load() // 发起在途拉取（第 0 次调用）

  store.clearAll() // 递增同步代次，作废在途请求
  cloud.resolve(0, {
    ok: true,
    stats: { version: 3, records: { ghost: { id: 'ghost', lastAt: 1 } } },
    attempts: [{ id: 'a-ghost' }],
    hasMore: false,
    nextSkip: null
  })
  await tick()

  assert.deepStrictEqual(store.getRecords(), {}, '清空后到达的回包必须丢弃')
  assert.deepStrictEqual(store.getAttempts(), [])
})

test('分页拉取全程复用发起时的令牌快照', async () => {
  freshStore()
  const cloud = mockDeferred()
  login('o1', 'tokA')

  const store = require('../utils/store.js')
  store.setUserScope('o1')
  store.load() // 第 0 次调用：第 1 页

  cloud.resolve(0, {
    ok: true,
    stats: null,
    attempts: [{ id: 'a1' }],
    hasMore: true,
    nextSkip: 1
  })
  await tick()

  // 第 1 页回来后账号切到 B，第 2 页请求不应携带 B 的令牌
  login('o2', 'tokB')
  store.setUserScope('o2')
  await tick()

  const second = cloud.calls[1]
  assert.ok(second, '应发起第 2 页请求')
  assert.strictEqual(second.data.token, 'tokA', '分页必须复用发起时的令牌快照')
})

/* ------------------------------------------------------------------ *
 * 3b) 上传确认必须落回发起时的作用域（评审 P1 4422245827）
 * ------------------------------------------------------------------ */

test('A 的上传确认不会推进 B 的光标（否则 B 的首条作答被永久跳过）', async () => {
  const store = freshStore()
  let pendingUpdate = null
  global.wx.__cloudReady = true
  global.wx.cloud = {
    callFunction: (opts) => {
      const isUpdate = opts.data && opts.data.action === 'update'
      if (isUpdate) {
        // 只记录调用、不自动回调，模拟「上传在途」；稍后手动触发其 success
        pendingUpdate = opts
        return new Promise(() => {})
      }
      const result = { ok: true, attempts: [], hasMore: false, nextSkip: null }
      if (opts && opts.success) opts.success({ result })
      return Promise.resolve({ result: { ok: true } })
    }
  }
  login('o1', 'tokA')

  store.setUserScope('o1')
  store.load()
  store.submitAttempt(q('x1'), ['A'], true, 100, 'op-1')
  store.flush() // 发起 A 的上传，尚未确认
  await tick() // 让排队的写请求真正发出（此时才捕获到 pendingUpdate）

  // 上传在途时切到账号 B
  login('o2', 'tokB')
  store.setUserScope('o2')
  store.load()

  assert.ok(pendingUpdate, '应捕获到 A 的在途上传')

  // A 的上传此刻才确认：手动触发它发起时绑定的 success 回调
  pendingUpdate.success({ result: { ok: true } })
  await tick()

  // B 的第一条作答必须仍被上传：若光标被 A 的确认污染，这里会是空数组
  const calls = []
  global.wx.cloud = {
    callFunction: (opts) => {
      calls.push(opts)
      if (opts && opts.success) opts.success({ result: { ok: true } })
      return Promise.resolve({ result: { ok: true } })
    }
  }
  store.submitAttempt(q('y1'), ['A'], false, 100, 'op-2')
  store.flush()
  await tick()

  const update = calls.filter((c) => c.data && c.data.action === 'update').pop()
  assert.ok(update, '应发起一次上传')
  assert.ok(
    (update.data.attempts || []).some((a) => a.questionId === 'y1'),
    'B 的首条作答不得被 A 的过期确认跳过'
  )
})

/* ------------------------------------------------------------------ *
 * 3c) 云端写操作串行：删除必须排在在途上传之后（评审 P1 4422339092）
 * ------------------------------------------------------------------ */

test('清空时若已有上传在途，删除请求仍排在其后发出', async () => {
  const store = freshStore()
  const actions = [] // 记录「请求发出」顺序
  const pending = []

  global.wx.__cloudReady = true
  global.wx.cloud = {
    callFunction: (opts) => {
      const action = opts.data && opts.data.action
      if (action === 'update') {
        actions.push('update') // 发出上传，回包挂起
        pending.push(opts)
        return new Promise(() => {})
      }
      actions.push(action)
      if (opts && opts.success) opts.success({ result: { ok: true } })
      return Promise.resolve({ result: { ok: true } })
    }
  }

  login('o1', 'tok')
  store.setUserScope('o1')
  store.load()

  // 1) 发起一次上传并让其停留在在途状态（未回包）
  store.recordAnswer(q('x1'), true, 100)
  store.flush()
  await tick()
  assert.deepEqual(actions, ['get', 'update'], '上传应已发出但尚未回包')

  // 2) 在途期间清空：删除请求必须排在上传之后
  store.clearAll()
  await tick()
  assert.deepEqual(actions, ['get', 'update'], '删除不得趁上传在途抢先发出')

  // 3) 上传回包到达后，删除才发出（其后是清空后那次空档案上传）
  pending.forEach((opts) => opts.success({ result: { ok: true } }))
  await tick()

  const firstUpdate = actions.indexOf('update')
  const del = actions.indexOf('delete')
  assert.ok(del > firstUpdate, '删除必须排在在途上传之后，否则刚清空的数据会被写回')
  assert.strictEqual(
    actions[actions.length - 1],
    'update',
    '清空后的空档案上传应排在删除之后'
  )
})

/* ------------------------------------------------------------------ *
 * 3d) 待重试的云端删除：失败保留意图，恢复后先补发再放行上传
 *     （评审 P2 4425593448）
 * ------------------------------------------------------------------ */

test('清空时删除失败会保留意图，恢复后先补发删除再上传', async () => {
  const store = freshStore()
  let failDelete = true
  const calls = []

  global.wx.__cloudReady = true
  global.wx.cloud = {
    callFunction: (opts) => {
      calls.push(opts)
      const action = opts.data && opts.data.action
      if (action === 'delete' && failDelete) {
        if (opts.fail) opts.fail(new Error('offline'))
        return Promise.reject(new Error('offline'))
      }
      if (opts.success) opts.success({ result: { ok: true, attempts: [], hasMore: false } })
      return Promise.resolve({ result: { ok: true } })
    }
  }

  login('o1', 'tok')
  store.setUserScope('o1')
  store.load()
  await tick()

  // 离线清空：删除请求失败，但意图必须保留，不得静默丢弃
  store.clearAll()
  await tick()

  assert.equal(
    calls.filter((c) => c.data && c.data.action === 'delete').length,
    1,
    '离线清空应发起删除'
  )
  // 删除未确认前不得上传：update 是合并而非整doc覆盖，
  // 空快照删不掉服务端已有数据，此时上传等于把刚清空的内容又并回去
  assert.equal(
    calls.filter((c) => c.data && c.data.action === 'update').length,
    0,
    '删除未确认前不得上传'
  )

  // 恢复网络后再落盘：补发的删除成功后放行上传
  failDelete = false
  store.recordAnswer(q('z1'), true, 100)
  store.flush()
  await tick()
  await tick()

  const actions = calls.map((c) => c.data && c.data.action)
  assert.equal(
    actions.filter((a) => a === 'delete').length,
    2,
    '恢复后应重试删除'
  )
  assert.ok(
    actions.lastIndexOf('delete') < actions.indexOf('update'),
    '上传必须排在删除确认之后'
  )
})

/* ------------------------------------------------------------------ *
 * 3e) 过期回包被丢弃后要重新武装启动拉取（评审 P2 4425593460）
 * ------------------------------------------------------------------ */

test('同账号内换令牌导致拉取回包被丢弃后，仍能再次恢复云端数据', async () => {
  const store = freshStore()
  const deferred = mockDeferred()

  login('o1', 'tokA')
  store.setUserScope('o1')
  store.load() // 冷启动：拉取已发起，回包在途
  assert.equal(deferred.calls.length, 1, '冷启动应发起一次拉取')

  // 同账号内刷新令牌（ensureFreshToken 的典型情形）：作用域没变，但令牌变了
  login('o1', 'tokB')

  // 在途回包此刻到达：上下文已变，必须丢弃
  deferred.resolve(0, {
    ok: true,
    stats: { records: { q1: { id: 'q1', lastAt: 1 } } },
    attempts: [],
    hasMore: false
  })
  await tick()

  assert.equal(store.getRecords().q1, undefined, '过期回包不得写入本地')

  // 关键：重新武装之后，显式拉取必须还能把该账号的云端数据恢复回来。
  // 若 bootPulled 停在 true，本次启动剩下的时间里就再也拉不回来了。
  store.pullFromCloud()
  await tick()
  assert.equal(
    deferred.calls.filter((c) => c.data && c.data.action === 'get').length,
    2,
    '过期丢弃后必须能再次发起拉取'
  )

  deferred.resolve(1, {
    ok: true,
    stats: { records: { q1: { id: 'q1', lastAt: 1 } } },
    attempts: [],
    hasMore: false
  })
  await tick()
  await tick()

  assert.ok(store.getRecords().q1, '重新武装后必须能再次恢复云端数据')
})

/* ------------------------------------------------------------------ *
 * 3f) 删除的账号上下文必须在「入队时」捕获（评审 P1 4425820628）
 * ------------------------------------------------------------------ */

test('清空入队后切换账号，删除仍绑定发起时的账号', async () => {
  const store = freshStore()
  const calls = []
  const pending = []

  global.wx.__cloudReady = true
  global.wx.cloud = {
    callFunction: (opts) => {
      calls.push(opts)
      const action = opts.data && opts.data.action
      // 让上传停留在在途状态，制造「删除排在它之后」的窗口
      if (action === 'update') {
        pending.push(opts)
        return new Promise(() => {})
      }
      if (opts && opts.success) opts.success({ result: { ok: true, attempts: [], hasMore: false } })
      return Promise.resolve({ result: { ok: true } })
    }
  }

  login('oA', 'tokA')
  store.setUserScope('oA')
  store.load()
  await tick()

  // 1) A 发起一次上传并让它停留在在途状态
  store.recordAnswer(q('a1'), true, 100)
  store.flush()
  await tick()
  assert.equal(pending.length, 1, '应有一次上传在途')

  // 2) 上传在途期间 A 清空：删除入队，排在该上传之后
  store.clearAll()
  await tick()
  assert.equal(
    calls.filter((c) => c.data && c.data.action === 'delete').length,
    0,
    '删除不得趁上传在途抢先发出'
  )

  // 3) 删除尚未排到，此时切到 B 账号
  store.setUserScope('oB')
  login('oB', 'tokB')

  // 4) 上传回包到达，删除随后执行：
  //    必须拿着发起时的 A 令牌，否则会删掉 B 的云端数据
  pending.forEach((opts) => opts.success({ result: { ok: true } }))
  await tick()

  const deletes = calls.filter((c) => c.data && c.data.action === 'delete')
  assert.equal(deletes.length, 1, '应发出一次删除')
  assert.strictEqual(
    deletes[0].data.token,
    'tokA',
    '删除必须绑定发起时的 A 令牌，否则会删掉 B 的云端数据'
  )
})

/* ------------------------------------------------------------------ *
 * 3g) 上传失败必须保留待重试状态（评审 P2 4425946077）
 * ------------------------------------------------------------------ */

test('上传失败后，无需新的本地变更也会再次重试上传', async () => {
  const store = freshStore()
  let failUpload = true
  const calls = []

  global.wx.__cloudReady = true
  global.wx.cloud = {
    callFunction: (opts) => {
      calls.push(opts)
      const action = opts.data && opts.data.action
      if (action === 'update' && failUpload) {
        if (opts.fail) opts.fail(new Error('offline'))
        return Promise.reject(new Error('offline'))
      }
      if (opts.success) opts.success({ result: { ok: true, attempts: [], hasMore: false } })
      return Promise.resolve({ result: { ok: true } })
    }
  }

  login('o1', 'tok')
  store.setUserScope('o1')
  store.load()
  await tick()

  // 离线作答：上传失败
  store.recordAnswer(q('a1'), true, 100)
  store.flush()
  await tick()

  assert.equal(
    calls.filter((c) => c.data && c.data.action === 'update').length,
    1,
    '应发起一次上传'
  )

  // 恢复网络后再次 flush（模拟进入后台强制落盘）：
  // flush 首次已清掉 dirty，不保留重试状态的话这里不会再上传
  failUpload = false
  store.flush()
  await tick()
  await tick()

  assert.ok(
    calls.filter((c) => c.data && c.data.action === 'update').length >= 2,
    '上传失败后再次 flush 必须重试'
  )
})

/* ------------------------------------------------------------------ *
 * 3h) 拉取恢复会话后要推进会话版本号（评审 P2 4425946095）
 * ------------------------------------------------------------------ */

test('拉取恢复会话后推进会话版本号，使已缓存的 AI 页重载', async () => {
  const store = freshStore()
  const deferred = mockDeferred()

  login('o1', 'tok')
  store.setUserScope('o1')
  store.load()
  const before = store.getAiConversationVersion()

  deferred.resolve(0, {
    ok: true,
    stats: {
      aiMessages: [{ time: 1, role: 'user', text: '云端历史' }],
      aiEpoch: 0
    },
    attempts: [],
    hasMore: false
  })
  await tick()

  assert.ok(store.getAiMessages().length > 0, '会话应已从云端恢复')
  assert.ok(
    store.getAiConversationVersion() > before,
    '会话被恢复时必须推进版本号，否则已缓存的 AI 页不会重载历史'
  )
})

/* ------------------------------------------------------------------ *
 * 4) 题库种子上传需要登录身份
 * ------------------------------------------------------------------ */

test('未登录时跳过题库种子上传（不发起 set）', async () => {
  freshStore()
  const calls = mockCloud(() => ({ ok: true, bank: null }))
  global.wx.setStorageSync(SESSION_KEY, { logged: false, token: '', openid: '' })

  const bank = require('../utils/bank/index.js')
  const ok = await bank.pushStaticBankToCloud()

  assert.strictEqual(ok, false)
  const sets = calls.filter((c) => c.data && c.data.action === 'set')
  assert.strictEqual(sets.length, 0, '无令牌时不应发起写入')
})

test('已登录且云端为空时携带令牌种入题库', async () => {
  freshStore()
  let existing = null
  const calls = mockCloud((opts) => {
    const data = (opts && opts.data) || {}
    if (data.action === 'get') return { ok: true, bank: existing }
    if (data.action === 'set') {
      if (!data.token) return { ok: false, error: 'NO_TOKEN' }
      existing = data.bank
      return { ok: true }
    }
    return { ok: false, error: 'BAD_ACTION' }
  })
  login('o1', 'tok')

  const bank = require('../utils/bank/index.js')
  const ok = await bank.pushStaticBankToCloud()

  assert.strictEqual(ok, true, '应成功种入')
  const sets = calls.filter((c) => c.data && c.data.action === 'set')
  assert.strictEqual(sets.length, 1)
  assert.strictEqual(sets[0].data.token, 'tok', 'set 必须携带令牌')
  assert.strictEqual(global.wx.getStorageSync(SEED_FLAG_KEY), 1)
})

/* ------------------------------------------------------------------ *
 * 5) 合并结果必须落盘
 * ------------------------------------------------------------------ */

test('云端合并结果会写入本地存储（而非只留在内存）', async () => {
  freshStore()
  mockCloud(() => ({
    ok: true,
    stats: { version: 3, records: { 'merged-q': { id: 'merged-q', lastAt: 999 } } },
    attempts: [{ id: 'a-cloud' }],
    hasMore: false,
    nextSkip: null
  }))
  login('o1', 'tok')

  const store = require('../utils/store.js')
  store.setUserScope('o1')
  store.load() // load 内部触发一次拉取并合并
  await tick()

  assert.ok(store.getRecord('merged-q'), '内存态应含云端记录')
  const persisted = global.wx.getStorageSync(`${DATA_KEY}__o1`)
  assert.ok(persisted, '应已落盘到账号作用域 key')
  assert.ok(persisted.records['merged-q'], '合并结果必须持久化，否则离线重开即丢失')
  assert.deepStrictEqual(persisted.attempts.map((a) => a.id), ['a-cloud'])
})
