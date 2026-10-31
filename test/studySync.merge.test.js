/**
 * studySync 云函数「合并而非覆盖」回归测试（PR #10 评审发现 P1 4422245834）
 *
 * 原实现：update 走 STATS.doc(openid).set()，无条件整doc替换。
 * 场景：两台设备恢复同一账号后各自练习、各自上传——
 *   后到的一方的整份文档会抹掉另一端新增的 records / daily / aiMessages。
 *   端上只在「每个作用域启动后」拉取一次，靠启动时的 mergeStats 保护不了后续写入。
 *
 * 锁定：服务端在事务内「读已有快照 → 与本次上传 mergeStats 合并 → 写入」，
 * 使并发上传是累加而非互相覆盖；且与端上共用 shared/stats-merge.js 的同一份语义。
 */

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const crypto = require('node:crypto')

const NOW = new Date('2026-10-30T06:00:00Z').getTime()
const DAY = 86400000
const TOKEN = 'tok'
const OPENID = 'o1'

const clone = (v) => JSON.parse(JSON.stringify(v))

function harness({ seeds = {}, txFails = false } = {}) {
  const collections = {
    users: new Map([
      ['u1', { _id: 'u1', openid: OPENID, token: TOKEN, tokenAt: NOW }],
      ['u2', { _id: 'u2', openid: 'o2', token: 'tok2', tokenAt: NOW }],
      ['u3', { _id: 'u3', openid: 'stale', token: 'stale', tokenAt: NOW - 31 * DAY }]
    ]),
    studyStats: new Map(),
    attempts: new Map()
  }
  Object.keys(seeds).forEach((id) => collections.studyStats.set(id, seeds[id]))

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
          },
          async remove() {
            if (!collections[name].has(id)) throw new Error('document does not exist')
            collections[name].delete(id)
            return { stats: { removed: 1 } }
          }
        }
      },
      where(filter) {
        let limit = Infinity
        let skip = 0
        return {
          limit(count) { limit = count; return this },
          skip(count) { skip = count; return this },
          orderBy() { return this },
          async get() {
            return { data: matching(name, filter).slice(skip, skip + limit).map(clone) }
          },
          async remove() {
            const rows = matching(name, filter)
            rows.forEach((row) => collections[name].delete(row._id))
            return { stats: { removed: rows.length } }
          }
        }
      }
    }
  }

  const db = { collection: collection }

  // 事务：串行执行以模拟可串行化隔离——后到的事务能看到先到事务的写入
  let queue = Promise.resolve()
  db.runTransaction = (fn) => {
    const run = queue.then(() => {
      if (txFails) throw new Error('tx conflict')
      return fn({ collection: collection })
    })
    queue = run.then(() => {}, () => {})
    return run
  }

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
    main: loadModule(path.join(__dirname, '../cloudfunctions/studySync/index.js')).main,
    stats: () => (collections.studyStats.has(OPENID) ? clone(collections.studyStats.get(OPENID)) : null),
    attempts: () => clone(Array.from(collections.attempts.values()))
  }
}

function statsPayload(over) {
  return Object.assign(
    {
      version: 3,
      records: {},
      daily: {},
      settings: { dailyGoal: 30, autoNext: true, aiExplain: true, currentSubject: '' },
    practiceSession: null,
    aiMessages: []
    },
    over || {}
  )
}

/* ------------------------------------------------------------------ *
 * 多端并发上传：累加而非互相覆盖
 * ------------------------------------------------------------------ */

test('两台设备先后上传，另一端的记录与统计不会被抹掉', async () => {
  const h = harness()

  await h.main({
    token: TOKEN,
    action: 'update',
    stats: statsPayload({
      records: { q1: { id: 'q1', lastAt: 1000, right: 1 } },
      daily: { '2026-10-30': { date: '2026-10-30', total: 2, correct: 1, timeMs: 100, chapters: {}, subjects: {} } }
    })
  })

  await h.main({
    token: TOKEN,
    action: 'update',
    stats: statsPayload({
      records: { q2: { id: 'q2', lastAt: 2000, right: 1 } },
      daily: { '2026-10-30': { date: '2026-10-30', total: 1, correct: 1, timeMs: 200, chapters: {}, subjects: {} } }
    })
  })

  const merged = h.stats()
  assert.ok(merged.records.q1, '设备 A 的记录必须保留')
  assert.ok(merged.records.q2, '设备 B 的记录必须保留')
  // 同日统计取较大值而非互相覆盖
  assert.equal(merged.daily['2026-10-30'].total, 2)
  assert.equal(merged.daily['2026-10-30'].timeMs, 200)
})

test('并发上传（Promise.all）不会丢失任一端的进度', async () => {
  const h = harness()
  await Promise.all([
    h.main({
      token: TOKEN,
      action: 'update',
      stats: statsPayload({
        records: { qa: { id: 'qa', lastAt: 1 } },
        aiMessages: [{ time: 1, role: 'u' }]
      })
    }),
    h.main({
      token: TOKEN,
      action: 'update',
      stats: statsPayload({
        records: { qb: { id: 'qb', lastAt: 2 } },
        aiMessages: [{ time: 2, role: 'a' }]
      })
    })
  ])

  const merged = h.stats()
  assert.ok(merged.records.qa && merged.records.qb, '并发上传的两份记录都必须保留')
  assert.equal(merged.aiMessages.length, 2, '并发上传的对话都必须保留')
})

test('不同账号的档案互不干扰', async () => {
  const h = harness()
  await h.main({ token: TOKEN, action: 'update', stats: statsPayload({ records: { q1: { id: 'q1', lastAt: 1 } } }) })
  await h.main({ token: 'tok2', action: 'update', stats: statsPayload({ records: { q2: { id: 'q2', lastAt: 2 } } }) })

  const mine = h.stats()
  assert.ok(mine.records.q1)
  assert.equal(mine.records.q2, undefined)
})

/* ------------------------------------------------------------------ *
 * 鉴权
 * ------------------------------------------------------------------ */

test('无令牌 / 无效令牌 / 过期令牌一律拒绝写入', async () => {
  const h = harness()
  assert.equal((await h.main({ action: 'update', stats: statsPayload() })).error, 'NO_TOKEN')
  assert.equal((await h.main({ action: 'update', token: 'bad', stats: statsPayload() })).error, 'INVALID_TOKEN')
  assert.equal((await h.main({ action: 'update', token: 'stale', stats: statsPayload() })).error, 'INVALID_TOKEN')
  assert.equal(h.stats(), null)
})

test('事务失败时返回失败，不谎报成功', async () => {
  const h = harness({ txFails: true })
  const r = await h.main({ token: TOKEN, action: 'update', stats: statsPayload() })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'TX_FAILED')
})

/* ------------------------------------------------------------------ *
 * 作答流水与白名单
 * ------------------------------------------------------------------ */

test('作答流水按 _id 幂等写入 attempts 集合，并打上 openid', async () => {
  const h = harness()
  const r = await h.main({
    token: TOKEN,
    action: 'update',
    stats: statsPayload(),
    attempts: [
      { id: 'a1', questionId: 'q1', score: 1, createdAt: 1 },
      { id: 'a2', questionId: 'q2', score: 0, createdAt: 2 }
    ]
  })
  assert.equal(r.ok, true)
  const list = h.attempts()
  assert.equal(list.length, 2)
  assert.ok(list.every((a) => a.openid === OPENID))
})

test('stats 白名单之外的字段不会落库', async () => {
  const h = harness()
  const r = await h.main({
    token: TOKEN,
    action: 'update',
    stats: statsPayload({ attempts: [], evil: 'x', openid: 'spoof' })
  })
  assert.equal(r.ok, true)
  assert.equal(h.stats().evil, undefined)
  assert.equal(h.stats().openid, OPENID)
})
