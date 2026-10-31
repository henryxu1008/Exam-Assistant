/**
 * studySync 账号隔离 + 写操作串行化回归测试
 * （PR #10 评审 P1 4422339084 / P1 4422339092）
 *
 * 两条是同一类问题的两端：云端的写操作既没有「归属约束」，也没有「顺序保证」。
 */

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const crypto = require('node:crypto')

const NOW = new Date('2026-10-30T06:00:00Z').getTime()
const DAY = 86400000

const clone = (v) => JSON.parse(JSON.stringify(v))

function makeHarness() {
  const users = new Map([
    ['u1', { _id: 'u1', openid: 'alice', token: 'tokA', tokenAt: NOW }],
    ['u2', { _id: 'u2', openid: 'bob', token: 'tokB', tokenAt: NOW }]
  ])
  const studyStats = new Map()
  const attempts = new Map()

  const stores = { users: users, studyStats: studyStats, attempts: attempts }

  /** 置为 Error 可模拟数据库操作抛出非「不存在」的失败 */
  const fail = { remove: null, get: null }

  function collection(name) {
    const store = stores[name]
    return {
      doc(id) {
        return {
          async get() {
            if (fail.get) throw fail.get
            if (!store.has(id)) throw new Error('document does not exist')
            return { data: clone(store.get(id)) }
          },
          async set({ data }) {
            const store = { users: users, studyStats: studyStats, attempts: attempts }[name]
            store.set(id, clone(data))
            return { stats: { updated: 1 } }
          },
          async remove() {
            if (fail.remove) throw fail.remove
            const store = { users: users, studyStats: studyStats, attempts: attempts }[name]
            if (!store.has(id)) throw new Error('document does not exist')
            store.delete(id)
            return { stats: { removed: 1 } }
          }
        }
      },
      where(filter) {
        let limit = Infinity
        let skip = 0
        const rows = () =>
          Array.from(store.values()).filter((row) =>
          Object.keys(filter).every((k) => row[k] === filter[k])
          )
        return {
          limit(c) { limit = c; return this },
          skip(c) { skip = c; return this },
          orderBy() { return this },
          async get() { return { data: rows().slice(skip, skip + limit).map(clone) } },
          async remove() {
            if (fail.remove) throw fail.remove
            const hit = rows()
            hit.forEach((r) => store.delete(r._id))
            return { stats: { removed: hit.length } }
          }
        }
      }
    }
  }

  const db = { collection: collection }

  class FixedDate extends Date {
    static now() { return NOW }
  }

  function loadModule(absPath) {
    const exports = {}
    const module = { exports: exports }
    vm.runInNewContext(fs.readFileSync(absPath, 'utf8'), {
      exports,
      module,
      Date: FixedDate,
      Buffer,
      process: { env: {} },
      require(name) {
        if (name === 'wx-server-sdk') return { init() {}, database: () => db }
        if (name === 'crypto') return crypto
        if (name.indexOf('./') === 0) return loadModule(path.join(path.dirname(absPath), name))
        throw new Error(`unexpected module ${name}`)
      }
    })
    return module.exports
  }

  return {
    db: db,
    users: users,
    studyStats: studyStats,
    attempts: attempts,
    fail: fail,
    main: loadModule(path.join(__dirname, '../cloudfunctions/studySync/index.js')).main
  }
}

/** 记录一次 update 上传，含本地流式编号，便于断言并发顺序 */
function updatePayload(n) {
  return {
    version: 3,
    records: { ['q' + n]: { id: 'q' + n, lastAt: 1000 + n } },
    daily: {},
    settings: {},
    practiceSession: null,
    aiMessages: [],
    aiEpoch: 0,
    attempts: [{ id: 'a' + n, questionId: 'q' + n, createdAt: 1000 + n }]
  }
}

/* ------------------------------------------------------------------ *
 * P1 4422339084：attempt 文档 _id 必须按账号隔离
 * ------------------------------------------------------------------ */

test('调用方无法用已知 id 覆盖他人作答流水', async () => {
  const h = makeHarness()

  // alice 先上传自己的一条作答
  await h.main({ token: 'tokA', action: 'update', stats: updatePayload(1), attempts: updatePayload(1).attempts })

  // bob 已知 alice 的 attempt id，试图覆盖并据为己有
  await h.main({
    token: 'tokB',
    action: 'update',
    stats: updatePayload(2),
    attempts: [{ id: 'a1', questionId: 'HACKED', createdAt: 9999 }]
  })

  const original = h.attempts.get('alice__a1')
  const bobCopy = h.attempts.get('bob__a1')

  assert.ok(original, 'alice 的流水应仍在其命名空间下')
  assert.strictEqual(original.questionId, 'q1', 'alice 的作答内容不得被篡改')
  assert.strictEqual(original.openid, 'alice', '归属不得被改写')

  // bob 凭 id 写入只会在自己的命名空间产生一条副本，不影响 alice
  assert.ok(bobCopy, 'bob 的写入落在其自身命名空间')
  assert.strictEqual(bobCopy.openid, 'bob')
})

test('作答流水写入时带上归属 openid', async () => {
  const h = makeHarness()
  await h.main({
    token: 'tokA',
    action: 'update',
    stats: updatePayload(7),
    attempts: updatePayload(7).attempts
  })

  const row = h.attempts.get('alice__a7')
  assert.ok(row, '应按 openid 前缀落库')
  assert.strictEqual(row.openid, 'alice')
})

test('并发上传的作答流水互不覆盖（按账号隔离 _id）', async () => {
  const h = makeHarness()
  await Promise.all([
    h.main({ token: 'tokA', action: 'update', stats: updatePayload(1), attempts: updatePayload(1).attempts }),
    h.main({ token: 'tokB', action: 'update', stats: updatePayload(2), attempts: updatePayload(2).attempts })
  ])

  assert.ok(h.attempts.get('alice__a1'), 'alice 的流水存在')
  assert.ok(h.attempts.get('bob__a2'), 'bob 的流水存在')
  assert.strictEqual(h.attempts.get('alice__a1').openid, 'alice')
  assert.strictEqual(h.attempts.get('bob__a2').openid, 'bob')
})

/* ------------------------------------------------------------------ *
 * P1 4422339092：删除必须排在在途上传之后
 * ------------------------------------------------------------------ */

test('不同账号的同名 attempt id 互不干扰', async () => {
  const h = makeHarness()
  // 两端各自生成了相同的 attempt id（客户端 ID 冲突）
  await h.main({
    token: 'tokA', action: 'update',
    stats: updatePayload(9), attempts: [{ id: 'same', questionId: 'qA', createdAt: 1 }]
  })
  await h.main({
    token: 'tokB', action: 'update',
    stats: updatePayload(9), attempts: [{ id: 'same', questionId: 'qB', createdAt: 2 }]
  })

  assert.strictEqual(h.attempts.get('alice__same').questionId, 'qA')
  assert.strictEqual(h.attempts.get('bob__same').questionId, 'qB')
})

test('跨账号删除不会误删他人数据', async () => {
  const h = makeHarness()
  await h.main({ token: 'tokA', action: 'update', stats: updatePayload(1), attempts: updatePayload(1).attempts })
  await h.main({ token: 'tokB', action: 'update', stats: updatePayload(2), attempts: updatePayload(2).attempts })

  await h.main({ token: 'tokA', action: 'delete' })

  assert.ok(!h.attempts.has('alice__a1'), 'alice 的流水应被删除')
  assert.ok(h.attempts.get('bob__a2'), 'bob 的流水必须保留')
})

test('删除失败时返回 ok:false，不得承认成功（评审 P2 4425946091）', async () => {
  const h = makeHarness()
  await h.main({ token: 'tokA', action: 'update', stats: updatePayload(1), attempts: updatePayload(1).attempts })

  // 模拟数据库抛出非「不存在」的失败（权限 / 网络 / 配额……）
  h.fail.remove = Object.assign(new Error('permission denied'), { errCode: -502003 })

  const res = await h.main({ token: 'tokA', action: 'delete' })
  assert.strictEqual(res.ok, false, '删除失败不得报告成功')
  assert.strictEqual(res.error, 'DELETE_STATS_FAILED')
  assert.ok(h.studyStats.has('alice'), '失败时服务端数据应仍在')
})

test('快照读取失败时不得当成「没有云端数据」（评审 P1 4429855402）', async () => {
  const h = makeHarness()
  // 服务端先有一份含 q1 的备份
  await h.main({ token: 'tokA', action: 'update', stats: updatePayload(1), attempts: updatePayload(1).attempts })
  const before = clone(h.studyStats.get('alice'))

  // 模拟读取超时 / 数据库错误（非「不存在」）
  h.fail.get = Object.assign(new Error('read timeout'), { errCode: -502001 })

  let ok = null
  try {
    ok = (await h.main({ token: 'tokA', action: 'update', stats: updatePayload(2), attempts: [] })).ok
  } catch (e) {
    ok = false // 无事务兜底路径会直接抛出，同样不得静默成功
  }

  assert.notStrictEqual(ok, true, '读取失败不得报告成功')
  assert.ok(h.studyStats.get('alice').records.q1, '不得用不完整快照覆盖服务端备份')
  assert.strictEqual(
    h.studyStats.get('alice').records.q1.lastAt,
    before.records.q1.lastAt,
    '服务端已有记录必须原样保留'
  )
})

test('文档不存在时删除仍算成功（幂等，评审 P2 4425946091）', async () => {
  const h = makeHarness()
  // 从未上传过，studyStats 里没有该文档
  const res = await h.main({ token: 'tokA', action: 'delete' })
  assert.strictEqual(res.ok, true, '确认不存在应视为已清空')
})

test('无令牌 / 无效令牌时删除被拒绝', async () => {
  const h = makeHarness()
  await h.main({ token: 'tokA', action: 'update', stats: updatePayload(1), attempts: updatePayload(1).attempts })

  assert.strictEqual((await h.main({ action: 'delete' })).error, 'NO_TOKEN')
  assert.strictEqual((await h.main({ action: 'delete', token: 'nope' })).error, 'INVALID_TOKEN')
  assert.strictEqual(h.studyStats.size, 1, '被拒绝的删除不得生效')
})
