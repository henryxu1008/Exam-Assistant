/** Versioned exam ownership for catalog releases. No storage or network access. */
const domain = require('./question-domain.js')
const fail = code => { throw Object.assign(new Error(code), { code }) }
const validKey = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value)
const validName = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 160 && !['__proto__', 'constructor', 'prototype'].includes(value)
const chapterIdentity = (subjectKey, chapterKey) => 'ch_' + domain.sha256(JSON.stringify([subjectKey, chapterKey]))

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
  const scopedNames = new Set(), normalizedQuestions = {}, normalizedSubjects = []
  for (const subject of input.manifest.subjects) {
    if (!subject || !ids.has(subject.examId)) fail('BAD_EXAM_OWNERSHIP')
    if (!validKey(subject.key) || !validName(subject.name) || !Array.isArray(subject.chapters) || !Array.isArray(input.questions[subject.key])) fail('BAD_MANIFEST')
    if (subject.chapters.some(c => !c || !validKey(c.key) || !validName(c.name)) || new Set(subject.chapters.map(c => c.name)).size !== subject.chapters.length) fail('BAD_MANIFEST')
    const scoped = JSON.stringify([subject.examId, subject.name])
    if (scopedNames.has(scoped)) fail('BAD_MANIFEST')
    scopedNames.add(scoped)
    normalizedSubjects.push({ ...subject, name: subject.key, chapters: subject.chapters.map(c => ({ ...c, name: chapterIdentity(subject.key, c.key) })) })
    normalizedQuestions[subject.key] = input.questions[subject.key].map(q => {
      if (!q || (q.subject !== subject.key && q.subject !== subject.name)) fail('BAD_QUESTION_SCOPE')
      const matches = subject.chapters.filter(c => c && (q.chapter === c.name || q.chapter === c.key || q.chapter === chapterIdentity(subject.key, c.key)))
      if (matches.length !== 1) fail('BAD_QUESTION_SCOPE')
      return { ...q, subject: subject.key, chapter: chapterIdentity(subject.key, matches[0].key) }
    })
  }
  if (Object.keys(input.questions).some(k => !input.manifest.subjects.some(s => s.key === k))) fail('BAD_BANK')
  // Reuse the existing validator with globally unique stable subject IDs as internal names.
  const oldShape = domain.buildRelease({ manifest: { subjects: normalizedSubjects }, questions: normalizedQuestions })
  const subjects = oldShape.manifest.subjects.map((subject, index) => ({ ...subject, name: input.manifest.subjects[index].name,
    chapters: subject.chapters.map((chapter, i) => ({ ...chapter, name: input.manifest.subjects[index].chapters[i].name })), examId: input.manifest.subjects[index].examId }))
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
module.exports = { buildExamRelease, validExamRelease, chapterIdentity }
