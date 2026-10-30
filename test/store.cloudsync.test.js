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
