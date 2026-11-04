const { runtimeProtectedStudyClient } = require('./protected-study-client.js')
const { runtimeProtectedStudySession } = require('./protected-study-session.js')
const { runtimeProtectedPracticeClient } = require('./protected-practice-client.js')
const { buildProtectedLearningReport } = require('./protected-learning-report.js')
const { chapterIdentity } = require('../shared/exam-catalog-domain.js')
const { currentExam } = require('./protected-catalog.js')
const { runtimeProtectedMarkerClient } = require('./protected-marker-client.js')
const { canonical } = require('../shared/question-domain.js')
const fail = code => { throw Object.assign(new Error(code), { code }) }
function createProtectedReportLoader({ client, reader, session, getExam, markers }) {
  function capture() {
    const context = session.capture(), examId = getExam()
    if (!examId) fail('EXAM_NOT_FOUND')
    return { context, examId }
  }
  function current(ctx) { try { return !!ctx && session.current(ctx.context) && getExam() === ctx.examId } catch (e) { return false } }
  async function load(ctx) {
    if (!current(ctx)) fail('STALE_CONTEXT')
    const state = markers ? await markers.get(ctx.examId, ctx.context, session.current) : { revision: 0, entries: [] }
    if (!current(ctx)) fail('STALE_CONTEXT')
    const [history, scope] = await Promise.all([client.restore(ctx.examId, ctx.context.dataEpoch, ctx.context.identity), reader.scope(ctx.examId, ctx.context.identity)])
    if (!current(ctx)) fail('STALE_CONTEXT')
    if (markers) {
      const after = await markers.get(ctx.examId, ctx.context, session.current)
      if (!current(ctx)) fail('STALE_CONTEXT')
      if (after.revision !== state.revision || canonical(after.entries) !== canonical(state.entries)) fail('SNAPSHOT_CHANGED')
    }
    const report = buildProtectedLearningReport(ctx.examId, history, state), subjects = new Map(scope.subjects.map(subject => [subject.key, subject]))
    const labelSubject = key => subjects.has(key) ? subjects.get(key).name : '已移除科目'
    const labelChapter = (subject, chapter) => {
      const entry = subjects.get(subject), found = entry && entry.chapters.find(c => chapterIdentity(subject, c.key) === chapter)
      return found ? found.name : '已移除章节'
    }
    return { ...report, examName: scope.exam.name, releaseId: scope.releaseId, publicationRevision: scope.publicationRevision,
      subjects: report.subjects.map(item => ({ ...item, label: labelSubject(item.subject) })),
      chapters: report.chapters.map(item => ({ ...item, subjectLabel: labelSubject(item.subject), label: labelChapter(item.subject, item.chapter) })),
      wrongs: report.wrongs.map(item => ({ ...item, subjectLabel: labelSubject(item.subject), chapterLabel: labelChapter(item.subject, item.chapter) })),
      questions: report.questions.map(item => ({ ...item, subjectLabel: labelSubject(item.subject), chapterLabel: labelChapter(item.subject, item.chapter) })) }
  }
  return { capture, current, load }
}
function runtimeProtectedReportLoader() {
  return createProtectedReportLoader({ client: runtimeProtectedStudyClient(), reader: runtimeProtectedPracticeClient(), session: runtimeProtectedStudySession(), getExam: currentExam, markers: runtimeProtectedMarkerClient() })
}
module.exports = { createProtectedReportLoader, runtimeProtectedReportLoader }
