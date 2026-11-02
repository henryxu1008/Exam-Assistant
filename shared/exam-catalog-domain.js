/** Versioned exam ownership for catalog releases. No storage or network access. */
const domain = require('./question-domain.js')
const fail = code => { throw Object.assign(new Error(code), { code }) }
const validKey = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value)
const validName = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 160 && !['__proto__', 'constructor', 'prototype'].includes(value)

/** v3 has explicit exam ownership; v2 remains under the existing domain and is never rewritten. */
function buildExamRelease(input) {
  if (!input || input.schemaVersion !== 3 || !input.manifest || !Array.isArray(input.manifest.exams) ||
      !Array.isArray(input.manifest.subjects) || !input.questions) fail('BAD_EXAM_CATALOG')
  const exams = [], ids = new Set(), names = new Set()
  if (!input.manifest.exams.length || input.manifest.exams.length > 30) fail('BAD_EXAMS')
  for (const exam of input.manifest.exams) {
    if (!exam || !validKey(exam.id) || !validName(exam.name) || ids.has(exam.id) || names.has(exam.name)) fail('BAD_EXAMS')
    ids.add(exam.id); names.add(exam.name); exams.push({ id: exam.id, name: exam.name })
  }
  for (const subject of input.manifest.subjects) if (!subject || !ids.has(subject.examId)) fail('BAD_EXAM_OWNERSHIP')
  // Delegate all existing question, scope, identifier and size checks to the existing v2 validator.
  const oldShape = domain.buildRelease({ manifest: { subjects: input.manifest.subjects }, questions: input.questions })
  const subjects = oldShape.manifest.subjects.map((subject, index) => ({ ...subject, examId: input.manifest.subjects[index].examId }))
  const bank = { schemaVersion: 3, manifest: { version: 2, exams, subjects }, questions: oldShape.questions }
  if (encodeURIComponent(domain.canonical(bank)).replace(/%[A-F0-9]{2}/g, 'x').length > 600000) fail('BANK_TOO_LARGE')
  return { ...bank, releaseId: 'qb_' + domain.sha256(domain.canonical(bank)) }
}

function validExamRelease(bank) {
  try {
    const built = buildExamRelease(bank)
    return bank.schemaVersion === 3 && bank.releaseId === built.releaseId &&
      domain.canonical(bank.manifest) === domain.canonical(built.manifest) && domain.canonical(bank.questions) === domain.canonical(built.questions)
  } catch (e) { /* swallow: pure validation rejects malformed input; no database read occurs. */ return false }
}
module.exports = { buildExamRelease, validExamRelease }
