/** 带事务草稿/回滚的内存数据库，用于真实 studySync 入口的故障和协议测试。 */
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const crypto = require('node:crypto')
const NOW = new Date('2026-10-30T06:00:00Z').getTime()
const clone = (value) => JSON.parse(JSON.stringify(value))

function makeHarness({ source, questionDocuments, sourceRoot = path.join(__dirname, '../..') } = {}) {
  const users = new Map([
    ['u1', { _id: 'u1', openid: 'alice', token: 'tokA', tokenAt: NOW }],
    ['u2', { _id: 'u2', openid: 'bob', token: 'tokB', tokenAt: NOW }]
  ])
  const studyStats = new Map()
  const attempts = new Map()
  const questions = questionDocuments || new Map()
  const appConfig = new Map(), commerceTimelines = new Map(), protectedAttempts = new Map(), protectedStudyHeads = new Map(), protectedQuestionStates = new Map(), protectedStateReceipts = new Map(), commerceProducts = new Map(), commerceOrders = new Map(), commerceGrants = new Map(), commerceEvents = new Map()

  const stores = { users: users, studyStats: studyStats, attempts: attempts, questions, appConfig, commerceTimelines, protectedAttempts, protectedStudyHeads, protectedQuestionStates, protectedStateReceipts, commerceProducts, commerceOrders, commerceGrants, commerceEvents }

  /** 置为 Error 可模拟数据库操作抛出非「不存在」的失败 */
  const fail = { remove: null, get: null, attempts: null, attemptsResult: undefined, openid: 'alice' }

  const transactions = []
  function collection(name, source = stores, trace = null) {
    const store = source[name]
    return {
      doc(id) {
        return {
          async get() {
            if (trace) trace.push({ name, id, operation: 'get' })
            if (fail.get && (typeof fail.get !== 'function' || fail.get(name, id))) throw typeof fail.get === 'function' ? new Error('injected read failure') : fail.get
            if (name === 'questions' && fail.releaseRead) throw fail.releaseRead
            if (name === 'studyStats' && String(id).startsWith('aiClear_') && fail.receiptRead) throw fail.receiptRead
            if (!store.has(id)) throw new Error('document does not exist')
            return { data: clone(store.get(id)) }
          },
          async set({ data }) {
            if (trace) trace.push({ name, id, operation: 'set' })
            if (name === 'attempts' && fail.attemptWrite) throw fail.attemptWrite
            if (name === 'protectedAttempts' && fail.protectedAttemptWrite) throw fail.protectedAttemptWrite
            if (name === 'protectedStudyHeads' && fail.protectedHeadWrite) throw fail.protectedHeadWrite
            if (name === 'protectedQuestionStates' && fail.protectedStateWrite) throw fail.protectedStateWrite
            if (name === 'protectedStateReceipts' && fail.protectedStateReceiptWrite) throw fail.protectedStateReceiptWrite
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
            if (fail.protectedQuery && name === 'protectedAttempts') throw fail.protectedQuery
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
      if (fail.beforeTransaction) { const hook = fail.beforeTransaction; fail.beforeTransaction = null; await hook() }
      const draft = Object.fromEntries(Object.entries(stores).map(([key, map]) => [key, new Map(Array.from(map, ([id, row]) => [id, clone(row)]))]))
      const trace = []
      transactions.push(trace)
      const result = await fn({ collection: (name) => collection(name, draft, trace) })
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
    vm.runInNewContext(source && absPath.endsWith('/studySync/index.js') ? source : fs.readFileSync(absPath, 'utf8'), {
      exports,
      module,
      Date: FixedDate,
      Buffer,
      process: { env: {} },
      require(name) {
        if (name === 'wx-server-sdk') return { init() {}, database: () => db, getWXContext: () => ({ OPENID: fail.openid }) }
        if (name === 'crypto') return crypto
        if (name.indexOf('./') === 0) return loadModule(path.join(path.dirname(absPath), name))
        throw new Error(`unexpected module ${name}`)
      }
    })
    return module.exports
  }

  return {
    db: db,
    transactions,
    users: users,
    studyStats: studyStats,
    attempts: attempts,
    questions,
    appConfig, commerceTimelines, protectedAttempts, protectedStudyHeads, protectedQuestionStates, protectedStateReceipts, commerceProducts, commerceOrders, commerceGrants, commerceEvents,
    fail: fail,
    main: loadModule(path.join(sourceRoot, 'cloudfunctions/studySync/index.js')).main
  }
}

module.exports = { makeHarness }
