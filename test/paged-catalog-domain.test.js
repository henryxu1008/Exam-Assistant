const { test } = require('node:test')
const assert = require('node:assert/strict')
const paged = require('../shared/paged-catalog-domain.js')
const domain = require('../shared/question-domain.js')
const exam = require('../shared/exam-catalog-domain.js')
const sample = require('../docs/examples/catalog-import.json')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { spawnSync } = require('node:child_process')
const copy = value => JSON.parse(JSON.stringify(value))
function input(count = 3, length = 1) {
  const bank = copy(sample.bank), original = bank.questions.it[0], source = sample.sources[original.id]
  bank.schemaVersion = 4; bank.manifest.exams = [{ id: 'exam', name: '考试' }]; bank.manifest.subjects[0].examId = 'exam'
  bank.questions.it = Array.from({ length: count }, (_, i) => ({ ...original, id: 'q' + String(i).padStart(5, '0'), stem: '合成' + i + 'x'.repeat(length) }))
  return { ...bank, sources: Object.fromEntries(bank.questions.it.map(q => [q.id, { ...source, reference: 'synthetic:' + q.id }])) }
}
function rehashRoot(root) {
  const { releaseId, ...value } = root
  root.releaseId = 'qb_' + domain.sha256(domain.canonical(value))
}

test('超过 500 题和原单文档预算的合成题库可完整分片，来源和题目分离', () => {
  const value = input(700, 1000), snapshot = copy(value)
  assert.throws(() => exam.buildExamRelease({ ...value, schemaVersion: 3 }))
  const result = paged.buildPagedCatalog(value), { root, evidence, publicPages, privatePages } = result
  assert.deepEqual(value, snapshot)
  assert.equal(root.totalQuestions, 700); assert.ok(root.pages.length > 1)
  assert.ok(publicPages.every(p => p.questions.length <= paged.limits.PAGE_QUESTIONS))
  assert.equal(paged.validComplete(root, evidence, publicPages, privatePages), true)
  assert.equal(JSON.stringify(root).includes('synthetic:'), false)
  assert.equal(JSON.stringify(publicPages).includes('synthetic:'), false)
  assert.ok(JSON.stringify(privatePages).includes('synthetic:'))
  const page = publicPages[3], q = page.questions[0]
  assert.equal(paged.findQuestion(root, page, q.id, q.versionId).bankReleaseId, root.releaseId)
  assert.equal(paged.findQuestion(root, page, q.id, 'qv_' + '0'.repeat(64)), null)
})

test('任何缺页、重复页、重排、错误发布、损坏题目或来源都不能被视为完整', () => {
  const a = paged.buildPagedCatalog(input(105)), b = paged.buildPagedCatalog(input(105, 2))
  const { root, evidence, publicPages, privatePages } = a
  assert.equal(paged.validComplete(root, evidence, publicPages.slice(1), privatePages), false)
  assert.equal(paged.validComplete(root, evidence, [publicPages[0], publicPages[0]], privatePages), false)
  assert.equal(paged.validComplete(root, evidence, [...publicPages].reverse(), privatePages), false)
  assert.equal(paged.validComplete(root, evidence, b.publicPages, privatePages), false)
  const badQuestion = copy(publicPages); badQuestion[0].questions[0].stem = '变造'
  assert.equal(paged.validComplete(root, evidence, badQuestion, privatePages), false)
  const badSource = copy(privatePages); badSource[0].sources[Object.keys(badSource[0].sources)[0]].reference = '变造'
  assert.equal(paged.validComplete(root, evidence, publicPages, badSource), false)
  const badEvidence = copy(evidence); badEvidence.pages[0].digest = '0'.repeat(64)
  assert.equal(paged.validComplete(root, badEvidence, publicPages, privatePages), false)
})

test('清单篡改、重复 ID、不合法题目或不完整来源均失败，不产生部分结果', () => {
  const result = paged.buildPagedCatalog(input(105)), invalid = copy(result.root)
  invalid.pages[1].firstId = invalid.pages[0].lastId; rehashRoot(invalid)
  assert.equal(paged.validRoot(invalid), false)
  const extra = copy(result.root); extra.unexpected = true; rehashRoot(extra)
  assert.equal(paged.validRoot(extra), false)
  const duplicate = input(2); duplicate.questions.it[1].id = duplicate.questions.it[0].id
  assert.throws(() => paged.buildPagedCatalog(duplicate), /DUPLICATE_ID/)
  const missing = input(3); delete missing.sources[missing.questions.it[0].id]
  assert.throws(() => paged.buildPagedCatalog(missing), /BAD_SOURCES/)
  const mismatch = input(3); mismatch.questions.it[0].chapter = '不存在'
  assert.throws(() => paged.buildPagedCatalog(mismatch), /BAD_QUESTION_SCOPE/)
  const bad = input(3); bad.questions.it[0].answer = ['bad']
  assert.throws(() => paged.buildPagedCatalog(bad), /BAD_ANSWER/)
})

test('只读分页预检报告行号和错误字段，不泄露题目或来源', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paged-catalog-')), file = path.join(dir, 'input.json')
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const value = input(3); value.questions.it[1].stem = 'PRIVATE-STEM'; value.sources[value.questions.it[1].id].reference = 'PRIVATE-SOURCE'
  const run = () => spawnSync(process.execPath, [path.join(__dirname, '../scripts/catalog-paged-preflight.js'), '--input', file], { encoding: 'utf8' })
  fs.writeFileSync(file, JSON.stringify(value)); const good = run()
  assert.equal(good.status, 0); assert.equal(JSON.parse(good.stdout).total, 3)
  assert.equal(good.stdout.includes('PRIVATE'), false)
  value.questions.it[1].answer = ['not-an-option']; fs.writeFileSync(file, JSON.stringify(value)); const bad = run()
  assert.equal(bad.status, 2); assert.deepEqual(JSON.parse(bad.stdout).errors[0], { row: 2, field: 'answer', code: 'BAD_ANSWER' })
  assert.equal(bad.stdout.includes('PRIVATE'), false)
  fs.writeFileSync(file, Buffer.from([0xc0, 0xaf])); assert.equal(run().status, 1)
})
