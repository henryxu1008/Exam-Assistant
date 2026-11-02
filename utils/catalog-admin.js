/** Minimal catalog operator client. Server roles remain authoritative; no token enters reports or payload previews. */
const config = require('./config.js')
const domain = require('../shared/question-domain.js')
const examDomain = require('../shared/exam-catalog-domain.js')
const { sourcesFor } = require('../shared/workflow-domain.js')
const { preflight } = require('../shared/catalog-import.js')
const fail = code => { throw Object.assign(new Error(code), { code }) }
const copy = v => JSON.parse(JSON.stringify(v))
function createCatalogAdmin({ getSession, call }) {
  function capture() {
    const s = getSession()
    if (!s || !s.logged || typeof s.token !== 'string' || !s.token || typeof s.openid !== 'string' || !s.openid) fail('NO_TOKEN')
    return { token: s.token, openid: s.openid }
  }
  function current(ctx) { try { const now = capture(); return now.token === ctx.token && now.openid === ctx.openid } catch (e) { return false } }
  async function request(data, ctx) {
    if (!current(ctx)) fail('STALE_OPERATOR_CONTEXT')
    let result
    try { result = await call({ ...data, token: ctx.token }) } catch (e) { fail('NETWORK_ERROR') }
    if (!current(ctx)) fail('STALE_OPERATOR_CONTEXT')
    if (!result || result.ok !== true) fail(result && /^[A-Z_]+$/.test(result.error || '') ? result.error : 'INVALID_RESPONSE')
    return result
  }
  async function submit(prepared, options, ctx) {
    if (!options || options.rightsConfirmed !== true) fail('RIGHTS_CONFIRMATION_REQUIRED')
    if (typeof options.submissionId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(options.submissionId)) fail('BAD_SUBMISSION_ID')
    const isExam = prepared && prepared.bank && prepared.bank.schemaVersion === 3
    if (!isExam && prepared && prepared.bank && prepared.bank.manifest && (prepared.bank.manifest.exams !== undefined ||
      (Array.isArray(prepared.bank.manifest.subjects) && prepared.bank.manifest.subjects.some(s => s && s.examId !== undefined)))) fail('EXAM_PROTOCOL_REQUIRED')
    const bank = isExam ? examDomain.buildExamRelease(prepared.bank) : domain.buildRelease(prepared && prepared.bank), sources = sourcesFor(bank, prepared && prepared.sources)
    return request({ action: isExam ? 'createExamDraft' : 'createDraft', bank, sources, rightsConfirmed: true, submissionId: options.submissionId, ...(options.basePublication ? { basePublication: options.basePublication } : {}) }, ctx)
  }
  return {
    capture, current, preflight,
    access: () => request({ action: 'getCatalogAccess' }, capture()),
    published: () => request({ action: 'getPublished' }, capture()),
    activeDraft: () => request({ action: 'getActiveCatalogDraft' }, capture()),
    getDraft: draftId => request({ action: 'getDraft', draftId }, capture()),
    submitDraft: (prepared, options) => submit(prepared, options, capture()),
    review: ({ draftId, decision, note, sourceVerified }) => request({ action: 'reviewDraft', draftId, decision, note, sourceVerified: sourceVerified === true }, capture()),
    publish: ({ draftId, expectedRevision }) => {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) fail('BAD_REVISION')
      return request({ action: 'publishDraft', draftId, expectedRevision }, capture())
    },
    publishExam: ({ draftId, expectedRevision }) => {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) fail('BAD_REVISION')
      return request({ action: 'publishExamDraft', draftId, expectedRevision }, capture())
    },
    async withdraw({ draftId, questionIds, submissionId, rightsConfirmed }) {
      const ctx = capture()
      if (!Array.isArray(questionIds) || !questionIds.length || questionIds.some(id => typeof id !== 'string' || !id) || new Set(questionIds).size !== questionIds.length) fail('BAD_WITHDRAWAL_IDS')
      const base = await request({ action: 'getDraft', draftId }, ctx)
      if (!base.draft || base.draft.state !== 'published' || !(domain.validRelease(base.draft.bank) || examDomain.validExamRelease(base.draft.bank))) fail('BASE_NOT_PUBLISHED')
      const active = await request({ action: base.draft.bank.schemaVersion === 3 ? 'getExamPublished' : 'getPublished' }, ctx)
      if (!active.bank || active.bank.releaseId !== base.draft.bank.releaseId || active.publicationRevision !== base.draft.publicationRevision) fail('STALE_BASE_RELEASE')
      const ids = new Set(Object.values(base.draft.bank.questions).flat().map(q => q.id))
      if (questionIds.some(id => !ids.has(id))) fail('UNKNOWN_QUESTION_ID')
      const remove = new Set(questionIds), bank = copy(base.draft.bank), sources = copy(base.draft.sources)
      for (const key of Object.keys(bank.questions)) bank.questions[key] = bank.questions[key].filter(q => !remove.has(q.id))
      for (const id of remove) delete sources[id]
      return submit({ bank, sources }, { submissionId, rightsConfirmed, basePublication: { revision: active.publicationRevision, releaseId: active.bank.releaseId } }, ctx)
    }
  }
}
function runtimeClient() {
  return createCatalogAdmin({
    getSession: () => wx.getStorageSync('exam_quiz_session_v1'),
    call: data => new Promise((resolve, reject) => {
      if (!wx.__cloudReady || !wx.cloud || typeof wx.cloud.callFunction !== 'function') { reject(new Error('CLOUD_NOT_READY')); return }
      const success = response => resolve(response && response.result)
      try {
        const pending = wx.cloud.callFunction({ name: config.functions.bankSync, data, success, fail: reject })
        if (pending && typeof pending.then === 'function') pending.then(success, reject)
      } catch (e) { reject(e) }
    })
  })
}
module.exports = { createCatalogAdmin, runtimeClient }
