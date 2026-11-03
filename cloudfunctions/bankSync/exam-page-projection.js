/** Pure per-exam projection of a verified v4 publication. Not an authorization or publishing API. */
const paged = require('./paged-catalog-domain.js')
const fail = code => { throw Object.assign(new Error(code), { code }) }
const clone = value => JSON.parse(JSON.stringify(value))

function examScope(root, examId) {
  if (!paged.validRoot(root)) fail('INVALID_RELEASE')
  const exam = root.manifest.exams.find(item => item.id === examId)
  if (!exam) fail('EXAM_NOT_FOUND')
  return { exam: clone(exam), subjects: clone(root.manifest.subjects.filter(subject => subject.examId === examId)),
    releaseId: root.releaseId, sourcePageCount: root.pages.length }
}

function projectPage(root, page, examId) {
  const scope = examScope(root, examId)
  if (!paged.validQuestionPage(root, page)) fail('INVALID_PUBLISHED_PAGE')
  const allowed = new Set(scope.subjects.map(subject => subject.key))
  // Validate the complete stored page before projecting; never return another exam's rows.
  return { releaseId: scope.releaseId, examId: scope.exam.id, index: page.index,
    questions: clone(page.questions.filter(question => allowed.has(question.subject))) }
}

module.exports = { examScope, projectPage }
