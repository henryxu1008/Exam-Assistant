/**
 * Public: get (legacy mirror), getPublished, getVersion(releaseId, versionId).
 * Admin: publish(bank, reviewed:true, expectedRevision); immutable releases + atomic activation audit.
 * Workflow: createDraft / getDraft / reviewDraft / publishDraft; separate catalog roles and immutable provenance.
 * Legacy set stays admin-only and is rejected once a versioned release is activated.
 * All documents use the existing questions collection; reads never interpret access failure as absence.
 */
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const BANK = db.collection('questions')
const USERS = db.collection('users')
const CONFIG = db.collection('appConfig')

/** 令牌校验 + 管理员判定；部署副本随本函数一起上传 */
const { findByToken, verifyAdminSecret, getAdminOpenids } = require('./auth.js')
/** 「读失败不得当成不存在」的统一判定；部署副本随本函数一起上传 */
const { readOptionalDoc } = require('./db-error.js')

/** 题库写操作允许的顶层字段（其余一律丢弃，防止写入任意字段） */
const BANK_FIELDS = ['manifest', 'questions']
const domain = require('./question-domain.js')
const examDomain = require('./exam-catalog-domain.js')
const paged = require('./paged-catalog-domain.js')
const validRelease = bank => domain.validRelease(bank) || examDomain.validExamRelease(bank)
const { createWorkflow, workflowRequired } = require('./workflow.js')
const { checkIdentities } = require('./identity-registry.js')
const { createPagedWorkflow } = require('./paged-workflow.js')
const workflow = createWorkflow(db, activateBank)
const pagedWorkflow = createPagedWorkflow(db)

/** 以管理员密钥发起、无登录身份时记录的写入者标识 */
const ADMIN_ACTOR_ID = 'admin'

function sanitizeBank(payload) {
  const src = payload && typeof payload === 'object' ? payload : {}
  const out = {}
  BANK_FIELDS.forEach((k) => {
    if (src[k] !== undefined) out[k] = src[k]
  })
  return out
}

async function adminActor(event) {
  const admin = verifyAdminSecret(event)
  const provided = event.adminSecret !== undefined && event.adminSecret !== null && event.adminSecret !== ''
  if (provided && !admin.ok) return { error: 'NOT_ADMIN' }
  const user = admin.ok ? null : await findByToken(USERS, event.token)
  if (!admin.ok && !user) return { error: event.token ? 'INVALID_TOKEN' : 'NO_TOKEN' }
  if (!admin.ok && (await getAdminOpenids(CONFIG)).indexOf(user.openid) === -1) return { error: 'NOT_ADMIN' }
  return { id: admin.ok ? ADMIN_ACTOR_ID : user.openid }
}

async function activateBank(tx, bank, actor, expectedRevision, approval) {
  const collection = tx.collection('questions'), ref = collection.doc('bank')
  const current = await readOptionalDoc(() => ref.get())
  if (current && current.schemaVersion === 4 && bank.schemaVersion !== 4) return { ok: false, error: 'PAGED_PROTOCOL_REQUIRED' }
  if (current && current.schemaVersion === 3 && bank.schemaVersion !== 3) return { ok: false, error: 'EXAM_PROTOCOL_REQUIRED' }
  if (!approval && await workflowRequired(collection, current)) return { ok: false, error: 'REVIEW_WORKFLOW_REQUIRED' }
  const revision = current && current.publicationRevision || 0
  if (revision !== expectedRevision) return { ok: false, error: 'STALE_PUBLICATION', publicationRevision: revision }
  if (!Number.isSafeInteger(revision + 1)) return { ok: false, error: 'BAD_REVISION' }
  const releaseRef = collection.doc(bank.releaseId)
  const existing = await readOptionalDoc(() => releaseRef.get())
  if (existing && (existing.kind !== 'questionBankRelease' || !validRelease(existing.bank) ||
      domain.canonical(existing.bank) !== domain.canonical(bank))) return { ok: false, error: 'RELEASE_CONFLICT' }
  if (bank.schemaVersion === 3) await checkIdentities(collection, current, bank, true)
  // The first publication archives the exact legacy bank. Never infer v1 attempt versions from it.
  if (current && current.schemaVersion !== 2 && current.schemaVersion !== 3) {
    const backupRef = collection.doc('bank_legacy_backup')
    const backup = await readOptionalDoc(() => backupRef.get())
    if (backup) return { ok: false, error: 'LEGACY_BACKUP_EXISTS' }
    await backupRef.set({ data: { kind: 'legacyBankBackup', bank: current, archivedAt: Date.now(), archivedBy: actor } })
  }
  if (!existing) await releaseRef.set({ data: { kind: 'questionBankRelease', bank, publishedAt: Date.now(), publishedBy: actor } })
  const next = revision + 1
  await collection.doc('bank_publication_' + next).set({ data: { kind: 'bankPublication', publicationRevision: next,
    releaseId: bank.releaseId, previousReleaseId: current && current.releaseId || null, at: Date.now(), by: actor, ...(approval ? { approval } : {}) } })
  // Compatibility mirror for older readers; older set writers are rejected after this transaction.
  await ref.set({ data: { _id: 'bank', ...bank, publicationRevision: next, ...(approval ? { workflowVersion: 1 } : {}), updatedAt: Date.now(), updatedBy: actor } })
  return { ok: true, releaseId: bank.releaseId, publicationRevision: next }
}

async function publish(event, actor) {
  if (event.reviewed !== true) return { ok: false, error: 'REVIEW_REQUIRED' }
  if (!Number.isSafeInteger(event.expectedRevision) || event.expectedRevision < 0) return { ok: false, error: 'BAD_REVISION' }
  let bank
  try { bank = domain.buildRelease(event.bank) } catch (e) { return { ok: false, error: e.code || 'BAD_BANK' } }
  if (typeof db.runTransaction !== 'function') return { ok: false, error: 'TRANSACTION_REQUIRED' }
  try { return await db.runTransaction(tx => activateBank(tx, bank, actor, event.expectedRevision)) }
  catch (e) { return { ok: false, error: 'PUBLISH_FAILED' } }
}

exports.main = async (event = {}) => {
  const action = event.action || 'get'
  if (['beginPagedDraft', 'uploadPagedDraftPage', 'getActivePagedDraft', 'getPagedDraft', 'getPagedDraftPage', 'abandonPagedDraft', 'sealPagedDraft', 'reviewPagedDraft', 'publishPagedDraft'].includes(action)) return pagedWorkflow(event)
  if (['getCatalogAccess', 'getActiveCatalogDraft', 'createDraft', 'createExamDraft', 'getDraft', 'reviewDraft', 'publishDraft', 'publishExamDraft'].includes(action)) return workflow(event)
  if (action === 'getPagedPublished') {
    try {
      const active = await readOptionalDoc(() => BANK.doc('bank').get())
      if (!active || active.schemaVersion !== 4) return { ok: true, root: null, publicationRevision: active && active.publicationRevision || 0 }
      if (!paged.validRoot(active.root) || !Number.isSafeInteger(active.publicationRevision) || active.publicationRevision < 1) return { ok: false, error: 'INVALID_RELEASE' }
      return { ok: true, root: active.root, publicationRevision: active.publicationRevision }
    } catch (e) { return { ok: false, error: 'READ_BANK_FAILED' } }
  }
  if (action === 'getPagedPage') {
    if (!/^qb_[a-f0-9]{64}$/.test(event.releaseId || '') || !Number.isSafeInteger(event.index) || event.index < 0 || event.index >= paged.limits.MAX_PAGES) return { ok: false, error: 'BAD_PAGE_QUERY' }
    try {
      const release = await readOptionalDoc(() => BANK.doc(event.releaseId).get())
      if (!release) return { ok: false, error: 'PUBLISHED_RELEASE_NOT_FOUND' }
      if (release.kind !== 'pagedQuestionBankRelease' || !paged.validRoot(release.root) || release.root.releaseId !== event.releaseId ||
          !Number.isSafeInteger(release.publishedAt) || release.publishedAt < 0) return { ok: false, error: 'INVALID_PUBLISHED_RELEASE' }
      if (!release.root.pages[event.index]) return { ok: false, error: 'BAD_PAGE_QUERY' }
      const doc = await readOptionalDoc(() => BANK.doc(paged.pageDocumentId(event.releaseId, event.index)).get())
      if (!doc) return { ok: false, error: 'PUBLISHED_PAGE_NOT_FOUND' }
      if (doc.kind !== 'pagedQuestionBankPage' || !paged.validQuestionPage(release.root, doc.page) || doc.page.index !== event.index) return { ok: false, error: 'INVALID_PUBLISHED_PAGE' }
      return { ok: true, page: doc.page }
    } catch (e) { return { ok: false, error: 'READ_PAGED_RELEASE_FAILED' } }
  }
  if (action === 'get' || action === 'getPublished' || action === 'getExamPublished') {
    try {
      const bank = await readOptionalDoc(() => BANK.doc('bank').get())
      if (bank && bank.schemaVersion === 4) return { ok: false, error: 'PAGED_PROTOCOL_REQUIRED' }
      if (bank && bank.schemaVersion === 3 && action !== 'getExamPublished') return { ok: false, error: 'EXAM_PROTOCOL_REQUIRED' }
      if (action === 'getExamPublished') {
        if (!bank || bank.schemaVersion !== 3) return { ok: true, bank: null, publicationRevision: bank && bank.publicationRevision || 0 }
        if (!examDomain.validExamRelease(bank)) return { ok: false, error: 'INVALID_RELEASE' }
      } else if (action === 'getPublished') {
        if (!bank || bank.schemaVersion !== 2) return { ok: true, bank: null, publicationRevision: 0 }
        if (!domain.validRelease(bank)) return { ok: false, error: 'INVALID_RELEASE' }
      }
      return { ok: true, bank, publicationRevision: bank && bank.publicationRevision || 0 }
    } catch (e) { return { ok: false, error: 'READ_BANK_FAILED' } }
  }
  if (action === 'getVersion') {
    if (!/^qb_[a-f0-9]{64}$/.test(event.releaseId || '') || !/^qv_[a-f0-9]{64}$/.test(event.versionId || '')) return { ok: false, error: 'BAD_VERSION_QUERY' }
    try {
      const release = await readOptionalDoc(() => BANK.doc(event.releaseId).get())
      if (!release) return { ok: true, question: null }
      if (release.kind !== 'questionBankRelease' || !validRelease(release.bank) || release.bank.releaseId !== event.releaseId) return { ok: false, error: 'INVALID_RELEASE' }
      const question = Object.values(release.bank.questions).flat().find(q => q.versionId === event.versionId)
      return { ok: true, question: question ? { ...question, bankReleaseId: event.releaseId } : null }
    } catch (e) { return { ok: false, error: 'READ_VERSION_FAILED' } }
  }
  if (action !== 'set' && action !== 'publish') return { ok: false, error: 'BAD_ACTION' }
  if (event.bank && (event.bank.schemaVersion === 3 || (event.bank.manifest && (event.bank.manifest.exams !== undefined ||
      (Array.isArray(event.bank.manifest.subjects) && event.bank.manifest.subjects.some(s => s && s.examId !== undefined)))))) return { ok: false, error: 'EXAM_PROTOCOL_REQUIRED' }
  if (action === 'set' && (!event.bank || !event.bank.manifest || !event.bank.questions)) return { ok: false, error: 'BAD_BANK' }
  let actor
  try { actor = await adminActor(event) } catch (e) { return { ok: false, error: 'READ_AUTH_FAILED' } }
  if (actor.error) return { ok: false, error: actor.error }
  if (action === 'publish') return publish(event, actor.id)

  // Legacy compatibility stays transactional with publish, so an old force writer cannot erase a release.
  if (typeof db.runTransaction !== 'function') return { ok: false, error: 'TRANSACTION_REQUIRED' }
  try {
    return await db.runTransaction(async tx => {
      const ref = tx.collection('questions').doc('bank')
      const existing = await readOptionalDoc(() => ref.get())
      if (await workflowRequired(tx.collection('questions'), existing)) return { ok: false, error: 'REVIEW_WORKFLOW_REQUIRED' }
      if (existing && existing.schemaVersion === 2) return { ok: false, error: 'PUBLICATION_REQUIRED' }
      if (existing && event.force !== true) return { ok: false, error: 'BANK_EXISTS' }
      await ref.set({ data: { _id: 'bank', updatedAt: Date.now(), updatedBy: actor.id, ...sanitizeBank(event.bank) } })
      return { ok: true }
    })
  } catch (e) { return { ok: false, error: 'TX_FAILED' } }
}
