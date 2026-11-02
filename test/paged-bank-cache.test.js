const { test } = require('node:test')
const assert = require('node:assert/strict')
const paged = require('../shared/paged-catalog-domain.js')
const { createPagedCache } = require('../utils/paged-bank-cache.js')
const sample = require('../docs/examples/catalog-import.json')
const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value))
function catalog(suffix = '') {
  const bank = copy(sample.bank), q = bank.questions.it[0], source = sample.sources[q.id]
  bank.schemaVersion = 4; bank.manifest.exams = [{ id: 'exam', name: '考试' }]; bank.manifest.subjects[0].examId = 'exam'
  bank.questions.it = Array.from({ length: 201 }, (_, i) => ({ ...q, id: 'q' + String(i).padStart(3, '0'), stem: q.stem + suffix }))
  return paged.buildPagedCatalog({ ...bank, sources: Object.fromEntries(bank.questions.it.map(item => [item.id, source])) })
}
function storage() {
  const data = new Map(), fail = { read: false, writeAt: 0, count: 0, afterWrite: false }
  return { data, fail, getStorageSync(k) { if (fail.read) throw new Error('read'); return data.has(k) ? copy(data.get(k)) : '' },
    setStorageSync(k, v) { if (++fail.count === fail.writeAt) throw new Error('write'); data.set(k, copy(v)); if (fail.afterWrite) throw new Error('after') } }
}

test('完整分片校验和落盘后才切换根，重启后可读完整题库', () => {
  const wx = storage(), cache = createPagedCache(wx), v = catalog()
  assert.equal(cache.read().status, 'missing')
  assert.equal(cache.install(v.root, 1, v.publicPages).ok, true)
  const recovered = createPagedCache(wx).read()
  assert.equal(recovered.status, 'ready'); assert.equal(recovered.source.questions.it.length, 201)
  assert.equal(recovered.source.releaseId, v.root.releaseId)
})

test('缺页、损坏、过时发布及中途写入失败均不切换原根', () => {
  const wx = storage(), cache = createPagedCache(wx), old = catalog('old'), next = catalog('new')
  assert.equal(cache.install(old.root, 1, old.publicPages).ok, true)
  assert.equal(cache.install(next.root, 2, next.publicPages.slice(1)).ok, false)
  const corrupt = copy(next.publicPages); corrupt[0].questions[0].stem = '坏'
  assert.equal(cache.install(next.root, 2, corrupt).ok, false)
  assert.equal(cache.install(next.root, 1, next.publicPages).error, 'STALE_PAGED_RELEASE')
  wx.fail.writeAt = wx.fail.count + 2
  assert.equal(cache.install(next.root, 2, next.publicPages).ok, false)
  wx.fail.writeAt = 0
  assert.equal(cache.read().source.releaseId, old.root.releaseId)
})

test('读失败和已落盘页面损坏不冒充无缓存', () => {
  const wx = storage(), cache = createPagedCache(wx), v = catalog()
  cache.install(v.root, 1, v.publicPages)
  wx.fail.read = true; assert.equal(cache.read().status, 'error'); wx.fail.read = false
  const pageKey = [...wx.data.keys()].find(k => k.includes('__qb_'))
  wx.data.delete(pageKey); assert.equal(cache.read().status, 'error')
  assert.equal(cache.install(v.root, 1, v.publicPages).ok, true)
  assert.equal(cache.read().status, 'ready')
})

test('损坏的根指针可以由完整发布修复，但读取失败不得覆盖已有内容', () => {
  const wx = storage(), cache = createPagedCache(wx), first = catalog('first'), next = catalog('next')
  assert.equal(cache.install(first.root, 1, first.publicPages).ok, true)
  const pointerKey = 'exam_quiz_bank_paged_root_v1'
  wx.data.get(pointerKey).root.releaseId = 'damaged'
  assert.equal(cache.read().status, 'error')
  assert.equal(cache.install(next.root, 2, next.publicPages).ok, true)
  assert.equal(cache.read().source.releaseId, next.root.releaseId)
  const before = JSON.stringify([...wx.data.entries()])
  wx.fail.read = true
  assert.equal(cache.install(first.root, 3, first.publicPages).error, 'PAGED_CACHE_READ_FAILED')
  wx.fail.read = false; assert.equal(JSON.stringify([...wx.data.entries()]), before)
  assert.equal(cache.install(first.root, 1, first.publicPages).error, 'STALE_PAGED_RELEASE')
})
