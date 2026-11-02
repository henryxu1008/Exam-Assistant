/** Shared objective marking rules; no storage/network. Versioned facts require published evidence. */
const questionDomain = require('./question-domain.js')
const QUESTION_PROTOCOL = 2
const MAX_VERSIONED_BATCH = 24
// Stop this sync round; a later external trigger may retry after content/configuration is repaired.
const NON_RETRYABLE_ERRORS = ['PUBLISHED_RELEASE_REQUIRED', 'PUBLISHED_RELEASE_NOT_FOUND', 'INVALID_PUBLISHED_RELEASE',
  'PUBLISHED_QUESTION_NOT_FOUND', 'QUESTION_EVIDENCE_MISMATCH', 'BAD_SELECTION', 'GRADE_MISMATCH', 'INVALID_STORED_GRADING']
const normalizeText = value => String(value === undefined || value === null ? '' : value).replace(/\s+/g, '').toLowerCase()
function judge(type, selected, answer) {
  const sel = Array.isArray(selected) ? selected.slice() : [], ans = Array.isArray(answer) ? answer.slice() : []
  if (type === 'fill') return sel.length === ans.length && ans.every((expect, i) => {
    const got = normalizeText(sel[i])
    return !!got && (Array.isArray(expect) ? expect : [expect]).some(value => normalizeText(value) === got)
  })
  if (type === 'sort') return sel.length === ans.length && ans.every((key, i) => String(key) === String(sel[i]))
  return sel.length === ans.length && ans.every(key => sel.indexOf(key) > -1)
}
const isVersioned = attempt => !!attempt && (attempt.questionSnapshot !== undefined || attempt.bankReleaseId !== undefined || /^qv_/.test(attempt.questionVersionId || ''))
function validSelection(question, selected) {
  if (!Array.isArray(selected) || !selected.length || selected.length > 30 || selected.some(value => typeof value !== 'string' || value.length > 10000)) return false
  if (question.type === 'fill') return selected.length === question.answer.length && selected.every(value => normalizeText(value).length > 0)
  const options = new Set(question.options.map(option => option.key))
  return new Set(selected).size === selected.length && selected.every(value => options.has(value)) &&
    (!['single', 'judge'].includes(question.type) || selected.length === 1) &&
    (question.type !== 'sort' || selected.length === question.answer.length)
}
function validGrading(fact) {
  const g = fact && fact.grading, q = questionDomain.attemptQuestion(fact)
  return !!g && !!q && g.version === 1 && g.judgeVersion === 1 && g.source === 'published_archive' &&
    g.releaseId === fact.bankReleaseId && g.questionVersionId === fact.questionVersionId && /^qb_[a-f0-9]{64}$/.test(g.releaseId || '') &&
    g.score === fact.score && Number.isSafeInteger(fact.serverReceivedAt) && fact.serverReceivedAt >= 0 &&
    validSelection(q, fact.selected) && g.score === (judge(q.type, fact.selected, q.answer) ? 1 : 0)
}
module.exports = { QUESTION_PROTOCOL, MAX_VERSIONED_BATCH, NON_RETRYABLE_ERRORS, normalizeText, judge, isVersioned, validSelection, validGrading }
