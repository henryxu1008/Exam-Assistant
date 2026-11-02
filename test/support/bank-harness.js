const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const crypto = require('node:crypto')

const NOW = new Date('2026-10-30T06:00:00Z').getTime()
const DAY = 86400000
const clone = (value) => JSON.parse(JSON.stringify(value))

const USER_TOKEN = 'user-token'
const ADMIN_TOKEN = 'admin-token'
const ADMIN_OPENID = 'admin-openid'

function harness({ admins = [ADMIN_OPENID], env = {} } = {}) {
  /** 置为 Error 可模拟数据库读取抛出非「不存在」的失败 */
  const fail = { get: null, write: null, query: null, beforeTransaction: null }
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

  const transactions = []
  function collection(name, source = collections, trace) {
    return {
      doc(id) {
        return {
          async get() {
            if (trace) trace.push({ operation: 'get', name, id })
            if (fail.get && (typeof fail.get !== 'function' || fail.get(name, id))) throw new Error('injected read timeout')
            const store = source[name]
            if (!store.has(id)) throw new Error('document does not exist')
            return { data: clone(store.get(id)) }
          },
          async set({ data }) {
            if (trace) trace.push({ operation: 'set', name, id })
            if (fail.write && (typeof fail.write !== 'function' || fail.write(name, id))) throw new Error('injected write failure')
            source[name].set(id, clone(data))
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
            if (fail.query) throw new Error('injected identity lookup failure')
            return { data: matching(name, filter).slice(0, limit).map(clone) }
          }
        }
      }
    }
  }

  const db = { collection: collection }

  // 事务：串行执行以模拟可串行化隔离——后到的事务能看到先到事务的写入
  let queue = Promise.resolve()
  db.runTransaction = (fn) => {
    const run = queue.then(async () => {
      if (fail.beforeTransaction) { const hook = fail.beforeTransaction; fail.beforeTransaction = null; await hook() }
      const draft = Object.fromEntries(Object.entries(collections).map(([key, map]) => [key, new Map([...map].map(([id, row]) => [id, clone(row)]))]))
      const trace = []; transactions.push(trace)
      const result = await fn({ collection: name => collection(name, draft, trace) })
      for (const name of Object.keys(collections)) { collections[name].clear(); for (const [id, row] of draft[name]) collections[name].set(id, row) }
      return result
    })
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

  const processEnv = Object.assign({}, env)

  /** 在受控 VM 中加载一个模块（模拟云函数运行时的独立模块作用域） */
  function loadModule(absPath) {
    const exports = {}
    const module = { exports: exports }
    vm.runInNewContext(fs.readFileSync(absPath, 'utf8'), {
      exports,
      module,
      Date: FixedDate,
      Buffer, // 云函数运行在 Node 中，鉴权用到常量时间比较
      process: { env: processEnv },
      require(name) {
        if (name === 'wx-server-sdk') return { init() {}, database: () => db }
        if (name === 'crypto') return crypto
        // 云函数内的部署副本：与 shared/ 下的源文件同名
        if (name.indexOf('./') === 0) {
          return loadModule(path.join(path.dirname(absPath), name))
        }
        throw new Error(`unexpected module ${name}`)
      }
    })
    // 必须返回 module.exports 而非 exports：被加载模块可能整体替换 module.exports
    return module.exports
  }

  const main = loadModule(path.join(__dirname, '../../cloudfunctions/bankSync/index.js')).main
  return {
    main: main,
    documents: collections.questions,
    transactions,
    config: collections.appConfig,
    users: collections.users,
    db: db,
    fail: fail,
    seedBank: (bank) => collections.questions.set('bank', clone(bank)),
    bank: () => (collections.questions.has('bank') ? clone(collections.questions.get('bank')) : null)
  }
}

module.exports = { harness, ADMIN_TOKEN, USER_TOKEN, ADMIN_OPENID }
