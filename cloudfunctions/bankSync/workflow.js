/** Dedicated catalog roles, independent review and a durable guard against old publication paths. */
const { findByToken, TOKEN_TTL } = require('./auth.js')
const { readOptionalDoc } = require('./db-error.js')
const { submission, validDraft, validRoles } = require('./workflow-domain.js')
const domain = require('./question-domain.js')
const examDomain = require('./exam-catalog-domain.js')
const fail = code => { throw Object.assign(new Error(code), { code }) }
const rolesFor = { createDraft: 'editors', createExamDraft: 'editors', reviewDraft: 'reviewers', publishDraft: 'publishers', publishExamDraft: 'publishers' }

async function workflowRequired(collection, current) {
  const marker = await readOptionalDoc(() => collection.doc('bank_workflow').get())
  if (marker && (marker.version !== 1 || marker.required !== true)) fail('WORKFLOW_STATE_INVALID')
  return !!marker || !!(current && current.workflowVersion === 1)
}

function createWorkflow(db, activateBank) {
  return async event => {
    // Shared secrets cannot identify two different people. Do not fall back from an explicit secret.
    if (event.adminSecret !== undefined && event.adminSecret !== null && event.adminSecret !== '') return { ok: false, error: 'PERSONAL_IDENTITY_REQUIRED' }
    if (!event.token) return { ok: false, error: 'NO_TOKEN' }
    let user
    try { user = await findByToken(db.collection('users'), event.token) } catch (e) { return { ok: false, error: 'READ_AUTH_FAILED' } }
    if (!user) return { ok: false, error: 'INVALID_TOKEN' }
    if (typeof db.runTransaction !== 'function') return { ok: false, error: 'TRANSACTION_REQUIRED' }
    try {
      return await db.runTransaction(async tx => {
        const identity = await readOptionalDoc(() => tx.collection('users').doc(user._id).get())
        if (!identity || identity.token !== event.token || identity.openid !== user.openid || !identity.tokenAt || Date.now() - identity.tokenAt > TOKEN_TTL) fail('INVALID_TOKEN')
        const roles = await readOptionalDoc(() => tx.collection('appConfig').doc('bankRoles').get())
        if (!validRoles(roles)) fail('ROLE_CONFIG_REQUIRED')
        const actor = identity.openid, role = rolesFor[event.action]
        if (event.action === 'getCatalogAccess') return { ok: true, roles: ['editors', 'reviewers', 'publishers'].filter(r => roles[r].includes(actor)) }
        if (role ? !roles[role].includes(actor) : !['editors', 'reviewers', 'publishers'].some(r => roles[r].includes(actor))) fail('NOT_CATALOG_ROLE')
        const collection = tx.collection('questions')
        if (event.action === 'getActiveCatalogDraft') {
          const active = await readOptionalDoc(() => collection.doc('bank').get())
          if (!active) return { ok: true, draft: null, basePublication: null }
          if (!Number.isSafeInteger(active.publicationRevision) || active.publicationRevision < 1 || !(domain.validRelease(active) || examDomain.validExamRelease(active))) fail('NO_EDITABLE_PUBLISHED_DRAFT')
          const audit = await readOptionalDoc(() => collection.doc('bank_publication_' + active.publicationRevision).get())
          const draftId = audit && audit.approval && audit.approval.draftId
          if (!/^qd_[a-f0-9]{64}$/.test(draftId || '') || audit.kind !== 'bankPublication' || audit.publicationRevision !== active.publicationRevision || audit.releaseId !== active.releaseId) fail('NO_EDITABLE_PUBLISHED_DRAFT')
          const draft = await readOptionalDoc(() => collection.doc(draftId).get())
          if (!validDraft(draft) || draft.state !== 'published' || draft.publicationRevision !== active.publicationRevision || draft.bank.releaseId !== active.releaseId || audit.approval.payloadDigest !== draft.payloadDigest) fail('INVALID_PUBLISHED_DRAFT')
          return { ok: true, draft, basePublication: { revision: active.publicationRevision, releaseId: active.releaseId } }
        }
        if (event.action === 'createDraft' || event.action === 'createExamDraft') {
          const payload = submission(event, actor), ref = collection.doc(payload.draftId)
          const existing = await readOptionalDoc(() => ref.get())
          if (existing) {
            if (!validDraft(existing) || existing.payloadDigest !== payload.payloadDigest) fail('DRAFT_OPERATION_CONFLICT')
            return { ok: true, draftId: existing.draftId, state: existing.state, replayed: true }
          }
          const active = event.action === 'createExamDraft' || payload.basePublication ? await readOptionalDoc(() => collection.doc('bank').get()) : null
          if (event.action === 'createExamDraft' && !Object.values(payload.bank.questions).some(list => list.length)) fail('EMPTY_EXAM_DRAFT')
          if (event.action === 'createExamDraft' && active && !(domain.validRelease(active) || examDomain.validExamRelease(active))) fail('INVALID_ACTIVE_RELEASE')
          if (event.action === 'createExamDraft' && active && !payload.basePublication) fail('BASE_PUBLICATION_REQUIRED')
          if (payload.basePublication) {
            if (!active || active.publicationRevision !== payload.basePublication.revision || active.releaseId !== payload.basePublication.releaseId) fail('STALE_BASE_RELEASE')
          }
          if (event.action === 'createExamDraft' && active && active.schemaVersion === 3) {
            const oldQuestions = new Map(Object.values(active.questions).flat().map(q => [q.id, q]))
            for (const q of Object.values(payload.bank.questions).flat()) {
              const old = oldQuestions.get(q.id)
              if (old && (old.subject !== q.subject || old.chapter !== q.chapter)) fail('QUESTION_SCOPE_IMMUTABLE')
            }
          }
          const required = await workflowRequired(collection)
          if (!required) await collection.doc('bank_workflow').set({ data: { version: 1, required: true, enabledAt: Date.now(), enabledBy: actor } })
          await ref.set({ data: { ...payload, state: 'draft', createdAt: Date.now() } })
          return { ok: true, draftId: payload.draftId, state: 'draft' }
        }
        if (!/^qd_[a-f0-9]{64}$/.test(event.draftId || '')) fail('BAD_DRAFT_ID')
        const ref = collection.doc(event.draftId), draft = await readOptionalDoc(() => ref.get())
        if (!draft) fail('DRAFT_NOT_FOUND')
        if (!validDraft(draft)) fail('INVALID_DRAFT')
        if (event.action === 'getDraft') return { ok: true, draft }
        if (!(await workflowRequired(collection))) fail('WORKFLOW_STATE_INVALID')
        if (event.action === 'reviewDraft') {
          if (draft.createdBy === actor) fail('SELF_REVIEW_FORBIDDEN')
          if (!['approve', 'reject'].includes(event.decision) || typeof event.note !== 'string' || !event.note.trim() || event.note.length > 2000) fail('BAD_REVIEW')
          if (event.decision === 'approve' && event.sourceVerified !== true) fail('SOURCE_REVIEW_REQUIRED')
          const state = event.decision === 'approve' ? 'approved' : 'rejected'
          if (draft.state !== 'draft') {
            if (draft.reviewedBy === actor && draft.state === state && draft.reviewNote === event.note) return { ok: true, draftId: draft.draftId, state, replayed: true }
            fail('REVIEW_ALREADY_DECIDED')
          }
          const review = { state, reviewedBy: actor, reviewedAt: Date.now(), reviewNote: event.note,
            sourceVerified: event.decision === 'approve', payloadDigest: draft.payloadDigest }
          const receiptRef = collection.doc(draft.draftId + '_review')
          if (await readOptionalDoc(() => receiptRef.get())) fail('REVIEW_RECEIPT_CONFLICT')
          await receiptRef.set({ data: { kind: 'bankReview', draftId: draft.draftId, ...review } })
          await ref.set({ data: { ...draft, ...review } })
          return { ok: true, draftId: draft.draftId, state }
        }
        if ((draft.bank.schemaVersion === 3) !== (event.action === 'publishExamDraft')) fail('EXAM_PROTOCOL_REQUIRED')
        if (!Number.isSafeInteger(event.expectedRevision) || event.expectedRevision < 0) fail('BAD_REVISION')
        if (draft.state === 'published') return { ok: true, releaseId: draft.bank.releaseId, publicationRevision: draft.publicationRevision, alreadyPublished: true }
        if (draft.state !== 'approved' || !draft.sourceVerified || draft.reviewedBy === draft.createdBy) fail('DRAFT_NOT_APPROVED')
        if (!roles.reviewers.includes(draft.reviewedBy)) fail('REVIEWER_NOT_AUTHORIZED')
        const review = await readOptionalDoc(() => collection.doc(draft.draftId + '_review').get())
        if (!review || review.kind !== 'bankReview' || review.state !== 'approved' || review.reviewedBy !== draft.reviewedBy ||
            review.payloadDigest !== draft.payloadDigest || review.sourceVerified !== true) fail('INVALID_REVIEW_RECEIPT')
        if (draft.basePublication) {
          const active = await readOptionalDoc(() => collection.doc('bank').get())
          if (!active || event.expectedRevision !== draft.basePublication.revision || active.publicationRevision !== draft.basePublication.revision || active.releaseId !== draft.basePublication.releaseId) fail('STALE_BASE_RELEASE')
        } else if (draft.bank.schemaVersion === 3) {
          // A draft created against an empty catalog cannot be rebased onto someone else's first publication.
          const active = await readOptionalDoc(() => collection.doc('bank').get())
          if (active || event.expectedRevision !== 0) fail('STALE_BASE_RELEASE')
        }
        const result = await activateBank(tx, draft.bank, actor, event.expectedRevision,
          { draftId: draft.draftId, reviewedBy: draft.reviewedBy, payloadDigest: draft.payloadDigest, sourceVerified: true })
        if (!result.ok) return result
        await ref.set({ data: { ...draft, state: 'published', publishedBy: actor, publishedAt: Date.now(), publicationRevision: result.publicationRevision } })
        return result
      })
    } catch (e) { return { ok: false, error: e.code || 'WORKFLOW_FAILED' } }
  }
}
module.exports = { createWorkflow, workflowRequired }
