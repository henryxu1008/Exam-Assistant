/** Derive content-free exam, subject, chapter and wrong-question summaries from confirmed facts. */
const fail = code => { throw Object.assign(new Error(code), { code }) }
const groupKey = (...parts) => JSON.stringify(parts)
const rate = (correct, total) => total ? Math.round(correct * 100 / total) : 0
function buildProtectedLearningReport(examId, history) {
  if (!history || !Array.isArray(history.attempts) || !Number.isSafeInteger(history.snapshotSequence) || history.snapshotSequence !== history.attempts.length ||
      !Number.isSafeInteger(history.correct)) fail('INVALID_PROTECTED_HISTORY')
  const subjects = new Map(), chapters = new Map(), questions = new Map(), ids = new Set()
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
      attempts: 0, correct: 0, wrong: 0, lastWrongAt: 0, lastWrongVersion: '' })
    for (const item of [subjects.get(sKey), chapters.get(cKey), questions.get(qKey)]) { item.attempts++; item.correct += fact.score }
    if (!fact.score) { const q = questions.get(qKey); q.wrong++; q.lastWrongAt = fact.createdAt; q.lastWrongVersion = fact.questionVersionId }
  }
  if (correct !== history.correct) fail('INVALID_PROTECTED_HISTORY')
  const enrich = item => ({ ...item, wrong: item.attempts - item.correct, rate: rate(item.correct, item.attempts) })
  const wrongs = [...questions.values()].filter(item => item.wrong > 0).sort((a, b) => b.lastWrongAt - a.lastWrongAt || (a.key < b.key ? -1 : 1))
  return { examId, total: index, correct, wrong: index - correct, rate: rate(correct, index),
    subjects: [...subjects.values()].map(enrich), chapters: [...chapters.values()].map(enrich), wrongs }
}
module.exports = { buildProtectedLearningReport }
