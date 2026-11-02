const { test } = require('node:test')
const assert = require('node:assert/strict')
const editor = require('../utils/catalog-editor.js')
const domain = require('../shared/question-domain.js')
const sample = require('../docs/examples/catalog-import.json')
const copy = value => JSON.parse(JSON.stringify(value))
const source = sample.sources['DEMO-1']
const q = { id: 'Q-NEW', type: 'single', stem: '合成题', options: [{ key: 'A', text: '甲' }, { key: 'B', text: '乙' }], answer: ['A'] }

test('从完整旧发布显式指定考试，编辑保留所有未修改题目和来源', () => {
  const bank = domain.buildRelease(sample.bank), data = { draft: { bank, sources: copy(sample.sources), publicationRevision: 3 }, basePublication: { revision: 3, releaseId: bank.releaseId } }
  const original = copy(data)
  let w = editor.openWorkspace(data)
  assert.throws(() => editor.prepare(w), /BAD_EXAMS/)
  w = editor.change(w, { type: 'addExam', id: 'arch', name: '架构师' })
  assert.throws(() => editor.prepare(w), /BAD_EXAM_OWNERSHIP/)
  w = editor.change(w, { type: 'assignSubject', subjectKey: 'it', examId: 'arch' })
  w = editor.change(w, { type: 'addChapter', subjectKey: 'it', chapterKey: 'new', name: '新章节' })
  w = editor.change(w, { type: 'saveQuestion', subjectKey: 'it', chapterKey: 'new', question: q, source })
  const result = editor.prepare(w)
  assert.equal(result.bank.questions.it.length, 3)
  assert.deepEqual(result.sources['DEMO-2'], sample.sources['DEMO-2'])
  assert.equal(result.bank.questions.it.find(x => x.id === 'DEMO-1').subject, 'it')
  assert.deepEqual(data, original)
  assert.deepEqual(w.basePublication, data.basePublication)
})

test('编辑和重命名保持稳定身份，删除非空层级及重复题号拒绝', () => {
  let w = editor.openWorkspace({ draft: null })
  for (const action of [{ type: 'addExam', id: 'a', name: '考试' }, { type: 'addSubject', examId: 'a', subjectKey: 's', name: '科目' },
    { type: 'addChapter', subjectKey: 's', chapterKey: 'c', name: '章节' }, { type: 'saveQuestion', subjectKey: 's', chapterKey: 'c', question: q, source }]) w = editor.change(w, action)
  assert.throws(() => editor.change(w, { type: 'removeExam', id: 'a' }), /EXAM_NOT_EMPTY/)
  assert.throws(() => editor.change(w, { type: 'removeChapter', subjectKey: 's', chapterKey: 'c' }), /CHAPTER_NOT_EMPTY/)
  assert.throws(() => editor.change(w, { type: 'saveQuestion', subjectKey: 's', chapterKey: 'c', question: q, source }), /QUESTION_ID_CONFLICT/)
  w = editor.change(w, { type: 'renameSubject', subjectKey: 's', name: '新科目' })
  w = editor.change(w, { type: 'renameChapter', subjectKey: 's', chapterKey: 'c', name: '新章节' })
  const result = editor.prepare(w)
  assert.equal(result.bank.questions.s[0].subject, 's')
  assert.equal(result.bank.manifest.subjects[0].name, '新科目')
  assert.equal(result.bank.questions.s[0].chapter, require('../shared/exam-catalog-domain.js').chapterIdentity('s', 'c'))
  assert.equal(result.bank.manifest.subjects[0].chapters[0].name, '新章节')
  assert.throws(() => editor.change(w, { type: 'saveQuestion', subjectKey: 's', chapterKey: 'c', existingId: q.id, question: { ...q, id: 'OTHER' }, source }), /QUESTION_ID_IMMUTABLE/)
  w = editor.change(w, { type: 'addChapter', subjectKey: 's', chapterKey: 'other', name: '其他章节' })
  assert.throws(() => editor.change(w, { type: 'saveQuestion', subjectKey: 's', chapterKey: 'other', existingId: q.id, question: q, source }), /QUESTION_SCOPE_IMMUTABLE/)
})

test('缺少新格式声明时导入预检不能静默丢弃考试归属', () => {
  const { preflight } = require('../shared/catalog-import.js')
  const input = copy(sample); input.bank.manifest.exams = [{ id: 'a', name: '考试' }]; input.bank.manifest.subjects[0].examId = 'a'
  const result = preflight(JSON.stringify(input), 'json')
  assert.equal(result.ok, false)
  assert.equal(result.errors[0].code, 'BAD_EXAM_CATALOG')
})
