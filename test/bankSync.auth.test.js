/**
 * bankSync 云函数写权限回归测试（PR #10 评审发现 P1）
 *
 * 题库是全体用户共享的内容，原实现任何人都能直接调用 set 覆盖它，
 * 从而篡改所有用户看到的题目与答案。这里锁定三件事：
 *  - 写入必须持有有效且未过期的登录令牌，匿名直调直接拒绝；
 *  - 题库一旦建立，普通调用不得覆盖，只有管理员可显式 force；
 *  - 管理员判定走 shared/auth.js，密钥未配置时 fail-closed。
 */

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { harness, ADMIN_TOKEN, USER_TOKEN, ADMIN_OPENID } = require('./support/bank-harness.js')

const BANK = { manifest: { subjects: [{ key: 'gk', name: '公基' }] }, questions: { gk: [] } }

test('普通用户不能抢先初始化全局题库', async () => {
  const h = harness()
  for (const force of [false, true]) {
    const result = await h.main({ action: 'set', token: USER_TOKEN, bank: BANK, force })
    assert.equal(result.error, 'NOT_ADMIN')
    assert.equal(h.bank(), null)
  }
})

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

test('云端为空时管理员可完成一次性初始化', async () => {
  const h = harness()
  const r = await h.main({ action: 'set', token: ADMIN_TOKEN, bank: BANK })
  assert.equal(r.ok, true)

  const got = await h.main({ action: 'get' })
  assert.equal(got.ok, true)
  assert.deepEqual(got.bank.questions, BANK.questions)
  assert.equal(got.bank.updatedBy, ADMIN_OPENID)
})

test('题库已存在时普通调用无法覆盖，返回 NOT_ADMIN', async () => {
  const h = harness()
  await h.main({ action: 'set', token: ADMIN_TOKEN, bank: BANK })

  const evil = {
    manifest: { subjects: [{ key: 'gk', name: '被篡改' }] },
    questions: { gk: [{ id: 'fake', answer: ['A'] }] }
  }
  const r = await h.main({ action: 'set', token: USER_TOKEN, bank: evil })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'NOT_ADMIN')

  // 原有内容未被改写
  const got = await h.main({ action: 'get' })
  assert.deepEqual(got.bank.questions, BANK.questions)
  assert.equal(got.bank.updatedBy, ADMIN_OPENID)
})

test('读取题库失败不得绕过 force + 管理员校验（评审 P2 4430849974 同类）', async () => {
  const h = harness({ env: { ADMIN_OPENIDS: ADMIN_OPENID } })
  // 先由管理员种入题库：此后题库文档是存在的
  const first = await h.main({ action: 'set', token: ADMIN_TOKEN, bank: BANK })
  assert.equal(first.ok, true)
  const before = h.bank()

  // 模拟读取超时 / 数据库错误（非「不存在」）
  h.fail.get = Object.assign(new Error('read timeout'), { errCode: -502001 })

  // 正常情况下这次覆盖会被 BANK_EXISTS 挡下（无 force、非管理员）。
  // 若把读失败当成「文档不存在」，bankExists() 会返回 false，
  // 于是 force + 管理员两道校验被整体跳过，任何人都能冲掉运营题库。
  const evil = {
    manifest: { subjects: [{ key: 'gk', name: '被篡改' }] },
    questions: { gk: [{ id: 'fake', answer: ['A'] }] }
  }
  const result = await h.main({ action: 'set', token: ADMIN_TOKEN, bank: evil })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'TX_FAILED')

  const after = h.bank()
  assert.deepEqual(after.manifest, before.manifest, '题库 manifest 不得被覆盖')
  assert.deepEqual(after.questions, before.questions, '题库内容不得被覆盖')
  assert.equal(after.updatedBy, ADMIN_OPENID, '写入者不得被改写')
})

test('并发首次初始化只有一个成功，另一个收到 BANK_EXISTS', async () => {
  const h = harness()
  const results = await Promise.all([
    h.main({ action: 'set', token: ADMIN_TOKEN, bank: BANK }),
    h.main({ action: 'set', token: ADMIN_TOKEN, bank: BANK })
  ])
  assert.equal(results.filter((r) => r.ok).length, 1, '只允许一个初始化成功')
  assert.equal(results.filter((r) => r.error === 'BANK_EXISTS').length, 1, '另一个必须被拒绝')
})

/* ------------------------------------------------------------------ *
 * 管理员强制覆盖
 * ------------------------------------------------------------------ */

test('非管理员即使 force 也无法覆盖已有题库', async () => {
  const h = harness({ admins: [ADMIN_OPENID] })
  await h.main({ action: 'set', token: ADMIN_TOKEN, bank: BANK })

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
  await h.main({ action: 'set', token: ADMIN_TOKEN, bank: BANK })

  const next = { manifest: { subjects: [] }, questions: { v2: [] } }
  const r = await h.main({ action: 'set', token: ADMIN_TOKEN, force: true, bank: next })
  assert.equal(r.ok, true)

  const got = await h.main({ action: 'get' })
  assert.deepEqual(got.bank.questions, { v2: [] })
  assert.equal(got.bank.updatedBy, ADMIN_OPENID)
})

test('管理员密钥可作为无登录身份调用的凭据（控制台运行）', async () => {
  const h = harness({ env: { ADMIN_SECRET: 's3cret' } })
  await h.main({ action: 'set', token: ADMIN_TOKEN, bank: BANK })

  const next = { manifest: { subjects: [] }, questions: { viaSecret: [] } }
  const r = await h.main({ action: 'set', adminSecret: 's3cret', force: true, bank: next })
  assert.equal(r.ok, true, '持有密钥的管理员应可强制覆盖')
  assert.deepEqual((await h.main({ action: 'get' })).bank.questions, { viaSecret: [] })
})

test('未配置任何管理员凭据时，任何人都无法覆盖已有题库（fail-closed）', async () => {
  const h = harness({ admins: [] }) // admins 为空且无 ADMIN_SECRET
  h.seedBank(BANK)

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

test('错误的管理员密钥被拒绝', async () => {
  const h = harness({ env: { ADMIN_SECRET: 's3cret' } })
  await h.main({ action: 'set', token: ADMIN_TOKEN, bank: BANK })

  const r = await h.main({
    action: 'set',
    adminSecret: 'wrong',
    force: true,
    bank: { manifest: { subjects: [] }, questions: { nope: [] } }
  })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'NOT_ADMIN')
})

test('写入只保留 manifest / questions 白名单字段', async () => {
  const h = harness()
  const r = await h.main({
    action: 'set',
    token: ADMIN_TOKEN,
    bank: Object.assign({}, BANK, { evil: 'x', updatedBy: 'spoof', _id: 'other' })
  })
  assert.equal(r.ok, true)

  const got = await h.main({ action: 'get' })
  assert.equal(got.bank.evil, undefined, '白名单外字段必须丢弃')
  assert.equal(got.bank.updatedBy, ADMIN_OPENID, 'updatedBy 应取真实调用者，不接受伪造')
  assert.equal(got.bank._id, 'bank')
})

test('运行时无事务能力时拒绝首次题库初始化，防止并发绕过一次性写入约束', async () => {
  const h = harness()
  delete h.db.runTransaction
  const results = await Promise.all([
    h.main({ action: 'set', token: ADMIN_TOKEN, bank: BANK }),
    h.main({ action: 'set', token: ADMIN_TOKEN, bank: BANK })
  ])
  results.forEach((result) => {
    assert.equal(result.ok, false)
    assert.equal(result.error, 'TRANSACTION_REQUIRED')
  })
  assert.equal(h.bank(), null)
})
