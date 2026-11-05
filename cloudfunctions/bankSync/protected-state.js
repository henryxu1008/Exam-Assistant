/** Account-scoped, content-free question markers. All mutations are transactional. */
const { readOptionalDoc } = require('./db-error.js')
const { TOKEN_TTL } = require('./auth.js')
const { sha256, canonical } = require('./question-domain.js')
const paged = require('./paged-catalog-domain.js')
const policyDomain = require('./exam-access-policy.js')
const subscription = require('./subscription-domain.js')
const fail = code => { throw Object.assign(new Error(code), { code }) }
const validId = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(v)
const read = (tx, name, id) => readOptionalDoc(() => tx.collection(name).doc(id).get())
const stateId = (owner, epoch, exam) => 'pm_' + sha256(JSON.stringify([owner, epoch, exam]))
const receiptId = (owner, epoch, op) => 'pr_' + sha256(JSON.stringify([owner, epoch, op]))
const publicState = doc => ({ revision: doc.revision, entries: doc.entries.map(row => ({ questionId: row.questionId, starred: row.starred, mastered: row.mastered })) })
function validState(doc, owner, epoch, exam) {
  return doc && (!doc._id || doc._id === stateId(owner, epoch, exam)) && doc.openid === owner && doc.dataEpoch === epoch && doc.examId === exam &&
    Number.isSafeInteger(doc.revision) && doc.revision >= 0 && Array.isArray(doc.entries) && doc.entries.length <= 2000 &&
    doc.entries.every(row => row && validId(row.questionId) && typeof row.starred === 'boolean' && typeof row.mastered === 'boolean' &&
      (row.starred || row.mastered) && Object.keys(row).sort().join(',') === 'mastered,questionId,starred') &&
    new Set(doc.entries.map(row => row.questionId)).size === doc.entries.length && Buffer.byteLength(JSON.stringify(doc.entries), 'utf8') <= 400000
}
function createProtectedState({ db, now = () => Date.now() }) {
  return async (event = {}, context = {}) => {
    try {
      if (!['getProtectedMarkers', 'setProtectedMarker'].includes(event.action) || !validId(event.examId) ||
          !Number.isSafeInteger(event.dataEpoch) || event.dataEpoch < 0) fail('BAD_PROTECTED_STATE')
      if (!validId(context.OPENID) || typeof event.token !== 'string' || !event.token) fail('INVALID_TOKEN')
      const found = await db.collection('users').where({ token: event.token }).limit(1).get(), user = found && Array.isArray(found.data) && found.data[0]
      if (!user || !user._id || user.openid !== context.OPENID) fail('INVALID_TOKEN')
      const actor = context.OPENID, id = stateId(actor, event.dataEpoch, event.examId)
      const mutation = event.action === 'setProtectedMarker'
      if (mutation && (!validId(event.operationId) || !validId(event.questionId) || !['starred', 'mastered'].includes(event.field) ||
          typeof event.value !== 'boolean' || !Number.isSafeInteger(event.expectedRevision) || event.expectedRevision < 0 ||
          !/^qb_[a-f0-9]{64}$/.test(event.releaseId || '') || !Number.isSafeInteger(event.publicationRevision) || event.publicationRevision < 1)) fail('BAD_PROTECTED_STATE')
      const input = mutation && { examId: event.examId, questionId: event.questionId, field: event.field, value: event.value,
        expectedRevision: event.expectedRevision, releaseId: event.releaseId, publicationRevision: event.publicationRevision }
      const digest = mutation && sha256(canonical(input))
      return await db.runTransaction(async tx => {
        const at = now(), current = await read(tx, 'users', user._id), stats = await read(tx, 'studyStats', actor)
        if (!current || current.openid !== actor || current.token !== event.token || !Number.isSafeInteger(current.tokenAt) || current.tokenAt <= 0 ||
            !Number.isSafeInteger(at) || at < current.tokenAt || at - current.tokenAt > TOKEN_TTL) fail('INVALID_TOKEN')
        const epoch = stats && stats.dataEpoch !== undefined ? stats.dataEpoch : 0
        if (!Number.isSafeInteger(epoch) || epoch < 0) fail('INVALID_EPOCH')
        if (epoch !== event.dataEpoch) fail('STALE_EPOCH')
        const state = await read(tx, 'protectedQuestionStates', id) || { _id: id, openid: actor, dataEpoch: epoch, examId: event.examId, revision: 0, entries: [] }
        if (!validState(state, actor, epoch, event.examId)) fail('INVALID_PROTECTED_STATE')
        if (!mutation) return { ok: true, ...publicState(state) }
        const receiptKey = receiptId(actor, epoch, event.operationId), receipt = await read(tx, 'protectedStateReceipts', receiptKey)
        if (receipt) {
          if (receipt.openid !== actor || receipt.dataEpoch !== epoch || receipt.digest !== digest || receipt.examId !== event.examId ||
              !Number.isSafeInteger(receipt.revision) || receipt.revision < 1) fail('OPERATION_CONFLICT')
          return { ok: true, duplicate: true, revision: receipt.revision }
        }
        if (state.revision !== event.expectedRevision) fail('STATE_CONFLICT')
        if (state.revision >= Number.MAX_SAFE_INTEGER) fail('INVALID_PROTECTED_STATE')
        const active = await read(tx, 'questions', 'bank')
        if (!active || active.schemaVersion !== 4 || !paged.validRoot(active.root) || active.root.releaseId !== event.releaseId ||
            active.publicationRevision !== event.publicationRevision) fail('STALE_RELEASE')
        const policy = await read(tx, 'appConfig', 'examAccessPolicy')
        if (!policyDomain.validPolicy(active.root, active.publicationRevision, policy)) fail('INVALID_ACCESS_POLICY')
        const rule = policy.entries.find(e => e.examId === event.examId)
        if (!rule) fail('EXAM_NOT_FOUND')
        if (rule.access === 'paid') {
          const timeline = await read(tx, 'commerceTimelines', subscription.timelineId(actor, event.examId))
          if (subscription.activeUntil(timeline, actor, event.examId, at) === null) fail('ENTITLEMENT_REQUIRED')
        }
        const archive = await read(tx, 'questions', event.releaseId), index = paged.findPageIndex(active.root, event.questionId)
        if (!archive || archive.kind !== 'pagedQuestionBankRelease' || !paged.validRoot(archive.root) || archive.root.releaseId !== event.releaseId ||
            !Number.isSafeInteger(archive.publishedAt) || archive.publishedAt < 0 || index < 0) fail('QUESTION_UNAVAILABLE')
        const page = await read(tx, 'questions', paged.pageDocumentId(event.releaseId, index))
        if (!page || page.kind !== 'pagedQuestionBankPage' || !paged.validQuestionPage(active.root, page.page)) fail('INVALID_PUBLISHED_PAGE')
        const question = page.page.questions.find(q => q.id === event.questionId)
        if (!question || !active.root.manifest.subjects.some(s => s.key === question.subject && s.examId === event.examId)) fail('QUESTION_UNAVAILABLE')
        const entries = state.entries.filter(row => row.questionId !== event.questionId)
        const previous = state.entries.find(row => row.questionId === event.questionId) || { questionId: event.questionId, starred: false, mastered: false }
        const updated = { ...previous, [event.field]: event.value }
        if (updated.starred || updated.mastered) entries.push(updated)
        entries.sort((a, b) => a.questionId < b.questionId ? -1 : a.questionId > b.questionId ? 1 : 0)
        const next = { _id: id, openid: actor, dataEpoch: epoch, examId: event.examId, revision: state.revision + 1, entries }
        if (!validState(next, actor, epoch, event.examId)) fail('PROTECTED_STATE_TOO_LARGE')
        await tx.collection('protectedQuestionStates').doc(id).set({ data: next })
        await tx.collection('protectedStateReceipts').doc(receiptKey).set({ data: { _id: receiptKey, openid: actor, dataEpoch: epoch,
          examId: event.examId, digest, revision: next.revision } })
        return { ok: true, duplicate: false, revision: next.revision }
      })
    } catch (e) { return { ok: false, error: /^[A-Z_]+$/.test(e.code || '') ? e.code : 'PROTECTED_STATE_FAILED' } }
  }
}
module.exports = { createProtectedState, stateId, validState }
