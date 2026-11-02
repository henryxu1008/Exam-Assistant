const { test } = require('node:test')
const assert = require('node:assert/strict')
const paged = require('../shared/paged-catalog-domain.js')
const { harness } = require('./support/bank-harness.js')
const sample = require('../docs/examples/catalog-import.json')
const copy = value => JSON.parse(JSON.stringify(value))
function fixture() {
  const bank = copy(sample.bank), first = bank.questions.it[0], source = sample.sources[first.id]
  bank.schemaVersion = 4; bank.manifest.exams = [{ id: 'exam', name: '考试' }]; bank.manifest.subjects[0].examId = 'exam'
  bank.questions.it = Array.from({ length: 205 }, (_, i) => ({ ...first, id: 'q' + String(i).padStart(4, '0') }))
  return paged.buildPagedCatalog({ ...bank, sources: Object.fromEntries(bank.questions.it.map(q => [q.id, source])) })
}
function seed(h, value) {
  h.documents.set('bank', { schemaVersion: 4, root: copy(value.root), publicationRevision: 1 })
  h.documents.set(value.root.releaseId, { kind: 'pagedQuestionBankRelease', root: copy(value.root), publishedAt: 1 })
  for (const page of value.publicPages) h.documents.set(paged.pageDocumentId(page.releaseId, page.index), { kind: 'pagedQuestionBankPage', page: copy(page) })
}

test('分片读取只返回已发布根及指定完整题目页，私有来源不暴露', async () => {
  const h = harness(), v = fixture()
  h.documents.set(paged.pageDocumentId(v.root.releaseId, 0), { kind: 'pagedQuestionBankPage', page: copy(v.publicPages[0]) })
  assert.equal((await h.main({ action: 'getPagedPage', releaseId: v.root.releaseId, index: 0 })).error, 'PUBLISHED_RELEASE_NOT_FOUND')
  seed(h, v)
  const active = await h.main({ action: 'getPagedPublished' })
  assert.equal(active.ok, true); assert.equal(active.root.releaseId, v.root.releaseId)
  assert.equal((await h.main({ action: 'getPublished' })).error, 'PAGED_PROTOCOL_REQUIRED')
  const page = await h.main({ action: 'getPagedPage', releaseId: v.root.releaseId, index: 1 })
  assert.equal(page.ok, true); assert.equal(page.page.questions.length, 100)
  assert.equal(JSON.stringify(page).includes('synthetic:'), false)
  assert.equal((await h.main({ action: 'getPagedPage', releaseId: v.root.releaseId, index: 99 })).error, 'BAD_PAGE_QUERY')
})

test('分片缺失、损坏、错误类型和读取异常均明确失败，不能返回空页或部分页', async () => {
  const h = harness(), v = fixture(); seed(h, v)
  const id = paged.pageDocumentId(v.root.releaseId, 0), saved = copy(h.documents.get(id))
  h.documents.delete(id)
  assert.equal((await h.main({ action: 'getPagedPage', releaseId: v.root.releaseId, index: 0 })).error, 'PUBLISHED_PAGE_NOT_FOUND')
  h.documents.set(id, copy(saved)); h.documents.get(id).page.questions[0].stem = '损坏'
  assert.equal((await h.main({ action: 'getPagedPage', releaseId: v.root.releaseId, index: 0 })).error, 'INVALID_PUBLISHED_PAGE')
  h.documents.set(id, { kind: 'privateSourcePage', page: copy(v.privatePages[0]) })
  assert.equal((await h.main({ action: 'getPagedPage', releaseId: v.root.releaseId, index: 0 })).error, 'INVALID_PUBLISHED_PAGE')
  h.documents.set(id, saved); h.fail.get = (name, key) => key === id
  assert.equal((await h.main({ action: 'getPagedPage', releaseId: v.root.releaseId, index: 0 })).error, 'READ_PAGED_RELEASE_FAILED')
})
