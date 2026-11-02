/** Immutable submission content and provenance. Declarations are evidence records, not legal verification. */
const domain = require('./question-domain.js')
const fail = code => { throw Object.assign(new Error(code), { code }) }
const text = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max
function sourcesFor(bank, input) {
  const ids = Object.values(bank.questions).flat().map(q => q.id), sources = {}
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== ids.length) fail('BAD_SOURCES')
  for (const id of ids) {
    if (!Object.prototype.hasOwnProperty.call(input, id)) fail('BAD_SOURCES')
    const s = input[id]
    if (!s || !['original', 'licensed', 'public_domain', 'ai_generated'].includes(s.kind) ||
        !['title', 'reference', 'permission', 'attribution'].every(k => text(s[k], 1000))) fail('BAD_SOURCES')
    if (s.kind === 'ai_generated' && !text(s.generator, 160)) fail('BAD_SOURCES')
    sources[id] = { kind: s.kind, title: s.title, reference: s.reference, permission: s.permission, attribution: s.attribution,
      ...(s.kind === 'ai_generated' ? { generator: s.generator } : {}) }
  }
  if (encodeURIComponent(domain.canonical(sources)).replace(/%[A-F0-9]{2}/g, 'x').length > 160000) fail('SOURCES_TOO_LARGE')
  return sources
}
const draftAddress = (actor, submissionId) => 'qd_' + domain.sha256(JSON.stringify([actor, submissionId]))
const validBase = base => base && Number.isSafeInteger(base.revision) && base.revision >= 1 && /^qb_[a-f0-9]{64}$/.test(base.releaseId || '')
const payloadDigest = (bank, sources, basePublication) => domain.sha256(domain.canonical({ releaseId: bank.releaseId, sources, ...(basePublication ? { basePublication } : {}) }))
function submission(event, actor) {
  if (typeof event.submissionId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(event.submissionId)) fail('BAD_SUBMISSION_ID')
  if (event.rightsConfirmed !== true) fail('RIGHTS_CONFIRMATION_REQUIRED')
  const bank = domain.buildRelease(event.bank), sources = sourcesFor(bank, event.sources)
  if (event.basePublication !== undefined && !validBase(event.basePublication)) fail('BAD_BASE_PUBLICATION')
  const basePublication = event.basePublication ? { revision: event.basePublication.revision, releaseId: event.basePublication.releaseId } : undefined
  return { kind: 'bankDraft', draftId: draftAddress(actor, event.submissionId), submissionId: event.submissionId,
    bank, sources, ...(basePublication ? { basePublication } : {}), payloadDigest: payloadDigest(bank, sources, basePublication), createdBy: actor, rightsConfirmed: true }
}
function validDraft(draft) {
  try {
    return draft && draft.kind === 'bankDraft' && domain.validRelease(draft.bank) && draft.rightsConfirmed === true &&
      typeof draft.submissionId === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(draft.submissionId) && text(draft.createdBy, 160) &&
      draft.draftId === draftAddress(draft.createdBy, draft.submissionId) &&
      domain.canonical(draft.sources) === domain.canonical(sourcesFor(draft.bank, draft.sources)) &&
      (draft.basePublication === undefined || validBase(draft.basePublication)) &&
      draft.payloadDigest === payloadDigest(draft.bank, draft.sources, draft.basePublication)
  } catch (e) { /* swallow: pure validation rejects malformed stored evidence; no I/O is hidden. */ return false }
}
function validRoles(roles) {
  return roles && ['editors', 'reviewers', 'publishers'].every(role => Array.isArray(roles[role]) &&
    roles[role].length <= 100 && roles[role].every(id => text(id, 160)) && new Set(roles[role]).size === roles[role].length)
}
module.exports = { submission, validDraft, validRoles, sourcesFor }
