/** 真实登录/资料云函数入口，共享可控数据库，显式调度「旧请求读完后新登录写入」。 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const crypto = require('node:crypto')

const NOW = new Date('2026-10-30T06:00:00Z').getTime()
const DAY = 86400000
const INITIAL_TOKEN = 'old-token'
const clone = (value) => JSON.parse(JSON.stringify(value))

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

function harness({ expired = true, pauseRevoke = false, failRevoke = false, missingTokenAt = false } = {}) {
  /** 置为 Error 可模拟 appConfig 读取抛出非「不存在」的失败 */
  const fail = { configGet: null }
  const config = new Map([['runtime', { _id: 'runtime', forceUpdate: true, minVersion: '9.9.9' }]])
  const user = {
    _id: 'user-a', openid: 'A', token: INITIAL_TOKEN,
    tokenAt: NOW - (expired ? 31 : 1) * DAY,
    nickName: '测试用户', avatarUrl: '', exam: '架构师'
  }
  if (missingTokenAt) delete user.tokenAt
  const rows = new Map([
    [user._id, user],
    ['user-b', { _id: 'user-b', openid: 'B', token: 'other-token', tokenAt: NOW }]
  ])
  const revokeStarted = deferred()
  const releaseRevoke = deferred()
  let writes = 0
  const matching = (filter) => Array.from(rows.values()).filter((row) =>
    Object.keys(filter).every((key) => row[key] === filter[key])
  )

  async function update(filter, data) {
    if (data.token === '') {
      revokeStarted.resolve()
      if (pauseRevoke) await releaseRevoke.promise
      if (failRevoke) throw new Error('storage unavailable')
    }
    // 在写入时原子地判断条件；不能使用暂停之前的查询快照。
    const selected = matching(filter)
    selected.forEach((row) => Object.assign(row, clone(data)))
    writes += selected.length
    return { stats: { updated: selected.length } }
  }

  const collection = {
    where(filter) {
      let limit = Infinity
      return {
        limit(count) { limit = count; return this },
        async get() { return { data: matching(filter).slice(0, limit).map(clone) } },
        update: ({ data }) => update(filter, data)
      }
    },
    doc(id) {
      return {
        update: ({ data }) => update({ _id: id }, data),
        async get() {
          // 仅 appConfig 下的文档可被读取；users 走 where 查询
          if (config.has(id)) {
            if (fail.configGet) throw fail.configGet
            return { data: clone(config.get(id)) }
          }
          throw new Error('document does not exist')
        }
      }
    },
    async add() { throw new Error('existing-user fixture should not add another user') }
  }
  const cloud = {
    init() {}, database: () => ({ collection: () => collection }),
    getWXContext: () => ({ OPENID: 'A' })
  }
  class FixedDate extends Date {
    static now() { return NOW }
  }

  function loadModule(absPath) {
    const exports = {}
    const module = { exports: exports }
    vm.runInNewContext(fs.readFileSync(absPath, 'utf8'), {
      exports, module, Date: FixedDate, process: { env: {} }, Buffer,
      require(name) {
        if (name === 'wx-server-sdk') return cloud
        if (name === 'crypto') return crypto
        if (name === 'https') return { get() { throw new Error('unexpected network request') } }
        // 云函数包内的相对模块（如 shared/ 的部署副本），按其自身路径递归加载
        if (name.indexOf('./') === 0) return loadModule(path.join(path.dirname(absPath), name))
        throw new Error(`unexpected module ${name}`)
      }
    })
    return module.exports
  }

  function load(name) {
    return loadModule(path.join(__dirname, `../cloudfunctions/${name}/index.js`)).main
  }
  return {
    profile: load('userProfile'), login: load('userLogin'),
    fail: fail,
    row: () => clone(rows.get('user-a')), other: () => clone(rows.get('user-b')),
    writes: () => writes, revokeStarted: revokeStarted.promise,
    release: () => releaseRevoke.resolve()
  }
}

test('过期校验清理与新登录交错：旧请求拒绝，新令牌仍可验证', async () => {
  const h = harness({ pauseRevoke: true })
  const oldRequest = h.profile({ token: INITIAL_TOKEN })
  await h.revokeStarted
  const fresh = await h.login({})
  assert.equal(fresh.ok, true)
  assert.notEqual(fresh.token, INITIAL_TOKEN)
  assert.equal(h.row().token, fresh.token)
  h.release()
  assert.equal((await oldRequest).error, 'INVALID_TOKEN')
  assert.equal(h.row().token, fresh.token)
  assert.equal(h.row().tokenAt, NOW)
  assert.equal((await h.profile({ token: fresh.token })).ok, true)
})

test('旧登录的退出请求与新登录交错：不撤销刚签发的新令牌', async () => {
  const h = harness({ expired: false, pauseRevoke: true })
  const oldLogout = h.profile({ token: INITIAL_TOKEN, action: 'logout' })
  await h.revokeStarted
  const fresh = await h.login({})
  h.release()
  assert.equal((await oldLogout).ok, true)
  assert.equal(h.row().token, fresh.token)
  assert.equal(h.row().tokenAt, NOW)
  assert.equal((await h.profile({ token: fresh.token })).ok, true)
})

test('多份过期清理同时等待时，新登录仍不受任何旧请求影响', async () => {
  const h = harness({ pauseRevoke: true })
  const old = Array.from({ length: 10 }, () => h.profile({ token: INITIAL_TOKEN }))
  await h.revokeStarted
  const fresh = await h.login({})
  h.release()
  const replies = await Promise.all(old)
  assert.ok(replies.every((r) => r.error === 'INVALID_TOKEN'))
  assert.equal(h.row().token, fresh.token)
  assert.equal((await h.profile({ token: fresh.token })).ok, true)
})

test('数据库仍保存旧令牌时正常清理过期会话', async () => {
  const h = harness()
  const result = await h.profile({ token: INITIAL_TOKEN })
  assert.equal(result.error, 'INVALID_TOKEN')
  assert.equal(h.row().token, '')
  assert.equal(h.row().tokenAt, 0)
  assert.equal(h.writes(), 1)
  assert.equal(h.other().token, 'other-token')
})

test('缺少 tokenAt 的旧数据仍按过期处理并正常清理', async () => {
  const h = harness({ missingTokenAt: true })
  assert.equal((await h.profile({ token: INITIAL_TOKEN })).error, 'INVALID_TOKEN')
  assert.equal(h.row().token, '')
})

test('过期清理失败也不把已过期令牌判为有效', async () => {
  const h = harness({ failRevoke: true })
  assert.equal((await h.profile({ token: INITIAL_TOKEN })).error, 'INVALID_TOKEN')
  assert.equal(h.row().token, INITIAL_TOKEN)
})

test('正常登出仍撤销当前令牌，重放旧登出不会再产生写入', async () => {
  const h = harness({ expired: false })
  assert.equal((await h.profile({ token: INITIAL_TOKEN, action: 'logout' })).ok, true)
  assert.equal(h.row().token, '')
  assert.equal((await h.profile({ token: INITIAL_TOKEN, action: 'logout' })).error, 'INVALID_TOKEN')
  assert.equal(h.writes(), 1)
  assert.equal(h.other().token, 'other-token')
})

test('登出写入故障不返回虚假的撤销成功', async () => {
  const h = harness({ expired: false, failRevoke: true })
  await assert.rejects(h.profile({ token: INITIAL_TOKEN, action: 'logout' }), /storage unavailable/)
})

test('有效令牌读取公开资料时不改写 token，也不返回内部身份字段', async () => {
  const h = harness({ expired: false })
  const result = await h.profile({ token: INITIAL_TOKEN })
  assert.equal(result.ok, true)
  assert.deepEqual(Object.keys(result.profile).sort(), ['avatarUrl', 'exam', 'nickName'])
  assert.equal(h.writes(), 0)
  assert.equal(h.row().token, INITIAL_TOKEN)
})

test('缺失或未知令牌直接拒绝，不修改其它会话', async () => {
  const h = harness({ expired: false })
  assert.equal((await h.profile({})).error, 'NO_TOKEN')
  assert.equal((await h.profile({ token: 'unknown' })).error, 'INVALID_TOKEN')
  assert.equal(h.writes(), 0)
  assert.equal(h.row().token, INITIAL_TOKEN)
})

/* ------------------------------------------------------------------ *
 * 运营配置读取失败必须报错，不能用空配置冒充「没有限制」
 * （评审 P2 4430849974 同类；涉及让 P2 4429855406 的端上修复不失效）
 * ------------------------------------------------------------------ */

test('运营配置读取失败时返回 ok:false，不得返回空配置', async () => {
  const h = harness({ expired: false })
  // 模拟读取超时 / 数据库错误（非「不存在」）
  h.fail.configGet = Object.assign(new Error('read timeout'), { errCode: -502001 })

  const r = await h.profile({ action: 'config' })
  assert.equal(r.ok, false, '读取失败不得报告成功')
  assert.equal(r.error, 'READ_CONFIG_FAILED')
  // 绝不能是 {ok:true, config:{}}：端上 user.getRuntimeConfig() 会把它
  // 理解成「拉取成功且运营没有任何限制」，从而清掉版本阻断态
  assert.equal(r.config, undefined, '不得给出空配置冒充「没有限制」')
})

test('运营配置确实还不存在时仍返回空配置（幂等）', async () => {
  const h = harness({ expired: false })
  const r = await h.profile({ action: 'config' })
  assert.equal(r.ok, true, '确认不存在应视为尚无限制')
  assert.deepEqual(r.config, { _id: 'runtime', forceUpdate: true, minVersion: '9.9.9' })
})
