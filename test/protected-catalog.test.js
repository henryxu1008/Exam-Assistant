const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createProtectedCatalog } = require('../utils/protected-catalog.js')
const base = () => ({ ok: true, releaseId: 'qb_' + 'a'.repeat(64), publicationRevision: 1,
  exams: [{ id: 'one', name: '考试一', hidden: 'not copied' }, { id: 'two', name: '考试二' }],
  subjects: [{ key: 'a', name: '科目甲', examId: 'one', chapters: [{ key: 'c', name: '第一章' }] },
    { key: 'b', name: '科目乙', examId: 'two', chapters: [] }] })
function setup() {
  let session = { logged: true, openid: 'A', token: 'token' }, generation = 1, call = async () => base()
  const client = createProtectedCatalog({ getSession: () => session,
    captureSync: () => ({ scope: session.openid, token: session.token, generation }),
    syncCurrent: ctx => ctx.generation === generation, call: (...args) => call(...args) })
  return { client, change: value => { session = value; generation++ }, bump: () => generation++, call: value => { call = value } }
}
test('目录只存名称和范围，选择考试并在同一账号刷新时保留', async () => {
  const { client } = setup()
  assert.equal((await client.load()).selected, 'one')
  assert.equal(client.select('not-found'), false)
  assert.equal(client.select('two'), true)
  assert.deepEqual(client.snapshot().subjects.map(s => s.key), ['b'])
  assert.equal((await client.load()).selected, 'two')
  assert.doesNotMatch(JSON.stringify(client.snapshot()), /not copied/)
})
test('切换账号及 A→B→A 时清除选择，迟到响应不能恢复旧数据', async () => {
  const { client, change, bump, call } = setup()
  await client.load(); let resolve
  call(() => new Promise(r => { resolve = r }))
  const pending = client.load()
  change({ logged: true, openid: 'B', token: 'other' })
  assert.equal(client.snapshot(), null)
  change({ logged: true, openid: 'A', token: 'token' }); bump()
  resolve(base()); await assert.rejects(pending, /STALE_CONTEXT/)
  assert.equal(client.snapshot(), null)
})
test('读取失败或目录格式错误不会沿用旧选择', async () => {
  const { client, call } = setup()
  await client.load(); call(async () => { throw new Error('network') })
  await assert.rejects(client.load(), /NETWORK_ERROR/); assert.equal(client.snapshot(), null)
  call(async () => ({ ...base(), subjects: [{ key: 'bad', name: '坏科目', examId: 'missing', chapters: [] }] }))
  await assert.rejects(client.load(), /INVALID_RESPONSE/); assert.equal(client.snapshot(), null)
})
