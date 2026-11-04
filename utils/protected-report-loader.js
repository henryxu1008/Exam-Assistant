const { runtimeProtectedStudyClient } = require('./protected-study-client.js')
const { runtimeProtectedStudySession } = require('./protected-study-session.js')
const { runtimeProtectedPracticeClient } = require('./protected-practice-client.js')
const { buildProtectedLearningReport } = require('./protected-learning-report.js')
const { chapterIdentity } = require('../shared/exam-catalog-domain.js')
const { currentExam } = require('./protected-catalog.js')
const fail = code => { throw Object.assign(new Error(code), { code }) }
function createProtectedReportLoader({ client, reader, session, getExam }) {
  function capture() {
    const context = session.capture(), examId = getExam()
    if (!examId) fail('EXAM_NOT_FOUND')
    return { context, examId }
  }
  function current(ctx) { try { return !!ctx && session.current(ctx.context) && getExam() === ctx.examId } catch (e) { return false } }
  async function load(ctx) {
    if (!current(ctx)) fail('STALE_CONTEXT')
    const [history, scope] = await Promise.all([client.restore(ctx.examId, ctx.context.dataEpoch, ctx.context.identity), reader.scope(ctx.examId, ctx.context.identity)])
    if (!current(ctx)) fail('STALE_CONTEXT')
    const report = buildProtectedLearningReport(ctx.examId, history), subjects = new Map(scope.subjects.map(subject => [subject.key, subject]))
    const labelSubject = key => subjects.has(key) ? subjects.get(key).name : '已移除科目'
    const labelChapter = (subject, chapter) => {
      const entry = subjects.get(subject), found = entry && entry.chapters.find(c => chapterIdentity(subject, c.key) === chapter)
      return found ? found.name : '已移除章节'
    }
    return { ...report, examName: scope.exam.name,
      subjects: report.subjects.map(item => ({ ...item, label: labelSubject(item.subject) })),
      chapters: report.chapters.map(item => ({ ...item, subjectLabel: labelSubject(item.subject), label: labelChapter(item.subject, item.chapter) })),
      wrongs: report.wrongs.map(item => ({ ...item, subjectLabel: labelSubject(item.subject), chapterLabel: labelChapter(item.subject, item.chapter) })) }
  }
  return { capture, current, load }
}
function runtimeProtectedReportLoader() {
  return createProtectedReportLoader({ client: runtimeProtectedStudyClient(), reader: runtimeProtectedPracticeClient(), session: runtimeProtectedStudySession(), getExam: currentExam })
}
module.exports = { createProtectedReportLoader, runtimeProtectedReportLoader }
