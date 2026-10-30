/**
 * initConfig 云函数鉴权回归测试（PR #10 评审发现 P1 4422245843）
 *
 * 原实现：任何人都能直接调用 initConfig 且无需任何凭据，
 * 每次调用都会整体覆盖 appConfig 的两份共享文档。
 * 后果：普通调用者可以删掉运营公告、重新打开已关闭的功能开关、
 * 把 forceUpdate 重置为 false（让所有人都绕过强制更新）。
 *
 * 锁定：
 *  - 未配置 ADMIN_SECRET 时一律拒绝（fail-closed，绝不「没配就放行」）；
 *  - 密钥不对时拒绝；
 *  - 密钥正确时才写入；
 *  - 默认只补缺失字段，不覆盖运营已有配置；force 才整体重置。
 */

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const crypto = require('node:crypto')

const NOW = new Date('2026-10-30T06:00:00Z').getTime()
const SECRET = 's3cret-sauce'

function harness({ env = {}, seeds = {} } = {}) {
  const appConfig = new Map()
  Object.keys(seeds).forEach((id) => appConfig.set(id, seeds[id]))

  const collections = {
    users: new Map([['u1', { _id: 'u1', openid: 'o1', token: 'tok', tokenAt: NOW }]]),
    appConfig: appConfig
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
      }
    }
  }

  const db = { collection: collection }

  class FixedDate extends Date {
    static now() {
      return NOW
    }
  }

  const processEnv = Object.assign({}, env)

  function loadModule(absPath) {
    const exports = {}
    const module = { exports: exports }
    vm.runInNewContext(fs.readFileSync(absPath, 'utf8'), {
      exports,
      module,
      Date: FixedDate,
      Buffer,
      process: { env: processEnv },
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
    main: loadModule(path.join(__dirname, '../cloudfunctions/initConfig/index.js')).main,
    doc: (id) => (collections.appConfig.has(id) ? clone(collections.appConfig.get(id)) : null)
  }
}

const clone = (v) => JSON.parse(JSON.stringify(v))

/* ------------------------------------------------------------------ *
 * fail-closed：没有配置管理员凭据时一律拒绝
 * ------------------------------------------------------------------ */

test('未配置 ADMIN_SECRET 时拒绝初始化，且不动任何配置', async () => {
  const h = harness()
  const r = await h.main({})
  assert.equal(r.ok, false)
  assert.equal(r.error, 'ADMIN_SECRET_NOT_CONFIGURED')
  assert.equal(h.doc('examOptions'), null)
  assert.equal(h.doc('runtime'), null)
})

test('未配置 ADMIN_SECRET 时，即便提供 token 也拒绝', async () => {
  const h = harness()
  const r = await h.main({ token: 'tok' })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'ADMIN_SECRET_NOT_CONFIGURED')
  assert.equal(h.doc('runtime'), null)
})

/* ------------------------------------------------------------------ *
 * 密钥校验
 * ------------------------------------------------------------------ */

test('密钥为空被拒绝', async () => {
  const h = harness({ env: { ADMIN_SECRET: SECRET } })
  const r = await h.main({})
  assert.equal(r.ok, false)
  assert.equal(r.error, 'NOT_ADMIN')
})

test('密钥错误被拒绝，配置保持不变', async () => {
  const h = harness({
    env: { ADMIN_SECRET: SECRET },
    seeds: { runtime: { _id: 'runtime', notice: '运营公告', noticeEnabled: true } }
  })
  const r = await h.main({ adminSecret: 'wrong' })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'NOT_ADMIN')
  assert.equal(h.doc('runtime').notice, '运营公告')
})

test('密钥正确时写入默认配置', async () => {
  const h = harness({ env: { ADMIN_SECRET: SECRET } })
  const r = await h.main({ adminSecret: SECRET })
  assert.equal(r.ok, true)
  assert.ok(Array.isArray(r.examOptions) && r.examOptions.length > 0)
  assert.equal(r.runtime._id, 'runtime')
  assert.equal(h.doc('examOptions')._id, 'examOptions')
  assert.equal(h.doc('runtime')._id, 'runtime')
})

/* ------------------------------------------------------------------ *
 * 不覆盖运营已有配置
 * ------------------------------------------------------------------ */

test('已存在运营配置时，默认只补缺失字段而不覆盖', async () => {
  const h = harness({
    env: { ADMIN_SECRET: SECRET },
    seeds: { runtime: { _id: 'runtime', notice: '重要公告', noticeEnabled: true } }
  })
  const r = await h.main({ adminSecret: SECRET })
  assert.equal(r.ok, true)
  // 运营设置保持原值
  assert.equal(h.doc('runtime').notice, '重要公告')
  assert.equal(h.doc('runtime').noticeEnabled, true)
  // 缺失的字段被补上默认值
  assert.equal(h.doc('runtime').forceUpdate, false)
  assert.equal(h.doc('runtime').minVersion, '1.0.0')
})

test('features 逐键补齐：运营已关闭的开关不会被重新打开', async () => {
  const h = harness({
    env: { ADMIN_SECRET: SECRET },
    seeds: { runtime: { _id: 'runtime', features: { aiAdvice: false } } }
  })
  const r = await h.main({ adminSecret: SECRET })
  assert.equal(r.ok, true)
  assert.equal(h.doc('runtime').features.aiAdvice, false)
})

test('force=true 时整体重置为默认值', async () => {
  const h = harness({
    env: { ADMIN_SECRET: SECRET },
    seeds: { runtime: { _id: 'runtime', notice: '重要公告', noticeEnabled: true, features: { aiAdvice: false } } }
  })
  const r = await h.main({ adminSecret: SECRET, force: true })
  assert.equal(r.ok, true)
  assert.equal(h.doc('runtime').notice, '')
  assert.equal(h.doc('runtime').noticeEnabled, false)
  assert.equal(h.doc('runtime').features.aiAdvice, true)
})

test('无凭据调用不会清空已存在的配置', async () => {
  const h = harness({
    seeds: { runtime: { _id: 'runtime', notice: '重要公告', noticeEnabled: true } }
  })
  const r = await h.main({ force: true })
  assert.equal(r.ok, false)
  assert.equal(h.doc('runtime').notice, '重要公告')
})
