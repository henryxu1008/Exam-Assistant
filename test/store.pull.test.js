/**
 * store.pullFromCloud 分页拉取测试：验证云端作答流水超过单页上限（100）时，
 * 前端会带 skip 顺序翻页直到 hasMore=false，并最终与本地合并。
 * 通过 mock wx.cloud.callFunction 模拟服务端分页返回。
 */

const test = require('node:test')
const assert = require('node:assert')
const { freshStore } = require('./helpers.js')

const SESSION_KEY = 'exam_quiz_session_v1'

function setupCloud(pages) {
  let calls = 0
  global.wx.__cloudReady = true
  global.wx.cloud = {
    callFunction: (opts) => {
      const p = pages[calls++]
      const res = p || { ok: true, attempts: [], hasMore: false, nextSkip: null }
      const result = Object.assign({ ok: true }, res)
      // store 以 success/fail 回调方式调用（非 .then），mock 需触发 success
      if (opts && typeof opts.success === 'function') opts.success({ result })
      return Promise.resolve({ result })
    }
  }
  return () => calls
}

test('作答流水超一页时分页拉全并合并', async () => {
  const store = freshStore()
  const getCalls = setupCloud([
    { stats: { version: 5 }, attempts: [{ id: 'a1', createdAt: 1 }, { id: 'a2', createdAt: 2 }], hasMore: true, nextSkip: 100 },
    { stats: null, attempts: [{ id: 'a3', createdAt: 3 }], hasMore: false, nextSkip: null }
  ])
  global.wx.setStorageSync(SESSION_KEY, { logged: true, token: 'tok', openid: 'o1' })

  // load() 会触发 pullFromCloud（freshStore 后 bootPulled 初始为 false）
  store.load()

  // 等待分页异步完成（两页 + 可能的回写上传）
  await new Promise((r) => setTimeout(r, 60))

  const ids = store.getAttempts().map((a) => a.id).sort()
  assert.deepStrictEqual(ids, ['a1', 'a2', 'a3'])
  // 至少发起了两次 get（分页），证明翻页发生
  assert.ok(getCalls() >= 2, '应至少分页请求两次')
})

test('无云环境时 pullFromCloud 安全跳过', () => {
  const store = freshStore()
  global.wx.__cloudReady = false
  global.wx.cloud = undefined
  global.wx.setStorageSync(SESSION_KEY, { logged: true, token: 'tok', openid: 'o1' })
  // 不应抛错
  assert.doesNotThrow(() => store.pullFromCloud())
})

test('恢复任一页失败时丢弃整批档案，重试从首页拉全后才落盘', async (t) => {
  global.wx.__cloudReady = false
  const store = freshStore()
  global.wx.setStorageSync(SESSION_KEY, { logged: true, token: 'tok', openid: 'o1' })
  store.setUserScope('o1')
  store.load()
  const before = JSON.parse(JSON.stringify(store.load()))
  const key = 'exam_quiz_data_v1__o1'
  const persistedBefore = global.wx.getStorageSync(key)
  const calls = []
  global.wx.__cloudReady = true
  global.wx.cloud = {
    callFunction(opts) {
      calls.push(opts)
      return Promise.resolve()
    }
  }
  t.after(() => {
    store.__clearFlushTimer()
    global.wx.__cloudReady = false
    global.wx.cloud = undefined
  })
  const results = []
  const resolve = (index, result) => calls[index].success({ result })
  const session = {
    id: 'cloud-session', questionIds: ['q1', 'q2'], submitted: { q1: 'a1', q2: 'a2' },
    updatedAt: Date.now(), status: 'completed'
  }
  const page = {
    ok: true, stats: { version: 5, practiceSession: session },
    attempts: [{ id: 'a1', questionId: 'q1', selected: ['A'], createdAt: 1 }],
    hasMore: true, nextSkip: 100
  }

  // 首页失败：不接受服务器可能夹带的局部档案，也不能锁死启动拉取。
  store.pullFromCloud((ok) => results.push(ok))
  resolve(0, { ok: false, error: 'READ_ATTEMPTS_FAILED', stats: page.stats })
  assert.deepStrictEqual(store.load(), before)
  assert.deepStrictEqual(results, [false])

  // 第二页失败：已缓存在本次拉取内的首页也不能被合并、持久化或回传。
  store.pullFromCloud((ok) => results.push(ok))
  assert.strictEqual(calls[1].data.skip, 0)
  resolve(1, page)
  assert.strictEqual(calls[2].data.skip, 100)
  resolve(2, { ok: false, error: 'READ_ATTEMPTS_FAILED' })
  assert.deepStrictEqual(results, [false, false])
  assert.deepStrictEqual(store.load(), before)
  assert.deepStrictEqual(global.wx.getStorageSync(key), persistedBefore)
  assert.strictEqual(calls.filter((c) => c.data.action === 'update').length, 0)

  store.pullFromCloud((ok) => results.push(ok))
  assert.strictEqual(calls[3].data.skip, 0, '失败后的整批重试必须从首页开始')
  resolve(3, page)
  resolve(4, {
    ok: true, stats: page.stats,
    attempts: [{ id: 'a2', questionId: 'q2', selected: ['B'], createdAt: 2 }],
    hasMore: false, nextSkip: null
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepStrictEqual(results, [false, false, true])
  assert.deepStrictEqual(store.getAttempts().map((a) => a.id).sort(), ['a1', 'a2'])
  assert.deepStrictEqual(store.getAttempts().map((a) => a.selected), [['A'], ['B']])
  assert.strictEqual(store.getPracticeSession().id, session.id)
  assert.strictEqual(global.wx.getStorageSync(key).attempts.length, 2)
  const getCount = calls.filter((c) => c.data.action === 'get').length
  store.pullFromCloud()
  assert.strictEqual(calls.filter((c) => c.data.action === 'get').length, getCount)
})
