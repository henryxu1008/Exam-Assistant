/** Protected-mode prototype. Default runtime keeps protection disabled and public routes open. */
const { readOptionalDoc } = require('./db-error.js')
const { TOKEN_TTL } = require('./auth.js')
const paged = require('./paged-catalog-domain.js')
const projection = require('./exam-page-projection.js')
const accessPolicy = require('./exam-access-policy.js')
const subscriptions = require('./subscription-domain.js')
const fail = code => { throw Object.assign(new Error(code), { code }) }
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(value)
const read = (tx, collection, id) => readOptionalDoc(() => tx.collection(collection).doc(id).get())
const POLICY_ID = 'examAccessPolicy'

function createProtectedReader({ db, now = () => Date.now() }) {
  return async (event = {}, context = {}) => {
    try {
      const byQuestion = event.action === 'getProtectedExamQuestion'
      const metadataOnly = event.action === 'getProtectedExamScope'
      const catalogOnly = event.action === 'getProtectedExamCatalog'
      const initial = byQuestion || metadataOnly || catalogOnly || (event.releaseId === undefined && event.index === 0)
      if ((!catalogOnly && !validId(event.examId)) || (byQuestion && !validId(event.questionId)) ||
          (!byQuestion && !metadataOnly && !catalogOnly && ((!initial && !/^qb_[a-f0-9]{64}$/.test(event.releaseId || '')) ||
          !Number.isSafeInteger(event.index) || event.index < 0 || event.index >= paged.limits.MAX_PAGES))) fail('BAD_PAGE_QUERY')
      if (typeof event.token !== 'string' || !event.token || !context.OPENID) fail('INVALID_TOKEN')
      if (!db || typeof db.runTransaction !== 'function') fail('TRANSACTION_REQUIRED')
      const found = await db.collection('users').where({ token: event.token }).limit(1).get()
      const user = found && Array.isArray(found.data) && found.data[0]
      if (!user || !user._id || user.openid !== context.OPENID) fail('INVALID_TOKEN')
      return await db.runTransaction(async tx => {
        const at = now(), identity = await read(tx, 'users', user._id)
        if (!identity || identity.openid !== context.OPENID || identity.token !== event.token || !Number.isSafeInteger(identity.tokenAt) ||
            identity.tokenAt <= 0 || identity.tokenAt > at || at - identity.tokenAt > TOKEN_TTL) fail('INVALID_TOKEN')
        const active = await read(tx, 'questions', 'bank')
        if (!active || active.schemaVersion !== 4 || !paged.validRoot(active.root) ||
            !Number.isSafeInteger(active.publicationRevision) || active.publicationRevision < 1) fail('INVALID_RELEASE')
        if (!initial && active.root.releaseId !== event.releaseId) fail('STALE_RELEASE')
        const policy = await read(tx, 'appConfig', POLICY_ID)
        if (!accessPolicy.validPolicy(active.root, active.publicationRevision, policy)) fail('INVALID_ACCESS_POLICY')
        if (catalogOnly) return { ok: true, exams: active.root.manifest.exams, subjects: active.root.manifest.subjects,
          releaseId: active.root.releaseId, publicationRevision: active.publicationRevision }
        const scope = projection.examScope(active.root, event.examId)
        const rule = policy.entries.find(entry => entry.examId === event.examId)
        if (!rule) fail('INVALID_ACCESS_POLICY')
        if (metadataOnly) return { ok: true, scope, publicationRevision: active.publicationRevision }
        if (rule.access === 'paid') {
          const timeline = await read(tx, 'commerceTimelines', subscriptions.timelineId(context.OPENID, event.examId))
          if (subscriptions.activeUntil(timeline, context.OPENID, event.examId, at) === null) fail('ENTITLEMENT_REQUIRED')
        }
        const index = byQuestion ? paged.findPageIndex(active.root, event.questionId) : event.index
        if (index < 0) fail('QUESTION_UNAVAILABLE')
        if (index >= scope.sourcePageCount) fail('BAD_PAGE_QUERY')
        const releaseId = active.root.releaseId
        const archive = await read(tx, 'questions', releaseId)
        if (!archive || archive.kind !== 'pagedQuestionBankRelease' || !paged.validRoot(archive.root) ||
            archive.root.releaseId !== active.root.releaseId || !Number.isSafeInteger(archive.publishedAt) || archive.publishedAt < 0) fail('INVALID_RELEASE')
        const stored = await read(tx, 'questions', paged.pageDocumentId(releaseId, index))
        if (!stored || stored.kind !== 'pagedQuestionBankPage' || !stored.page || stored.page.index !== index) fail('INVALID_PUBLISHED_PAGE')
        const page = projection.projectPage(active.root, stored.page, event.examId)
        if (byQuestion) {
          const position = page.questions.findIndex(q => q.id === event.questionId)
          if (position < 0) fail('QUESTION_UNAVAILABLE')
          return { ok: true, scope, question: page.questions[position], cursor: { pageIndex: index, position }, publicationRevision: active.publicationRevision }
        }
        return { ok: true, scope, page, publicationRevision: active.publicationRevision }
      })
    } catch (e) { return { ok: false, error: /^[A-Z_]+$/.test(e.code || '') ? e.code : 'PROTECTED_READ_FAILED' } }
  }
}
module.exports = { createProtectedReader, POLICY_ID }
