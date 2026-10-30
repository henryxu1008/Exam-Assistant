/** 预算护栏测试：真实云函数入口 + 可控数据库/HTTPS 替身，不发出任何外部请求。 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')

const source = fs.readFileSync(path.join(__dirname, '../cloudfunctions/aiTutor/index.js'), 'utf8')
const FIXED = new Date(2026, 9, 30, 12).getTime()
const DATE = '2026-10-30'

function harness({ cap = 1, seed = [], failRead = false, failUpdate = false } = {}) {
  const rows = new Map(seed.map((row) => [row._id, Object.assign({}, row)]))
  let calls = 0
  let seq = 0
  const db = {
    command: { lt: (value) => ({ lt: value }), inc: (value) => ({ inc: value }) },
    collection: () => ({
      where(filter) {
        let limit = Infinity
        let skip = 0
        let ordered = false
        function matching() {
          return Array.from(rows.values()).filter((row) => Object.keys(filter).every((key) => {
            const expected = filter[key]
            return expected && typeof expected === 'object' && 'lt' in expected
              ? row[key] < expected.lt : row[key] === expected
          }))
        }
        return {
          orderBy() { ordered = true; return this },
          limit(value) { limit = value; return this },
          skip(value) { skip = value; return this },
          async get() {
            if (failRead) throw new Error('database unavailable')
            let found = matching()
            if (ordered) found.sort((a, b) => a._id.localeCompare(b._id))
            const snapshot = found.slice(skip, skip + limit).map((row) => Object.assign({}, row))
            // 先取快照再让出执行权，让并发请求同时观察到「当日计数尚未创建」。
            await Promise.resolve()
            return { data: snapshot }
          },
          async update({ data }) {
            if (failUpdate) throw new Error('write unavailable')
            const found = matching()
            found.forEach((row) => Object.keys(data).forEach((key) => {
              row[key] = data[key] && typeof data[key] === 'object' && 'inc' in data[key]
                ? (row[key] || 0) + data[key].inc : data[key]
            }))
            return { stats: { updated: found.length } }
          }
        }
      },
      async add({ data }) {
        const id = data._id || `auto-${++seq}`
        if (rows.has(id)) throw new Error('duplicate _id')
        rows.set(id, Object.assign({}, data, { _id: id }))
        await Promise.resolve()
        return { _id: id }
      }
    })
  }
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [FIXED])) }
    static now() { return FIXED }
  }
  const exports = {}
  vm.runInNewContext(source, {
    exports, URL, Buffer, Date: FixedDate,
    process: { env: {
      AI_TUTOR_ENABLED: 'true', AI_TUTOR_DAILY_CAP: String(cap),
      LLM_ENDPOINT: 'https://llm.invalid/chat/completions', LLM_API_KEY: 'test-placeholder'
    } },
    require(name) {
      if (name === 'wx-server-sdk') return { init() {}, database: () => db }
      if (name === 'https') return {
        request(options, respond) {
          calls += 1
          const req = new EventEmitter()
          req.setTimeout = () => {}
          req.write = () => {}
          req.end = () => {
            const res = new EventEmitter()
            res.statusCode = 200
            respond(res)
            res.emit('data', JSON.stringify({ choices: [{ message: { content: '测试回复' } }] }))
            res.emit('end')
          }
          return req
        }
      }
      throw new Error(`Unexpected module ${name}`)
    }
  })
  return { main: exports.main, rows, calls: () => calls }
}

const event = { messages: [{ role: 'user', content: '你好' }], subject: '公共基础知识' }

test('每日上限 1：并发首次调用只预约一次，所有实例使用同一个每日文档', async () => {
  const h = harness()
  const results = await Promise.all(Array.from({ length: 20 }, () => h.main(event)))
  assert.equal(h.calls(), 1)
  assert.equal(results.filter((result) => result.content).length, 1)
  assert.equal(h.rows.size, 1)
  assert.equal(h.rows.get(DATE).count, 1)
})

test('已有计数时，并发请求不能突破剩余额度', async () => {
  const h = harness({ cap: 3, seed: [{ _id: DATE, date: DATE, count: 2 }] })
  await Promise.all(Array.from({ length: 10 }, () => h.main(event)))
  assert.equal(h.calls(), 1)
  assert.equal(h.rows.get(DATE).count, 3)
})

test('升级时汇总旧版随机 ID 计数，不重置当天预算', async () => {
  const h = harness({ cap: 3, seed: [
    { _id: 'old-a', date: DATE, count: 1 }, { _id: 'old-b', date: DATE, count: 1 }
  ] })
  await Promise.all(Array.from({ length: 10 }, () => h.main(event)))
  assert.equal(h.calls(), 1)
  assert.equal(h.rows.get(DATE).count, 3)
})

test('迁移遍历全部旧计数文档，避免数据库默认分页漏算', async () => {
  const seed = Array.from({ length: 105 }, (_, i) => ({ _id: `old-${i}`, date: DATE, count: 1 }))
  const h = harness({ cap: 105, seed })
  await h.main(event)
  assert.equal(h.calls(), 0)
  assert.equal(h.rows.get(DATE).count, 105)
})

for (const failure of ['failRead', 'failUpdate']) {
  test(`计数数据库故障 (${failure}) 时不调用付费上游`, async () => {
    const h = harness({ [failure]: true })
    const result = await h.main(event)
    assert.equal(h.calls(), 0)
    assert.equal(result.content, null)
    assert.equal(result.reason, 'BUDGET')
  })
}

for (const cap of ['bad-config', -1, 0.5]) {
  test(`无效配额配置 ${cap} 不得变成无限额度`, async () => {
    const h = harness({ cap })
    await h.main(event)
    assert.equal(h.calls(), 0)
  })
}

test('无有效消息不消耗配额', async () => {
  const h = harness()
  await h.main({ messages: [] })
  assert.equal(h.calls(), 0)
  await h.main(event)
  assert.equal(h.calls(), 1)
})

test('显式配额 0 保留不限制调用的配置语义', async () => {
  const h = harness({ cap: 0 })
  await Promise.all([h.main(event), h.main(event)])
  assert.equal(h.calls(), 2)
})
