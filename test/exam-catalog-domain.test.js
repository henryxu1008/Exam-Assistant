const { test } = require('node:test')
const assert = require('node:assert/strict')
const legacy = require('../shared/question-domain.js')
const exams = require('../shared/exam-catalog-domain.js')
const sample = require('../docs/examples/catalog-import.json')
const copy = value => JSON.parse(JSON.stringify(value))
function input() {
  const bank = copy(sample.bank)
  bank.schemaVersion = 3
  bank.manifest.exams = [{ id: 'architect', name: '系统架构设计师' }]
  bank.manifest.subjects[0].examId = 'architect'
  return bank
}

test('考试归属参与发布摘要，题目版本保持旧规则，输入不被修改', () => {
  const value = input(), original = copy(value), bank = exams.buildExamRelease(value)
  const old = legacy.buildRelease(sample.bank)
  assert.deepEqual(value, original)
  assert.equal(exams.validExamRelease(bank), true)
  assert.equal(bank.questions.it[0].versionId, old.questions.it[0].versionId)
  assert.notEqual(bank.releaseId, old.releaseId)
  assert.equal(legacy.validRelease(old), true)
  assert.equal(legacy.validRelease(bank), false, '旧消费者不能把新格式误认成完整旧发布')
  const changed = copy(value); changed.manifest.exams.push({ id: 'other', name: '另一考试' }); changed.manifest.subjects[0].examId = 'other'
  const other = exams.buildExamRelease(changed)
  assert.notEqual(other.releaseId, bank.releaseId)
  assert.equal(other.questions.it[0].versionId, bank.questions.it[0].versionId)
})

test('缺失、重复、未知考试归属或变造的发布均拒绝', () => {
  for (const mutate of [v => { delete v.manifest.subjects[0].examId }, v => { v.manifest.subjects[0].examId = 'missing' },
    v => { v.manifest.exams.push(copy(v.manifest.exams[0])) }, v => { v.manifest.exams = [] }, v => { v.schemaVersion = 2 }]) {
    const value = input(); mutate(value)
    assert.throws(() => exams.buildExamRelease(value))
  }
  const bank = exams.buildExamRelease(input())
  bank.manifest.exams[0].name = '变造'
  assert.equal(exams.validExamRelease(bank), false)
  assert.equal(exams.validExamRelease(legacy.buildRelease(sample.bank)), false)
})

test('考试项目不能绕过原题目及分类校验', () => {
  const bad = input(); bad.questions.it[0].answer = ['UNKNOWN']
  assert.throws(() => exams.buildExamRelease(bad), /BAD_ANSWER/)
  const mismatch = input(); mismatch.questions.it[0].chapter = '不存在'
  assert.throws(() => exams.buildExamRelease(mismatch), /BAD_QUESTION_SCOPE/)
})
