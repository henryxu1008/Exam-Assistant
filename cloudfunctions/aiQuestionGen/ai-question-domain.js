/** Validation for bounded, untrusted AI-generated catalog candidates. */
const domain = require('./question-domain.js')
const { chapterIdentity } = require('./exam-catalog-domain.js')
const fail = code => { throw Object.assign(new Error(code), { code }) }
const label = (v, n) => typeof v === 'string' && v.trim().length > 0 && v.length <= n
const key = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(v) && !['__proto__', 'constructor', 'prototype'].includes(v)
function validateRequest(v) {
  if (!v || !key(v.subjectKey) || !key(v.chapterKey) || !key(v.requestId) || !label(v.examName, 160) || !label(v.subjectName, 160) ||
      !label(v.chapterName, 160) || !label(v.topic, 300) || !['single', 'multiple', 'judge'].includes(v.type) ||
      ![1, 2, 3].includes(v.level) || !Number.isSafeInteger(v.count) || v.count < 1 || v.count > 5) fail('BAD_AI_REQUEST')
  return { subjectKey: v.subjectKey, chapterKey: v.chapterKey, requestId: v.requestId, examName: v.examName, subjectName: v.subjectName,
    chapterName: v.chapterName, topic: v.topic, type: v.type, level: v.level, count: v.count }
}
function normalize(raw, request, owner) {
  const spec = validateRequest(request)
  if (!label(owner, 160) || !Array.isArray(raw) || raw.length !== spec.count) fail('BAD_AI_RESPONSE')
  const seen = new Set()
  return raw.map((item, index) => {
    if (!item || item.type !== spec.type || item.level !== spec.level || !label(item.stem, 2000) || !label(item.explain, 2000) ||
        !Array.isArray(item.options) || item.options.length < 2 || item.options.length > 6 ||
        item.options.some(o => !o || !label(o.text, 500)) || !Array.isArray(item.answer)) fail('BAD_AI_RESPONSE')
    const normalizedStem = item.stem.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase()
    if (seen.has(normalizedStem)) fail('DUPLICATE_AI_QUESTION')
    seen.add(normalizedStem)
    if (spec.type === 'multiple' && item.answer.length < 2) fail('BAD_AI_RESPONSE')
    if (spec.type === 'judge' && item.options.length !== 2) fail('BAD_AI_RESPONSE')
    try {
      return domain.versionQuestion({ id: 'AI_' + domain.sha256(JSON.stringify([owner, spec.requestId, index])).slice(0, 32),
        subject: spec.subjectKey, chapter: chapterIdentity(spec.subjectKey, spec.chapterKey), type: spec.type, stem: item.stem,
        options: item.options.map(o => ({ key: o.key, text: o.text })), answer: item.answer, explain: item.explain,
        pitfall: '', keyPoint: spec.topic, tags: [], level: spec.level })
    } catch (e) { /* swallow: invalid untrusted model output is reported as a failed batch. */ fail('BAD_AI_RESPONSE') }
  })
}
function validateCandidates(result, request, owner) {
  if (!result || !label(result.generator, 160) || !Array.isArray(result.questions)) fail('BAD_AI_RESPONSE')
  const normalized = normalize(result.questions, request, owner)
  if (domain.canonical(normalized) !== domain.canonical(result.questions)) fail('BAD_AI_RESPONSE')
  return { questions: normalized, generator: result.generator }
}
module.exports = { validateRequest, normalize, validateCandidates }
