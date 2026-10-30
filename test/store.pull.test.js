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
