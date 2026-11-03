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
      if (!validId(event.examId) || !/^qb_[a-f0-9]{64}$/.test(event.releaseId || '') ||
          !Number.isSafeInteger(event.index) || event.index < 0 || event.index >= paged.limits.MAX_PAGES) fail('BAD_PAGE_QUERY')
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
        if (active.root.releaseId !== event.releaseId) fail('STALE_RELEASE')
        const scope = projection.examScope(active.root, event.examId)
        const policy = await read(tx, 'appConfig', POLICY_ID)
        if (!accessPolicy.validPolicy(active.root, active.publicationRevision, policy)) fail('INVALID_ACCESS_POLICY')
        const rule = policy.entries.find(entry => entry.examId === event.examId)
        if (!rule) fail('INVALID_ACCESS_POLICY')
        if (rule.access === 'paid') {
          const timeline = await read(tx, 'commerceTimelines', subscriptions.timelineId(context.OPENID, event.examId))
          if (subscriptions.activeUntil(timeline, context.OPENID, event.examId, at) === null) fail('ENTITLEMENT_REQUIRED')
        }
        if (event.index >= scope.sourcePageCount) fail('BAD_PAGE_QUERY')
        const archive = await read(tx, 'questions', event.releaseId)
        if (!archive || archive.kind !== 'pagedQuestionBankRelease' || !paged.validRoot(archive.root) ||
            archive.root.releaseId !== active.root.releaseId || !Number.isSafeInteger(archive.publishedAt) || archive.publishedAt < 0) fail('INVALID_RELEASE')
        const stored = await read(tx, 'questions', paged.pageDocumentId(event.releaseId, event.index))
        if (!stored || stored.kind !== 'pagedQuestionBankPage' || !stored.page || stored.page.index !== event.index) fail('INVALID_PUBLISHED_PAGE')
        const page = projection.projectPage(active.root, stored.page, event.examId)
        return { ok: true, scope, page, publicationRevision: active.publicationRevision }
      })
    } catch (e) { return { ok: false, error: /^[A-Z_]+$/.test(e.code || '') ? e.code : 'PROTECTED_READ_FAILED' } }
  }
}
module.exports = { createProtectedReader, POLICY_ID }
