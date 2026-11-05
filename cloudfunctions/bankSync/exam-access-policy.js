/** One complete, release-bound policy document; preparing it performs no database writes. */
const paged = require('./paged-catalog-domain.js')
const { canonical, sha256 } = require('./question-domain.js')
const fail = code => { throw Object.assign(new Error(code), { code }) }
const sameKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  canonical(Object.keys(value).sort()) === canonical(keys.slice().sort())

function buildPolicy(root, publicationRevision, entries) {
  if (!paged.validRoot(root) || !Number.isSafeInteger(publicationRevision) || publicationRevision < 1 || !Array.isArray(entries) ||
      entries.length !== root.manifest.exams.length) fail('INVALID_ACCESS_POLICY')
  const expected = new Set(root.manifest.exams.map(exam => exam.id)), seen = new Set()
  const normalized = entries.map(entry => {
    if (!sameKeys(entry, ['examId', 'access']) || !expected.has(entry.examId) || seen.has(entry.examId) || !['free', 'paid'].includes(entry.access)) fail('INVALID_ACCESS_POLICY')
    seen.add(entry.examId)
    return { examId: entry.examId, access: entry.access }
  }).sort((a, b) => a.examId < b.examId ? -1 : a.examId > b.examId ? 1 : 0)
  const value = { kind: 'examAccessPolicy', version: 1, releaseId: root.releaseId, publicationRevision, entries: normalized }
  return { ...value, digest: sha256(canonical(value)) }
}
function validPolicy(root, publicationRevision, policy) {
  try {
    if (!policy || (policy._id !== undefined && policy._id !== 'examAccessPolicy')) return false
    const { _id, ...data } = policy
    if (!sameKeys(data, ['kind', 'version', 'releaseId', 'publicationRevision', 'entries', 'digest'])) return false
    return canonical(buildPolicy(root, publicationRevision, data.entries)) === canonical(data)
  } catch (e) { /* swallow: pure validation rejects invalid policies and performs no I/O. */ return false }
}
module.exports = { buildPolicy, validPolicy }
