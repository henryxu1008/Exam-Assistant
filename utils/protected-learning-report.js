/** Derive content-free exam, subject, chapter and wrong-question summaries from confirmed facts. */
const fail = code => { throw Object.assign(new Error(code), { code }) }
const groupKey = (...parts) => JSON.stringify(parts)
const rate = (correct, total) => total ? Math.round(correct * 100 / total) : 0
const DAY = 86400000
const REVIEW_DAYS = [1, 3, 7, 14, 30]
function buildProtectedLearningReport(examId, history, markers = { revision: 0, entries: [] }, now = Date.now()) {
  if (!history || !Array.isArray(history.attempts) || !Number.isSafeInteger(history.snapshotSequence) || history.snapshotSequence !== history.attempts.length ||
      !Number.isSafeInteger(history.correct)) fail('INVALID_PROTECTED_HISTORY')
  if (!markers || !Array.isArray(markers.entries) || !Number.isSafeInteger(markers.revision) || markers.revision < 0 ||
      new Set(markers.entries.map(row => row.questionId)).size !== markers.entries.length ||
      markers.entries.some(row => !row || typeof row.questionId !== 'string' || typeof row.starred !== 'boolean' || typeof row.mastered !== 'boolean')) fail('INVALID_PROTECTED_STATE')
  const flags = new Map(markers.entries.map(row => [row.questionId, row]))
  const subjects = new Map(), chapters = new Map(), questions = new Map(), ids = new Set(), daily = new Map()
  let correct = 0, index = 0
  for (const fact of history.attempts) {
    index++
    if (!fact || fact.examId !== examId || typeof fact.id !== 'string' || ids.has(fact.id) || fact.sequence !== index ||
        ![0, 1].includes(fact.score) || typeof fact.subject !== 'string' || !fact.subject || typeof fact.chapter !== 'string' || !fact.chapter ||
        typeof fact.questionId !== 'string' || !fact.questionId || typeof fact.questionVersionId !== 'string' || !Number.isSafeInteger(fact.createdAt) || fact.createdAt < 0) fail('INVALID_PROTECTED_HISTORY')
    ids.add(fact.id); correct += fact.score
    const sKey = fact.subject, cKey = groupKey(fact.subject, fact.chapter), qKey = groupKey(fact.subject, fact.chapter, fact.questionId)
    if (!subjects.has(sKey)) subjects.set(sKey, { subject: fact.subject, attempts: 0, correct: 0 })
    if (!chapters.has(cKey)) chapters.set(cKey, { key: cKey, subject: fact.subject, chapter: fact.chapter, attempts: 0, correct: 0 })
    if (!questions.has(qKey)) questions.set(qKey, { key: qKey, subject: fact.subject, chapter: fact.chapter, questionId: fact.questionId,
      attempts: 0, correct: 0, wrong: 0, lastWrongAt: 0, lastWrongVersion: '', lastAt: 0, consecutiveCorrect: 0 })
    for (const item of [subjects.get(sKey), chapters.get(cKey), questions.get(qKey)]) { item.attempts++; item.correct += fact.score }
    const question = questions.get(qKey)
    question.lastAt = fact.createdAt
    question.consecutiveCorrect = fact.score ? question.consecutiveCorrect + 1 : 0
    if (!fact.score) { question.wrong++; question.lastWrongAt = fact.createdAt; question.lastWrongVersion = fact.questionVersionId }
    const date = new Date(fact.createdAt), day = [date.getFullYear(), date.getMonth() + 1, date.getDate()].join('-')
    const count = daily.get(day) || { total: 0, correct: 0 }; count.total++; count.correct += fact.score; daily.set(day, count)
  }
  if (correct !== history.correct) fail('INVALID_PROTECTED_HISTORY')
  const enrich = item => ({ ...item, wrong: item.attempts - item.correct, rate: rate(item.correct, item.attempts) })
  const questionRows = [...questions.values()].map(item => {
    const flag = flags.get(item.questionId) || { starred: false, mastered: false }
    const dueAt = item.wrong ? item.lastAt + REVIEW_DAYS[Math.min(Math.max(0, item.consecutiveCorrect - 1), REVIEW_DAYS.length - 1)] * DAY : 0
    return { ...item, starred: flag.starred, mastered: flag.mastered, dueAt, due: !!dueAt && dueAt <= now && !flag.mastered }
  })
  const wrongs = questionRows.filter(item => item.wrong > 0).sort((a, b) => b.lastWrongAt - a.lastWrongAt || (a.key < b.key ? -1 : 1))
  const trend = []
  for (let n = 6; n >= 0; n--) {
    const date = new Date(now); date.setHours(12, 0, 0, 0); date.setDate(date.getDate() - n)
    const day = [date.getFullYear(), date.getMonth() + 1, date.getDate()].join('-'), count = daily.get(day) || { total: 0, correct: 0 }
    trend.push({ date: day, ...count, rate: rate(count.correct, count.total) })
  }
  return { examId, total: index, correct, wrong: index - correct, rate: rate(correct, index),
    subjects: [...subjects.values()].map(enrich), chapters: [...chapters.values()].map(enrich), wrongs, questions: questionRows, trend, markerRevision: markers.revision }
}
module.exports = { buildProtectedLearningReport }
