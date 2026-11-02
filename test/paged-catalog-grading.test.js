const { test } = require('node:test')
const assert = require('node:assert/strict')
const paged = require('../shared/paged-catalog-domain.js')
const { makeHarness } = require('./support/study-sync-harness.js')
const { fact } = require('./support/grading-fixture.js')
const sample = require('../docs/examples/catalog-import.json')
const copy = value => JSON.parse(JSON.stringify(value))
function catalog(suffix = '') {
  const bank = copy(sample.bank), q = bank.questions.it[0], source = sample.sources[q.id]
  bank.schemaVersion = 4; bank.manifest.exams = [{ id: 'exam', name: '考试' }]; bank.manifest.subjects[0].examId = 'exam'
  bank.questions.it = [{ ...q, id: 'q' + suffix }]
  return paged.buildPagedCatalog({ ...bank, sources: { ['q' + suffix]: source } })
}
function seed(h, v) {
  h.questions.set(v.root.releaseId, { kind: 'pagedQuestionBankRelease', root: copy(v.root), publishedAt: 1 })
  for (const page of v.publicPages) h.questions.set(paged.pageDocumentId(page.releaseId, page.index), { kind: 'pagedQuestionBankPage', page: copy(page) })
}
const request = (h, attempts, extra = {}) => h.main({ token: 'tokA', action: 'commitPagedAttempts', attemptProtocol: 2, questionProtocol: 3, dataEpoch: 0, attempts, ...extra })
const question = v => ({ ...v.publicPages[0].questions[0], bankReleaseId: v.root.releaseId, catalogProtocol: 4 })
const state = h => JSON.stringify({ stats: [...h.studyStats], attempts: [...h.attempts] })

test('按原发布的分片判分，重试不重复计数且旧协议明确拒绝', async () => {
  const h = makeHarness(), v = catalog(), q = question(v); seed(h, v)
  const f = fact(q)
  const old = await h.main({ token: 'tokA', action: 'commitVersionedAttempts', attemptProtocol: 2, questionProtocol: 2, dataEpoch: 0, attempts: [f] })
  assert.equal(old.error, 'PAGED_PROTOCOL_REQUIRED'); assert.equal(h.attempts.size, 0)
  assert.equal((await request(h, [f], { questionProtocol: 2 })).error, 'PAGED_PROTOCOL_REQUIRED')
  const accepted = await request(h, [f]); assert.equal(accepted.ok, true); assert.equal(accepted.questionProtocol, 3)
  assert.equal(accepted.attemptReceipts[0].gradingStatus, 'graded')
  const before = JSON.stringify([...h.attempts])
  assert.equal((await request(h, [f])).ok, true); assert.equal(JSON.stringify([...h.attempts]), before)
  assert.equal(h.studyStats.get('alice').records[q.id].attempts, 1)
})

test('缺页、损坏、错误类型及数据库读取失败不接受作答或部分计数', async () => {
  for (const scenario of ['missing', 'tamper', 'type', 'read']) {
    const h = makeHarness(), v = catalog(scenario), q = question(v); seed(h, v)
    const id = paged.pageDocumentId(v.root.releaseId, 0), before = state(h)
    if (scenario === 'missing') h.questions.delete(id)
    if (scenario === 'tamper') h.questions.get(id).page.questions[0].stem = '损坏'
    if (scenario === 'type') h.questions.get(id).kind = 'privateSourcePage'
    if (scenario === 'read') h.fail.get = (name, key) => name === 'questions' && key === id
    const result = await request(h, [fact(q)])
    assert.equal(result.error, { missing: 'PUBLISHED_PAGE_NOT_FOUND', tamper: 'INVALID_PUBLISHED_PAGE', type: 'INVALID_PUBLISHED_PAGE', read: 'READ_PAGED_PAGE_FAILED' }[scenario])
    assert.equal(state(h), before)
  }
})

test('分页判分最多 19 条不同发布且事务操作不超过 100 次', async () => {
  const h = makeHarness(), submitted = []
  for (let i = 0; i < 20; i++) {
    const v = catalog(String(i)); seed(h, v); submitted.push(fact(question(v)))
  }
  assert.equal((await request(h, submitted)).error, 'BATCH_TOO_LARGE')
  assert.equal(h.transactions.length, 0)
  assert.equal((await request(h, submitted.slice(0, 19))).ok, true)
  assert.ok(h.transactions.at(-1).length <= 100)
})
