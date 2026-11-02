/** Minimal catalog operator client. Server roles remain authoritative; no token enters reports or payload previews. */
const config = require('./config.js')
const domain = require('../shared/question-domain.js')
const examDomain = require('../shared/exam-catalog-domain.js')
const paged = require('../shared/paged-catalog-domain.js')
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
  async function pagedBase(ctx) {
    const latest = await request({ action: 'getPagedPublished' }, ctx)
    if (latest.root) {
      if (!paged.validRoot(latest.root) || !Number.isSafeInteger(latest.publicationRevision) || latest.publicationRevision < 1) fail('INVALID_RELEASE')
      return { revision: latest.publicationRevision, releaseId: latest.root.releaseId }
    }
    if (latest.publicationRevision === 0) return null
    const prior = await request({ action: 'getExamPublished' }, ctx)
    if (!prior.bank || !examDomain.validExamRelease(prior.bank) || prior.publicationRevision !== latest.publicationRevision) fail('LEGACY_IDENTITY_MIGRATION_REQUIRED')
    return { revision: prior.publicationRevision, releaseId: prior.bank.releaseId }
  }
  function preparePaged(text) {
    if (typeof text !== 'string' || encodeURIComponent(text).replace(/%[A-F0-9]{2}/g, 'x').length > 12000000) fail('INPUT_TOO_LARGE_FOR_PAGE')
    let input
    try { input = JSON.parse(text.replace(/^\uFEFF/, '')) } catch (e) { fail('BAD_JSON') }
    const bank = input && (input.bank || input)
    return paged.buildPagedCatalog({ ...bank, sources: input && input.sources })
  }
  async function submitPaged(prepared, options, ctx, live = () => true) {
    if (!options || options.rightsConfirmed !== true) fail('RIGHTS_CONFIRMATION_REQUIRED')
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(options.submissionId || '')) fail('BAD_SUBMISSION_ID')
    if (!prepared || !paged.validComplete(prepared.root, prepared.evidence, prepared.publicPages, prepared.privatePages)) fail('BAD_PAGED_CATALOG')
    const guard = () => { if (!live() || !current(ctx)) fail('STALE_OPERATOR_CONTEXT') }
    guard()
    const initial = await request({ action: 'beginPagedDraft', root: prepared.root, evidence: prepared.evidence,
      basePublication: options.basePublication, submissionId: options.submissionId, rightsConfirmed: true }, ctx)
    guard()
    if (initial.state === 'uploading') {
      if (options.onStarted) options.onStarted(initial.draftId, prepared.publicPages.length)
      for (let index = 0; index < prepared.publicPages.length; index++) {
        guard()
        await request({ action: 'uploadPagedDraftPage', draftId: initial.draftId, page: prepared.publicPages[index], sourcePage: prepared.privatePages[index] }, ctx)
        guard()
        if (options.onProgress) options.onProgress(index + 1, prepared.publicPages.length, initial.draftId)
      }
      return request({ action: 'sealPagedDraft', draftId: initial.draftId }, ctx)
    }
    if (['sealed', 'approved', 'published'].includes(initial.state)) return initial
    fail('DRAFT_NOT_EDITABLE')
  }
  return {
    capture, current, preflight,
    access: () => request({ action: 'getCatalogAccess' }, capture()),
    published: () => request({ action: 'getPublished' }, capture()),
    activeDraft: () => request({ action: 'getActiveCatalogDraft' }, capture()),
    preparePaged,
    pagedCurrent: () => request({ action: 'getPagedPublished' }, capture()),
    pagedBase: () => pagedBase(capture()),
    async activePagedWorkspace(live = () => true) {
      const ctx = capture(), guard = () => { if (!live() || !current(ctx)) fail('STALE_OPERATOR_CONTEXT') }
      guard()
      const active = await request({ action: 'getActivePagedDraft' }, ctx)
      if (!paged.validRoot(active.root) || !paged.validEvidence(active.root, active.evidence) || !active.basePublication ||
          active.basePublication.releaseId !== active.root.releaseId || !Number.isSafeInteger(active.basePublication.revision) || active.basePublication.revision < 1) fail('INVALID_PUBLISHED_DRAFT')
      const publicPages = [], privatePages = []
      for (const descriptor of active.root.pages) {
        guard()
        const result = await request({ action: 'getPagedDraftPage', draftId: active.draftId, index: descriptor.index }, ctx)
        guard()
        if (!paged.validPagePair(active.root, active.evidence, result.page, result.sourcePage) || result.page.index !== descriptor.index) fail('INVALID_PAGED_PAGE')
        publicPages.push(result.page); privatePages.push(result.sourcePage)
      }
      if (!paged.validComplete(active.root, active.evidence, publicPages, privatePages)) fail('INVALID_PAGED_RELEASE')
      const latest = await pagedBase(ctx); guard()
      if (!latest || latest.revision !== active.basePublication.revision || latest.releaseId !== active.basePublication.releaseId) fail('STALE_BASE_RELEASE')
      const questions = Object.fromEntries(active.root.manifest.subjects.map(s => [s.key, []])), sources = {}
      for (let i = 0; i < publicPages.length; i++) for (const q of publicPages[i].questions) {
        questions[q.subject].push(q); sources[q.id] = privatePages[i].sources[q.id]
      }
      return { bank: { schemaVersion: 4, manifest: copy(active.root.manifest), questions }, sources, basePublication: active.basePublication }
    },
    submitPaged: (prepared, options, live) => submitPaged(prepared, options, capture(), live),
    getPagedDraft: draftId => request({ action: 'getPagedDraft', draftId }, capture()),
    abandonPagedDraft: draftId => request({ action: 'abandonPagedDraft', draftId }, capture()),
    getPagedDraftPage: (draftId, index) => request({ action: 'getPagedDraftPage', draftId, index }, capture()),
    reviewPaged: ({ draftId, decision, note, sourceVerified }) => request({ action: 'reviewPagedDraft', draftId, decision, note, sourceVerified: sourceVerified === true }, capture()),
    publishPaged: ({ draftId, expectedRevision }) => request({ action: 'publishPagedDraft', draftId, expectedRevision }, capture()),
    async withdrawPaged({ draftId, questionIds, submissionId, rightsConfirmed }, live = () => true) {
      const ctx = capture(), guard = () => { if (!live() || !current(ctx)) fail('STALE_OPERATOR_CONTEXT') }
      if (rightsConfirmed !== true) fail('RIGHTS_CONFIRMATION_REQUIRED')
      if (!Array.isArray(questionIds) || !questionIds.length || questionIds.some(id => typeof id !== 'string' || !id) || new Set(questionIds).size !== questionIds.length) fail('BAD_WITHDRAWAL_IDS')
      guard()
      const result = await request({ action: 'getPagedDraft', draftId }, ctx), draft = result.draft
      if (!draft || draft.state !== 'published' || !paged.validRoot(draft.root) || !paged.validEvidence(draft.root, draft.evidence)) fail('BASE_NOT_PUBLISHED')
      const base = await pagedBase(ctx)
      if (!base || base.releaseId !== draft.root.releaseId || base.revision !== draft.publicationRevision) fail('STALE_BASE_RELEASE')
      const publicPages = [], privatePages = []
      for (const descriptor of draft.root.pages) {
        guard()
        const page = await request({ action: 'getPagedDraftPage', draftId, index: descriptor.index }, ctx)
        if (!paged.validPagePair(draft.root, draft.evidence, page.page, page.sourcePage) || page.page.index !== descriptor.index) fail('INVALID_PAGED_PAGE')
        publicPages.push(page.page); privatePages.push(page.sourcePage)
      }
      guard()
      if (!paged.validComplete(draft.root, draft.evidence, publicPages, privatePages)) fail('INVALID_PAGED_RELEASE')
      const remove = new Set(questionIds), remaining = Object.fromEntries(draft.root.manifest.subjects.map(s => [s.key, []])), sources = {}
      for (let i = 0; i < publicPages.length; i++) for (const q of publicPages[i].questions) {
        if (remove.has(q.id)) { remove.delete(q.id); continue }
        remaining[q.subject].push(q); sources[q.id] = privatePages[i].sources[q.id]
      }
      if (remove.size) fail('UNKNOWN_QUESTION_ID')
      const prepared = paged.buildPagedCatalog({ schemaVersion: 4, manifest: draft.root.manifest, questions: remaining, sources })
      return submitPaged(prepared, { submissionId, rightsConfirmed, basePublication: base }, ctx, live)
    },
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
