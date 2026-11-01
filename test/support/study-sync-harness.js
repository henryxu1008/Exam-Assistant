/** 带事务草稿/回滚的内存数据库，用于真实 studySync 入口的故障和协议测试。 */
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const crypto = require('node:crypto')
const NOW = new Date('2026-10-30T06:00:00Z').getTime()
const clone = (value) => JSON.parse(JSON.stringify(value))

function makeHarness() {
  const users = new Map([
    ['u1', { _id: 'u1', openid: 'alice', token: 'tokA', tokenAt: NOW }],
    ['u2', { _id: 'u2', openid: 'bob', token: 'tokB', tokenAt: NOW }]
  ])
  const studyStats = new Map()
  const attempts = new Map()

  const stores = { users: users, studyStats: studyStats, attempts: attempts }

  /** 置为 Error 可模拟数据库操作抛出非「不存在」的失败 */
  const fail = { remove: null, get: null, attempts: null, attemptsResult: undefined }

  function collection(name, source = stores) {
    const store = source[name]
    return {
      doc(id) {
        return {
          async get() {
            if (fail.get) throw fail.get
            if (name === 'studyStats' && String(id).startsWith('aiClear_') && fail.receiptRead) throw fail.receiptRead
            if (!store.has(id)) throw new Error('document does not exist')
            return { data: clone(store.get(id)) }
          },
          async set({ data }) {
            if (name === 'attempts' && fail.attemptWrite) throw fail.attemptWrite
            if (name === 'studyStats' && fail.statsWrite) throw fail.statsWrite
            if (name === 'studyStats' && data.kind === 'aiClearReceipt' && fail.receiptWrite) throw fail.receiptWrite
            if (name === 'attempts' && fail.pauseAttempt) await fail.pauseAttempt()
            store.set(id, clone(data))
            return { stats: { updated: 1 } }
          },
          async remove() {
            if (fail.remove) throw fail.remove
            if (fail.pauseRemove) await fail.pauseRemove()
            if (!store.has(id)) throw new Error('document does not exist')
            store.delete(id)
            return { stats: { removed: 1 } }
          }
        }
      },
      where(filter) {
        let limit = Infinity
        let skip = 0
        const ordering = []
        const rows = () =>
          Array.from(store.values()).filter((row) =>
          Object.keys(filter).every((k) => {
            const value = filter[k]
            if (value && typeof value === 'object' && 'lt' in value) return row[k] < value.lt
            if (value && typeof value === 'object' && 'gt' in value) return row[k] > value.gt
            if (value && typeof value === 'object' && 'exists' in value) return (row[k] !== undefined) === value.exists
            return row[k] === value
          })
          )
        return {
          limit(c) { limit = c; return this },
          skip(c) { skip = c; return this },
          orderBy(field, direction) { ordering.push([field, direction]); return this },
          async get() {
            // 只命中 attempts：users 上的同款查询是令牌查找，不能一并打挂
            if (fail.attempts && name === 'attempts') throw fail.attempts
            if (name === 'attempts' && fail.attemptsResult !== undefined) return fail.attemptsResult
            const found = rows()
            found.sort((a, b) => {
              for (const [field, direction] of ordering) {
                if (a[field] !== b[field]) return (a[field] < b[field] ? -1 : 1) * (direction === 'desc' ? -1 : 1)
              }
              return 0
            })
            return { data: found.slice(skip, skip + limit).map(clone) }
          },
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

  const db = { collection, command: { gt: (v) => ({ gt: v }), lt: (v) => ({ lt: v }), exists: (v) => ({ exists: v }) } }
  let queue = Promise.resolve()
  db.runTransaction = (fn) => {
    const run = queue.then(async () => {
      const draft = Object.fromEntries(Object.entries(stores).map(([key, map]) => [key, new Map(Array.from(map, ([id, row]) => [id, clone(row)]))]))
      const result = await fn({ collection: (name) => collection(name, draft) })
      for (const name of Object.keys(stores)) {
        stores[name].clear()
        for (const [id, row] of draft[name]) stores[name].set(id, row)
      }
      return result
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
    db: db,
    users: users,
    studyStats: studyStats,
    attempts: attempts,
    fail: fail,
    main: loadModule(path.join(__dirname, '../../cloudfunctions/studySync/index.js')).main
  }
}

module.exports = { makeHarness }
