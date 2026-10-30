/**
 * bankSync 云函数写权限回归测试（PR #10 评审发现 P1）
 *
 * 题库是全体用户共享的内容，原实现任何人都能直接调用 set 覆盖它，
 * 从而篡改所有用户看到的题目与答案。这里锁定两件事：
 *  - 写入必须持有有效且未过期的登录令牌；
 *  - 题库一旦建立，普通调用不得覆盖；只有管理员显式 force 才可以。
 */

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const NOW = new Date('2026-10-30T06:00:00Z').getTime()
const DAY = 86400000
const clone = (value) => JSON.parse(JSON.stringify(value))

const USER_TOKEN = 'user-token'
const ADMIN_TOKEN = 'admin-token'
const ADMIN_OPENID = 'admin-openid'

function harness({ admins = [] } = {}) {
  const collections = {
    questions: new Map(),
    users: new Map([
      ['u1', { _id: 'u1', openid: 'normal-openid', token: USER_TOKEN, tokenAt: NOW }],
      ['u2', { _id: 'u2', openid: ADMIN_OPENID, token: ADMIN_TOKEN, tokenAt: NOW }],
      ['u3', { _id: 'u3', openid: 'stale-openid', token: 'stale-token', tokenAt: NOW - 31 * DAY }]
    ]),
    appConfig: admins.length ? new Map([['admins', { _id: 'admins', openids: admins }]]) : new Map()
  }

  function matching(name, filter) {
    return Array.from(collections[name].values()).filter((row) =>
      Object.keys(filter).every((key) => row[key] === filter[key])
    )
  }

  function collection(name) {
    return {
      doc(id) {
        return {
          async get() {
            const store = collections[name]
            if (!store.has(id)) throw new Error('document does not exist')
            return { data: clone(store.get(id)) }
          },
          async set({ data }) {
            collections[name].set(id, clone(data))
            return { stats: { updated: 1 } }
          }
        }
      },
      where(filter) {
        let limit = Infinity
        return {
          limit(count) {
            limit = count
            return this
          },
          async get() {
            return { data: matching(name, filter).slice(0, limit).map(clone) }
          }
        }
      }
    }
  }

  const db = { collection: collection }

  // 事务：串行执行以模拟可串行化隔离——后到的事务会看到先到事务的写入
  let queue = Promise.resolve()
  let attempts = 0
  db.runTransaction = (fn) => {
    attempts += 1
    const run = queue.then(() => fn({ collection: collection }))
    queue = run.then(
      () => {},
      () => {}
    )
    return run
  }

  class FixedDate extends Date {
    static now() {
      return NOW
    }
  }

  const source = fs.readFileSync(path.join(__dirname, '../cloudfunctions/bankSync/index.js'), 'utf8')
  const exports = {}
  vm.runInNewContext(source, {
    exports,
    Date: FixedDate,
    process: { env: {} },
    require(module) {
      if (module === 'wx-server-sdk') return { init() {}, database: () => db }
      throw new Error(`unexpected module ${module}`)
    }
  })

  return { main: exports.main, txAttempts: () => attempts }
}

const BANK = { manifest: { subjects: [{ key: 'gk', name: '公基' }] }, questions: { gk: [] } }

/* ------------------------------------------------------------------ *
 * 读取：公开内容，不需要身份
 * ------------------------------------------------------------------ */

test('get 不需要令牌即可读取题库', async () => {
  const h = harness()
  const r = await h.main({ action: 'get' })
  assert.equal(r.ok, true)
  assert.equal(r.bank, null)
})

/* ------------------------------------------------------------------ *
 * 写入：令牌校验
 * ------------------------------------------------------------------ */

test('无令牌调用 set 被拒绝', async () => {
  const h = harness()
  const r = await h.main({ action: 'set', bank: BANK })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'NO_TOKEN')
})

test('无效令牌调用 set 被拒绝', async () => {
  const h = harness()
  const r = await h.main({ action: 'set', token: 'not-a-real-token', bank: BANK })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'INVALID_TOKEN')
})

test('过期令牌调用 set 被拒绝', async () => {
  const h = harness()
  const r = await h.main({ action: 'set', token: 'stale-token', bank: BANK })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'INVALID_TOKEN')
})

test('非法题库结构被拒绝，且不落库', async () => {
  const h = harness()
  const r = await h.main({ action: 'set', token: USER_TOKEN, bank: { questions: {} } })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'BAD_BANK')
  assert.equal((await h.main({ action: 'get' })).bank, null)
})

/* ------------------------------------------------------------------ *
 * 一次性初始化语义
 * ------------------------------------------------------------------ */

test('云端为空时已登录用户可完成一次性初始化', async () => {
  const h = harness()
  const r = await h.main({ action: 'set', token: USER_TOKEN, bank: BANK })
  assert.equal(r.ok, true)

  const got = await h.main({ action: 'get' })
  assert.equal(got.ok, true)
  assert.deepEqual(got.bank.questions, BANK.questions)
  assert.equal(got.bank.updatedBy, 'normal-openid')
})

test('题库已存在时普通调用无法覆盖，返回 BANK_EXISTS', async () => {
  const h = harness()
  await h.main({ action: 'set', token: USER_TOKEN, bank: BANK })

  const evil = {
    manifest: { subjects: [{ key: 'gk', name: '被篡改' }] },
    questions: { gk: [{ id: 'fake', answer: ['A'] }] }
  }
  const r = await h.main({ action: 'set', token: USER_TOKEN, bank: evil })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'BANK_EXISTS')

  // 原有内容未被改写
  const got = await h.main({ action: 'get' })
  assert.deepEqual(got.bank.questions, BANK.questions)
  assert.equal(got.bank.updatedBy, 'normal-openid')
})

test('并发首次初始化只有一个成功，另一个收到 BANK_EXISTS', async () => {
  const h = harness()
  const results = await Promise.all([
    h.main({ action: 'set', token: USER_TOKEN, bank: BANK }),
    h.main({ action: 'set', token: ADMIN_TOKEN, bank: BANK })
  ])
  const oks = results.filter((r) => r.ok).length
  const exists = results.filter((r) => r.error === 'BANK_EXISTS').length
  assert.equal(oks, 1, '只允许一个初始化成功')
  assert.equal(exists, 1, '另一个必须被拒绝')
})

/* ------------------------------------------------------------------ *
 * 管理员强制覆盖
 * ------------------------------------------------------------------ */

test('非管理员即使 force 也无法覆盖已有题库', async () => {
  const h = harness({ admins: [ADMIN_OPENID] })
  await h.main({ action: 'set', token: USER_TOKEN, bank: BANK })

  const r = await h.main({
    action: 'set',
    token: USER_TOKEN,
    force: true,
    bank: { manifest: { subjects: [] }, questions: { hacked: [] } }
  })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'NOT_ADMIN')
  const got = await h.main({ action: 'get' })
  assert.deepEqual(got.bank.questions, BANK.questions)
})

test('管理员可显式 force 覆盖已有题库', async () => {
  const h = harness({ admins: [ADMIN_OPENID] })
  await h.main({ action: 'set', token: USER_TOKEN, bank: BANK })

  const next = { manifest: { subjects: [] }, questions: { v2: [] } }
  const r = await h.main({ action: 'set', token: ADMIN_TOKEN, force: true, bank: next })
  assert.equal(r.ok, true)

  const got = await h.main({ action: 'get' })
  assert.deepEqual(got.bank.questions, { v2: [] })
  assert.equal(got.bank.updatedBy, ADMIN_OPENID)
})

test('未配置管理员名单时，任何人都无法覆盖已有题库', async () => {
  const h = harness() // admins 为空
  await h.main({ action: 'set', token: USER_TOKEN, bank: BANK })

  const r = await h.main({
    action: 'set',
    token: ADMIN_TOKEN,
    force: true,
    bank: { manifest: { subjects: [] }, questions: { v3: [] } }
  })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'NOT_ADMIN')
  const got = await h.main({ action: 'get' })
  assert.deepEqual(got.bank.questions, BANK.questions)
})

test('写入只保留 manifest / questions 白名单字段', async () => {
  const h = harness()
  const r = await h.main({
    action: 'set',
    token: USER_TOKEN,
    bank: Object.assign({}, BANK, { evil: 'x', updatedBy: 'spoof', _id: 'other' })
  })
  assert.equal(r.ok, true)

  const got = await h.main({ action: 'get' })
  assert.equal(got.bank.evil, undefined, '白名单外字段必须丢弃')
  assert.equal(got.bank.updatedBy, 'normal-openid', 'updatedBy 应取真实调用者，不接受伪造')
  assert.equal(got.bank._id, 'bank')
})
