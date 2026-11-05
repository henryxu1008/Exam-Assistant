const { test } = require('node:test')
const assert = require('node:assert/strict')
const paged = require('../shared/paged-catalog-domain.js')
const projection = require('../shared/exam-page-projection.js')
const sample = require('../docs/examples/catalog-import.json')
const clone = value => JSON.parse(JSON.stringify(value))

function fixture() {
  const bank = clone(sample.bank), template = bank.questions.it[0], source = sample.sources[template.id]
  bank.schemaVersion = 4
  bank.manifest.exams = [{ id: 'exam_a', name: '考试甲' }, { id: 'exam_b', name: '考试乙' }]
  bank.manifest.subjects = [
    { key: 'subject_a', name: '科目甲', examId: 'exam_a', chapters: [{ key: 'net', name: '基础' }] },
    { key: 'subject_b', name: '科目乙', examId: 'exam_b', chapters: [{ key: 'net', name: '基础' }] }
  ]
  const rows = subject => Array.from({ length: 110 }, (_, i) => ({ ...clone(template), id: 'q' + String(i).padStart(3, '0') + subject,
    stem: `合成${subject}${i}`, subject: 'subject_' + subject, chapter: 'net' }))
  bank.questions = { subject_a: rows('a'), subject_b: rows('b') }
  const sources = Object.fromEntries(Object.values(bank.questions).flat().map(q => [q.id, clone(source)]))
  return paged.buildPagedCatalog({ ...bank, sources })
}

test('混排分片按考试过滤，保留题目版本与原发布且不返回其他考试和来源', () => {
  const built = fixture(), input = clone(built)
  const scope = projection.examScope(built.root, 'exam_a')
  assert.equal(scope.exam.id, 'exam_a'); assert.deepEqual(scope.subjects.map(s => s.key), ['subject_a'])
  assert.equal(scope.sourcePageCount, built.publicPages.length)
  const pages = built.publicPages.map(p => projection.projectPage(built.root, p, 'exam_a'))
  const questions = pages.flatMap(p => p.questions)
  assert.equal(questions.length, 110); assert.ok(questions.every(q => q.subject === 'subject_a'))
  assert.equal(pages[0].releaseId, built.root.releaseId)
  assert.equal(questions[0].versionId, built.publicPages[0].questions.find(q => q.subject === 'subject_a').versionId)
  assert.equal(JSON.stringify({ scope, pages }).includes('subject_b'), false)
  assert.equal(JSON.stringify({ scope, pages }).includes('sources'), false)
  assert.deepEqual(built, input, '投影不能改变发布归档')
})

test('坏页、缺页、错误考试和变造的发布根都不能返回部分题目', () => {
  const built = fixture(), broken = clone(built.publicPages[0])
  broken.questions[0].stem = '篡改'
  assert.throws(() => projection.projectPage(built.root, broken, 'exam_a'), /INVALID_PUBLISHED_PAGE/)
  assert.throws(() => projection.projectPage(built.root, undefined, 'exam_a'), /INVALID_PUBLISHED_PAGE/)
  assert.throws(() => projection.projectPage(built.root, built.publicPages[0], 'unknown'), /EXAM_NOT_FOUND/)
  const root = clone(built.root); root.manifest.subjects[0].examId = 'exam_b'
  assert.throws(() => projection.examScope(root, 'exam_a'), /INVALID_RELEASE/)
})
