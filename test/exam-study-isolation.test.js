const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const examDomain = require('../shared/exam-catalog-domain.js')
const { device } = require('./support/study-sync-device.js')
const { makeHarness } = require('./support/study-sync-harness.js')
const source = require('../docs/examples/catalog-import.json')
const copy = value => JSON.parse(JSON.stringify(value))

test('两个考试的同名科目使用不同身份，切换后题目和统计互不串用', async () => {
  const bank = copy(source.bank), other = copy(bank.manifest.subjects[0]), q = copy(bank.questions.it[0])
  bank.schemaVersion = 3; bank.manifest.exams = [{ id: 'a', name: '考试甲' }, { id: 'b', name: '考试乙' }]
  bank.manifest.subjects[0].examId = 'a'; other.key = 'other-it'; other.examId = 'b'
  bank.manifest.subjects.push(other); q.id = 'OTHER-Q'; bank.questions[other.key] = [q]
  const release = examDomain.buildExamRelease(bank), h = makeHarness()
  h.questions.set(release.releaseId, { kind: 'questionBankRelease', bank: release, publishedAt: 1 })
  const proxy = { getSubjects: () => [] }, d = device(h, undefined, true, proxy)
  try {
    d.wx.setStorageSync('exam_quiz_bank_published_v2', { ...release, publicationRevision: 1 })
    const file = path.join(__dirname, '../utils/bank/index.js'), module = { exports: {} }
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, wx: d.wx, require: name => require(path.resolve(path.dirname(file), name)) })
    Object.assign(proxy, module.exports)
    assert.equal(proxy.getSubjects('a')[0].label, proxy.getSubjects('b')[0].label)
    assert.notEqual(proxy.getSubjects('a')[0].name, proxy.getSubjects('b')[0].name)
    d.store.setCurrentExam('a'); assert.equal(d.store.getCurrentSubject(), 'it')
    const qa = proxy.findQuestion('DEMO-1')
    d.store.createPracticeSession({ subject: qa.subject, questionIds: [qa.id], questions: [qa] })
    assert.equal(d.store.submitAttempt(qa, ['A'], true, 10, 'a').ok, true); await d.settle()
    assert.equal(d.store.getToday().total, 1)
    d.store.setCurrentExam('b'); assert.equal(d.store.getCurrentSubject(), 'other-it')
    assert.equal(d.store.getToday().total, 0)
    const qb = proxy.findQuestion('OTHER-Q')
    assert.notEqual(qa.chapter, qb.chapter)
    d.store.createPracticeSession({ subject: qb.subject, questionIds: [qb.id], questions: [qb] })
    assert.equal(d.store.submitAttempt(qb, ['A'], true, 10, 'b').ok, true); await d.settle()
    assert.equal(d.store.getToday().total, 1)
    assert.equal(d.store.getRecord(qa.id).subject, 'it')
    assert.equal(d.store.getRecord(qb.id).subject, 'other-it')
    assert.equal(h.studyStats.get('alice').records[qa.id].attempts, 1)
    assert.equal(h.studyStats.get('alice').records[qb.id].attempts, 1)
    const daily = Object.values(h.studyStats.get('alice').daily)[0]
    assert.equal(daily.chapters[qa.chapter].total, 1)
    assert.equal(daily.chapters[qb.chapter].total, 1)
  } finally { d.store.__clearFlushTimer() }
})
