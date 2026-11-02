/** Abrupt subprocess termination bypasses catch/finally. Only synthetic temp files are used. */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { createLocalRepository } = require('../utils/local-repository.js')
const { getDefaultState } = require('../shared/stats-merge.js')
function adapter(data) {
  return { getStorageSync: key => data.get(key) || '', setStorageSync: (key, value) => data.set(key, value),
    removeStorageSync: key => data.delete(key), getStorageInfoSync: () => ({ keys: [...data.keys()], currentSize: 0, limitSize: 1048576 }) }
}
const worker = `
const fs = require('node:fs')
const { createLocalRepository } = require(${JSON.stringify(require.resolve('../utils/local-repository.js'))})
const [file, action, stop, phase] = process.argv.slice(1)
const input = JSON.parse(fs.readFileSync(file, 'utf8')), data = new Map(input.data)
let mutations = 0
function mutate(fn) {
  mutations++
  if (mutations === Number(stop) && phase === 'before') process.exit(75)
  fn(); fs.writeFileSync(file, JSON.stringify({ ...input, data: [...data] }))
  if (mutations === Number(stop) && phase === 'after') process.exit(75)
}
const repo = createLocalRepository({
  getStorageSync: key => data.get(key) || '',
  setStorageSync: (key, value) => mutate(() => data.set(key, value)),
  removeStorageSync: key => mutate(() => data.delete(key)),
  getStorageInfoSync: () => ({ keys: [...data.keys()], currentSize: 0, limitSize: 1048576 })
})
if (action === 'migrate') repo.write('alice', input.candidate)
else if (action === 'clear') repo.clear('alice')
else repo.rollback('alice')
process.stdout.write(JSON.stringify({ mutations }))
`
for (const action of ['migrate', 'clear', 'rollback']) test(`${action} 每个存储修改前后直接退出进程，重启仍有完整权威档案`, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exam-repo-crash-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'synthetic.json'), data = new Map(), repo = createLocalRepository(adapter(data))
  const original = { ...getDefaultState(), attempts: Array.from({ length: 65 }, (_, i) => ({ id: 'confirmed-' + i })), attemptOutbox: { version: 1, pending: [] } }
  const operation = { id: 'pending', selected: ['B'] }
  const candidate = { ...original, attempts: original.attempts.concat(operation), attemptOutbox: { version: 1, pending: [operation] } }
  data.set(repo.rootKey('alice'), original)
  data.set(repo.rootKey('bob'), { ...getDefaultState(), attempts: [{ id: 'bob' }] })
  if (action !== 'migrate') repo.write('alice', candidate)
  const initial = JSON.stringify({ data: [...data], candidate })
  fs.writeFileSync(file, initial)
  const run = (stop, phase) => spawnSync(process.execPath, ['-e', worker, file, action, String(stop), phase], { encoding: 'utf8', timeout: 10000 })
  const complete = run(0, 'after')
  assert.equal(complete.status, 0, complete.stderr)
  const count = JSON.parse(complete.stdout).mutations
  assert.ok(count > 1)
  t.diagnostic(`${count * 2} abrupt exits at storage API boundaries; native torn writes are not simulated`)
  for (let index = 1; index <= count; index++) for (const phase of ['before', 'after']) {
    fs.writeFileSync(file, initial)
    const crashed = run(index, phase)
    assert.equal(crashed.status, 75, crashed.stderr)
    const recoveredData = new Map(JSON.parse(fs.readFileSync(file, 'utf8')).data)
    const cold = createLocalRepository(adapter(recoveredData)), restored = cold.read('alice')
    assert.equal(cold.read('bob').attempts[0].id, 'bob')
    if (action === 'clear') {
      assert.ok(restored === null || restored.attempts.length === candidate.attempts.length)
      cold.clear('alice'); assert.equal(cold.read('alice'), null)
    } else {
      if (action === 'migrate') assert.ok(restored.attempts.length === original.attempts.length || restored.attempts.length === candidate.attempts.length)
      else assert.equal(restored.attempts.length, candidate.attempts.length)
      assert.deepEqual(restored, restored.attempts.length === original.attempts.length ? original : candidate)
      assert.equal(restored.attemptOutbox.pending.length, restored.attempts.some(a => a.id === 'pending') ? 1 : 0)
      if (action === 'migrate') cold.write('alice', candidate)
      else cold.rollback('alice')
      assert.equal(cold.read('alice').attempts.length, candidate.attempts.length)
      assert.equal(cold.read('alice').attemptOutbox.pending[0].id, 'pending')
    }
  }
})
