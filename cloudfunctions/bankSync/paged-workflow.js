/** Staged paged catalogs. Page documents are immutable; only a sealed, reviewed draft can activate a root. */
const { findByToken, TOKEN_TTL } = require('./auth.js')
const { readOptionalDoc } = require('./db-error.js')
const { validRoles } = require('./workflow-domain.js')
const domain = require('./question-domain.js')
const exam = require('./exam-catalog-domain.js')
const paged = require('./paged-catalog-domain.js')
const accessPolicy = require('./exam-access-policy.js')
const { sha256, canonical } = domain
const fail = code => { throw Object.assign(new Error(code), { code }) }
const hexes = '0123456789abcdef'.split('')
const digest = x => sha256(canonical(x))
const bytes = x => encodeURIComponent(canonical(x)).replace(/%[A-F0-9]{2}/g, 'x').length
const same = (a, b) => canonical(a) === canonical(b)
const draftId = (actor, submissionId) => 'qpd_' + sha256(JSON.stringify([actor, submissionId]))
const sourceId = (draft, index) => 'bps_' + sha256(JSON.stringify([draft, index]))
const stageId = (draft, bucket) => 'bpi_' + sha256(JSON.stringify([draft, bucket]))
const visitId = (draft, actor) => 'bpv_' + sha256(JSON.stringify([draft, actor]))
const reviewId = draft => 'bpr_' + sha256(draft)
const refsId = releaseId => 'bpf_' + sha256(releaseId)
const validRefs = (refs, root) => !!refs && refs.kind === 'pagedReleaseReferences' && refs.releaseId === root.releaseId &&
  Number.isSafeInteger(refs.liveDrafts) && refs.liveDrafts >= 0 && refs.digest === digest({ releaseId: refs.releaseId, liveDrafts: refs.liveDrafts })
const refsValue = (releaseId, liveDrafts) => ({ kind: 'pagedReleaseReferences', releaseId, liveDrafts, digest: digest({ releaseId, liveDrafts }) })
const validBase = base => base === null || (base && Number.isSafeInteger(base.revision) && base.revision > 0 && /^qb_[a-f0-9]{64}$/.test(base.releaseId || ''))
const payloadDigest = (root, evidence, base, policy) => digest({ releaseId: root.releaseId, evidenceDigest: evidence.digest, basePublication: base,
  ...(policy ? { accessPolicyDigest: policy.digest } : {}) })
const publishedId = active => active && active.schemaVersion === 4 ? active.root && active.root.releaseId : active && active.releaseId
function validDraft(draft) {
  try {
    return !!draft && draft.kind === 'pagedCatalogDraft' && typeof draft.createdBy === 'string' && draft.createdBy.length > 0 &&
      /^[A-Za-z0-9_-]{1,80}$/.test(draft.submissionId || '') && draft.draftId === draftId(draft.createdBy, draft.submissionId) &&
      paged.validRoot(draft.root) && paged.validEvidence(draft.root, draft.evidence) && validBase(draft.basePublication) && draft.rightsConfirmed === true &&
      (!draft.accessPolicy || accessPolicy.validPolicy(draft.root, (draft.basePublication ? draft.basePublication.revision : 0) + 1, draft.accessPolicy)) &&
      draft.payloadDigest === payloadDigest(draft.root, draft.evidence, draft.basePublication, draft.accessPolicy) &&
      ['uploading', 'sealed', 'approved', 'rejected', 'published', 'abandoned'].includes(draft.state) && Array.isArray(draft.uploaded) &&
      draft.uploaded.length === draft.root.pages.length && draft.uploaded.every(x => typeof x === 'boolean') &&
      draft.uploadedCount === draft.uploaded.filter(Boolean).length && Number.isSafeInteger(draft.identityCount) && draft.identityCount >= 0 &&
      Number.isSafeInteger(draft.identityBytes) && draft.identityBytes >= 0 && Array.isArray(draft.identityBuckets) &&
      draft.identityBuckets.every(x => hexes.includes(x)) && new Set(draft.identityBuckets).size === draft.identityBuckets.length
  } catch (e) { /* swallow: pure draft validation does not read storage. */ return false }
}
function checkBase(active, base) {
  if (!active) { if (base !== null) fail('STALE_BASE_RELEASE'); return }
  if (active.schemaVersion !== 3 && active.schemaVersion !== 4) fail('LEGACY_IDENTITY_MIGRATION_REQUIRED')
  if ((active.schemaVersion === 3 && !exam.validExamRelease(active)) || (active.schemaVersion === 4 && !paged.validRoot(active.root))) fail('INVALID_ACTIVE_RELEASE')
  if (!base || active.publicationRevision !== base.revision || publishedId(active) !== base.releaseId) fail('STALE_BASE_RELEASE')
}
function validStageShard(doc, draft, bucket) {
  return !!doc && doc.kind === 'pagedStageIdentity' && doc.draftId === draft && doc.bucket === bucket && doc.entries &&
    typeof doc.entries === 'object' && !Array.isArray(doc.entries) && doc.digest === digest(doc.entries) &&
    Object.entries(doc.entries).every(([hash, entry]) => entry && typeof entry.id === 'string' && sha256(entry.id) === hash && hash[0] === bucket &&
      typeof entry.subject === 'string' && !!entry.subject && typeof entry.chapter === 'string' && !!entry.chapter)
}
async function stageIdentities(collection, draft) {
  const rows = []
  for (const bucket of hexes) {
    const doc = await readOptionalDoc(() => collection.doc(stageId(draft.draftId, bucket)).get())
    if (draft.identityBuckets.includes(bucket) !== !!doc || (doc && !validStageShard(doc, draft.draftId, bucket))) fail('PAGED_STAGE_CORRUPT')
    if (doc) rows.push(...Object.values(doc.entries))
  }
  if (rows.length !== draft.root.totalQuestions || rows.length !== draft.identityCount || paged.identityDigest(rows) !== draft.root.identityDigest) fail('PAGED_STAGE_CORRUPT')
  return rows
}
async function commitIdentities(collection, active, root, rows) {
  const markerRef = collection.doc('bank_identity_registry'), marker = await readOptionalDoc(() => markerRef.get())
  const revision = active ? active.publicationRevision : 0
  if ((active && (!marker || marker.kind !== 'questionIdentityRegistry' || marker.version !== 1 || marker.revision !== revision)) || (!active && marker) ||
      (marker && (!Array.isArray(marker.buckets) || marker.buckets.some(x => !hexes.includes(x)) || new Set(marker.buckets).size !== marker.buckets.length))) fail('IDENTITY_REGISTRY_INVALID')
  const shards = new Map(), entries = new Map(), previous = []
  for (const bucket of hexes) {
    const ref = collection.doc('bank_identity_' + bucket), doc = await readOptionalDoc(() => ref.get())
    if (!!(marker && marker.buckets.includes(bucket)) !== !!doc || (doc && (doc.kind !== 'questionIdentityShard' || doc.bucket !== bucket || !doc.entries ||
        typeof doc.entries !== 'object' || Array.isArray(doc.entries) || doc.digest !== digest(doc.entries)))) fail('IDENTITY_REGISTRY_INVALID')
    const values = doc ? doc.entries : {}
    for (const [hash, value] of Object.entries(values)) {
      if (!value || typeof value.id !== 'string' || sha256(value.id) !== hash || hash[0] !== bucket || typeof value.subject !== 'string' ||
          typeof value.chapter !== 'string' || typeof value.retired !== 'boolean') fail('IDENTITY_REGISTRY_INVALID')
      entries.set(value.id, value); if (!value.retired) previous.push(value)
    }
    shards.set(bucket, { ref, entries: values, existed: !!doc, changed: false })
  }
  if (active) {
    const expected = active.schemaVersion === 4 ? active.root.identityDigest : paged.identityDigest(Object.values(active.questions).flat())
    if (paged.identityDigest(previous) !== expected) fail('IDENTITY_REGISTRY_INVALID')
  } else if (previous.length) fail('IDENTITY_REGISTRY_INVALID')
  const next = new Set(rows.map(row => row.id))
  for (const row of rows) {
    const found = entries.get(row.id), bucket = sha256(row.id)[0], shard = shards.get(bucket)
    if (found && found.retired) fail('QUESTION_ID_RETIRED')
    if (found && (found.subject !== row.subject || found.chapter !== row.chapter)) fail('QUESTION_SCOPE_IMMUTABLE')
    if (!found) { shard.entries[sha256(row.id)] = { ...row, retired: false }; shard.changed = true }
  }
  for (const row of previous) if (!next.has(row.id)) { const shard = shards.get(sha256(row.id)[0]); shard.entries[sha256(row.id)].retired = true; shard.changed = true }
  let totalBytes = 0
  for (const shard of shards.values()) { const size = bytes(shard.entries); if (size > 750000) fail('IDENTITY_REGISTRY_FULL'); totalBytes += size }
  if (totalBytes > 1000000) fail('IDENTITY_REGISTRY_FULL')
  const present = []
  for (const [bucket, shard] of shards) {
    if (shard.changed) await shard.ref.set({ data: { kind: 'questionIdentityShard', bucket, entries: shard.entries, digest: digest(shard.entries) } })
    if (shard.existed || shard.changed) present.push(bucket)
  }
  await markerRef.set({ data: { kind: 'questionIdentityRegistry', version: 1, revision: revision + 1, buckets: present } })
}

function createPagedWorkflow(db, { protectedMode = false } = {}) {
  return async (event, context = {}) => {
    if (event.adminSecret !== undefined && event.adminSecret !== null && event.adminSecret !== '') return { ok: false, error: 'PERSONAL_IDENTITY_REQUIRED' }
    if (!event.token) return { ok: false, error: 'NO_TOKEN' }
    let user
    try { user = await findByToken(db.collection('users'), event.token) } catch (e) { return { ok: false, error: 'READ_AUTH_FAILED' } }
    if (!user || (protectedMode && (!context.OPENID || context.OPENID !== user.openid))) return { ok: false, error: 'INVALID_TOKEN' }
    if (typeof db.runTransaction !== 'function') return { ok: false, error: 'TRANSACTION_REQUIRED' }
    try {
      return await db.runTransaction(async tx => {
        const identity = await readOptionalDoc(() => tx.collection('users').doc(user._id).get())
        if (!identity || identity.token !== event.token || identity.openid !== user.openid || !identity.tokenAt || Date.now() - identity.tokenAt > TOKEN_TTL) fail('INVALID_TOKEN')
        if (protectedMode && (!Number.isSafeInteger(identity.tokenAt) || identity.tokenAt > Date.now())) fail('INVALID_TOKEN')
        const roles = await readOptionalDoc(() => tx.collection('appConfig').doc('bankRoles').get())
        if (!validRoles(roles)) fail('ROLE_CONFIG_REQUIRED')
        const actor = identity.openid, collection = tx.collection('questions')
        const required = { beginPagedDraft: 'editors', uploadPagedDraftPage: 'editors', getActivePagedDraft: 'editors', abandonPagedDraft: 'editors', cleanupPagedRelease: 'editors', sealPagedDraft: 'editors', reviewPagedDraft: 'reviewers', publishPagedDraft: 'publishers' }[event.action]
        if (required ? !roles[required].includes(actor) : !['editors', 'reviewers', 'publishers'].some(role => roles[role].includes(actor))) fail('NOT_CATALOG_ROLE')
        if (event.action === 'getActivePagedDraft') {
          const active = await readOptionalDoc(() => collection.doc('bank').get())
          if (!active || active.schemaVersion !== 4 || !paged.validRoot(active.root) || !Number.isSafeInteger(active.publicationRevision) || active.publicationRevision < 1) fail('INVALID_ACTIVE_RELEASE')
          const audit = await readOptionalDoc(() => collection.doc('bank_publication_' + active.publicationRevision).get())
          if (!audit || audit.kind !== 'bankPublication' || audit.publicationRevision !== active.publicationRevision || audit.releaseId !== active.root.releaseId ||
              !audit.approval || audit.approval.sourceVerified !== true || !/^qpd_[a-f0-9]{64}$/.test(audit.approval.draftId || '')) fail('INVALID_PUBLISHED_DRAFT')
          const draft = await readOptionalDoc(() => collection.doc(audit.approval.draftId).get())
          if (!validDraft(draft) || draft.state !== 'published' || draft.publicationRevision !== active.publicationRevision || !same(draft.root, active.root) ||
              draft.payloadDigest !== audit.approval.payloadDigest || draft.reviewedBy !== audit.approval.reviewedBy) fail('INVALID_PUBLISHED_DRAFT')
          if (protectedMode) {
            const policy = await readOptionalDoc(() => tx.collection('appConfig').doc('examAccessPolicy').get())
            if (!draft.accessPolicy || !accessPolicy.validPolicy(active.root, active.publicationRevision, policy) ||
                draft.accessPolicy.digest !== policy.digest || audit.approval.accessPolicyDigest !== policy.digest) fail('INVALID_ACCESS_POLICY')
          } else if (draft.accessPolicy) fail('PROTECTED_DRAFT_REQUIRED')
          return { ok: true, draftId: draft.draftId, root: draft.root, evidence: draft.evidence,
            basePublication: { revision: active.publicationRevision, releaseId: active.root.releaseId } }
        }
        if (event.action === 'beginPagedDraft') {
          if (!/^[A-Za-z0-9_-]{1,80}$/.test(event.submissionId || '')) fail('BAD_SUBMISSION_ID')
          if (event.rightsConfirmed !== true) fail('RIGHTS_CONFIRMATION_REQUIRED')
          if (!paged.validRoot(event.root) || !paged.validEvidence(event.root, event.evidence) || !validBase(event.basePublication)) fail('BAD_PAGED_CATALOG')
          if (!protectedMode && event.accessRules !== undefined) fail('PROTECTED_MODE_REQUIRED')
          // The additional policy read/write would exceed the 100-operation budget at 20 pages.
          if (protectedMode && event.root.pages.length > 19) fail('PROTECTED_CATALOG_TOO_LARGE')
          const nextRevision = (event.basePublication ? event.basePublication.revision : 0) + 1
          const policy = protectedMode ? accessPolicy.buildPolicy(event.root, nextRevision, event.accessRules) : null
          const id = draftId(actor, event.submissionId), ref = collection.doc(id), existing = await readOptionalDoc(() => ref.get())
          const payload = payloadDigest(event.root, event.evidence, event.basePublication, policy)
          if (existing) {
            if (!validDraft(existing) || existing.payloadDigest !== payload) fail('DRAFT_OPERATION_CONFLICT')
            return { ok: true, draftId: id, state: existing.state, replayed: true }
          }
          const active = await readOptionalDoc(() => collection.doc('bank').get())
          checkBase(active, event.basePublication)
          const refsRef = collection.doc(refsId(event.root.releaseId)), refs = await readOptionalDoc(() => refsRef.get())
          if (refs && !validRefs(refs, event.root)) fail('PAGED_REFERENCES_INVALID')
          if (!refs && await readOptionalDoc(() => collection.doc(event.root.releaseId).get())) fail('PAGED_REFERENCES_INVALID')
          const liveDrafts = (refs ? refs.liveDrafts : 0) + 1
          if (!Number.isSafeInteger(liveDrafts)) fail('PAGED_REFERENCES_INVALID')
          const draft = { kind: 'pagedCatalogDraft', draftId: id, submissionId: event.submissionId, createdBy: actor, createdAt: Date.now(), state: 'uploading',
            root: event.root, evidence: event.evidence, basePublication: event.basePublication, rightsConfirmed: true, payloadDigest: payload,
            ...(policy ? { accessPolicy: policy } : {}), uploaded: event.root.pages.map(() => false),
            uploadedCount: 0, identityCount: 0, identityBytes: 0, identityBuckets: [] }
          await refsRef.set({ data: refsValue(event.root.releaseId, liveDrafts) })
          await ref.set({ data: draft })
          return { ok: true, draftId: id, state: draft.state }
        }
        if (!/^qpd_[a-f0-9]{64}$/.test(event.draftId || '')) fail('BAD_DRAFT_ID')
        const ref = collection.doc(event.draftId), draft = await readOptionalDoc(() => ref.get())
        if (!draft) fail('DRAFT_NOT_FOUND')
        if (!validDraft(draft)) fail('INVALID_DRAFT')
        if (protectedMode !== !!draft.accessPolicy) fail('PROTECTED_DRAFT_REQUIRED')
        if (protectedMode && draft.root.pages.length > 19) fail('PROTECTED_CATALOG_TOO_LARGE')
        if (event.action === 'getPagedDraft') {
          if (protectedMode && roles.reviewers.includes(actor) && actor !== draft.createdBy && draft.state === 'sealed') {
            const vref = collection.doc(visitId(draft.draftId, actor)), prior = await readOptionalDoc(() => vref.get())
            if (prior && (prior.kind !== 'pagedReviewVisits' || prior.payloadDigest !== draft.payloadDigest || prior.actor !== actor ||
                !Array.isArray(prior.pages) || prior.pages.length !== draft.root.pages.length || prior.pages.some(x => typeof x !== 'boolean') ||
                (prior.policyRead !== undefined && typeof prior.policyRead !== 'boolean'))) fail('INVALID_REVIEW_RECEIPT')
            const pages = prior ? prior.pages.slice() : draft.root.pages.map(() => false)
            await vref.set({ data: { kind: 'pagedReviewVisits', payloadDigest: draft.payloadDigest, actor, pages, policyRead: true } })
          }
          return { ok: true, draft }
        }
        if (event.action === 'cleanupPagedRelease') {
          if (draft.createdBy !== actor || draft.state !== 'abandoned') fail('DRAFT_NOT_EDITABLE')
          const refsRef = collection.doc(refsId(draft.root.releaseId)), refs = await readOptionalDoc(() => refsRef.get())
          if (!validRefs(refs, draft.root)) fail('PAGED_REFERENCES_INVALID')
          if (refs.liveDrafts !== 0) fail('PAGED_RELEASE_IN_USE')
          const archive = await readOptionalDoc(() => collection.doc(draft.root.releaseId).get())
          const active = await readOptionalDoc(() => collection.doc('bank').get())
          if (active && ((active.schemaVersion === 4 && !paged.validRoot(active.root)) || (active.schemaVersion === 3 && !exam.validExamRelease(active)) || ![3, 4].includes(active.schemaVersion))) fail('INVALID_ACTIVE_RELEASE')
          if (archive || publishedId(active) === draft.root.releaseId) fail('PAGED_RELEASE_IN_USE')
          const removable = []
          for (const descriptor of draft.root.pages) {
            const pageRef = collection.doc(paged.pageDocumentId(draft.root.releaseId, descriptor.index)), page = await readOptionalDoc(() => pageRef.get())
            if (!page) continue
            if (page.kind !== 'pagedQuestionBankPage' || !page.page || page.page.index !== descriptor.index || !paged.validQuestionPage(draft.root, page.page)) fail('PAGED_STAGE_CORRUPT')
            removable.push(pageRef)
          }
          for (const item of removable) await item.remove()
          // Every begin/abandon/cleanup writes this same document, forcing conflicting transactions to serialize.
          await refsRef.set({ data: { ...refsValue(refs.releaseId, refs.liveDrafts), cleanedAt: Date.now() } })
          return { ok: true, releaseId: draft.root.releaseId, removed: removable.length }
        }
        if (event.action === 'abandonPagedDraft') {
          if (draft.createdBy !== actor) fail('DRAFT_NOT_EDITABLE')
          if (draft.state === 'abandoned') return { ok: true, draftId: draft.draftId, state: 'abandoned', replayed: true }
          if (draft.state !== 'uploading') fail('DRAFT_NOT_EDITABLE')
          const refsRef = collection.doc(refsId(draft.root.releaseId)), refs = await readOptionalDoc(() => refsRef.get())
          if (!validRefs(refs, draft.root) || refs.liveDrafts < 1) fail('PAGED_REFERENCES_INVALID')
          const removable = []
          for (let index = 0; index < draft.uploaded.length; index++) if (draft.uploaded[index]) {
            const pageRef = collection.doc(sourceId(draft.draftId, index)), source = await readOptionalDoc(() => pageRef.get())
            if (!source || source.kind !== 'pagedSourcePage' || source.draftId !== draft.draftId || !source.page || source.page.index !== index ||
                !paged.validSourcePage(draft.root, draft.evidence, source.page)) fail('PAGED_STAGE_CORRUPT')
            removable.push(pageRef)
          }
          for (const bucket of draft.identityBuckets) {
            const shardRef = collection.doc(stageId(draft.draftId, bucket)), shard = await readOptionalDoc(() => shardRef.get())
            if (!validStageShard(shard, draft.draftId, bucket)) fail('PAGED_STAGE_CORRUPT')
            removable.push(shardRef)
          }
          for (const item of removable) await item.remove()
          await refsRef.set({ data: refsValue(refs.releaseId, refs.liveDrafts - 1) })
          await ref.set({ data: { ...draft, state: 'abandoned', abandonedAt: Date.now(), abandonedBy: actor } })
          return { ok: true, draftId: draft.draftId, state: 'abandoned' }
        }
        if (event.action === 'uploadPagedDraftPage') {
          if (draft.createdBy !== actor || draft.state !== 'uploading') fail('DRAFT_NOT_EDITABLE')
          const pub = event.page, priv = event.sourcePage
          if (!paged.validPagePair(draft.root, draft.evidence, pub, priv)) fail('INVALID_PAGED_PAGE')
          const index = pub.index
          const publicRef = collection.doc(paged.pageDocumentId(draft.root.releaseId, index)), privateRef = collection.doc(sourceId(draft.draftId, index))
          const existingPublic = await readOptionalDoc(() => publicRef.get()), existingPrivate = await readOptionalDoc(() => privateRef.get())
          if (existingPublic && (existingPublic.kind !== 'pagedQuestionBankPage' || !same(existingPublic.page, pub))) fail('PAGED_PAGE_CONFLICT')
          if (draft.uploaded[index]) {
            if (!existingPublic || !existingPrivate || existingPrivate.kind !== 'pagedSourcePage' || !same(existingPrivate.page, priv)) fail('PAGED_STAGE_CORRUPT')
            return { ok: true, index, replayed: true }
          }
          if (existingPrivate) fail('PAGED_STAGE_CORRUPT')
          const groups = new Map()
          for (const q of pub.questions) { const bucket = sha256(q.id)[0]; if (!groups.has(bucket)) groups.set(bucket, []); groups.get(bucket).push(q) }
          const modified = []
          let identityBytes = draft.identityBytes
          for (const [bucket, questions] of groups) {
            const sref = collection.doc(stageId(draft.draftId, bucket)), old = await readOptionalDoc(() => sref.get())
            if (draft.identityBuckets.includes(bucket) !== !!old || (old && !validStageShard(old, draft.draftId, bucket))) fail('PAGED_STAGE_CORRUPT')
            const entries = old ? old.entries : {}, oldSize = old ? bytes(entries) : 0
            for (const q of questions) {
              const hash = sha256(q.id)
              if (Object.prototype.hasOwnProperty.call(entries, hash)) fail('DUPLICATE_ID')
              entries[hash] = { id: q.id, subject: q.subject, chapter: q.chapter }
            }
            const size = bytes(entries); if (size > 750000) fail('IDENTITY_REGISTRY_FULL')
            identityBytes += size - oldSize
            if (identityBytes > 1000000) fail('IDENTITY_REGISTRY_FULL')
            modified.push({ sref, bucket, entries })
          }
          for (const { sref, bucket, entries } of modified) await sref.set({ data: { kind: 'pagedStageIdentity', draftId: draft.draftId, bucket, entries, digest: digest(entries) } })
          if (!existingPublic) await publicRef.set({ data: { kind: 'pagedQuestionBankPage', page: pub } })
          await privateRef.set({ data: { kind: 'pagedSourcePage', draftId: draft.draftId, page: priv } })
          const uploaded = draft.uploaded.slice(); uploaded[index] = true
          await ref.set({ data: { ...draft, uploaded, uploadedCount: draft.uploadedCount + 1, identityCount: draft.identityCount + pub.questions.length,
            identityBytes, identityBuckets: [...new Set([...draft.identityBuckets, ...groups.keys()])].sort() } })
          return { ok: true, index }
        }
        if (event.action === 'sealPagedDraft') {
          if (draft.createdBy !== actor) fail('DRAFT_NOT_EDITABLE')
          if (['sealed', 'approved', 'rejected', 'published'].includes(draft.state)) return { ok: true, draftId: draft.draftId, state: draft.state, replayed: true }
          if (draft.state !== 'uploading') fail('DRAFT_NOT_EDITABLE')
          if (draft.uploadedCount !== draft.root.pages.length || draft.uploaded.some(x => !x)) fail('PAGED_DRAFT_INCOMPLETE')
          await stageIdentities(collection, draft)
          const active = await readOptionalDoc(() => collection.doc('bank').get()); checkBase(active, draft.basePublication)
          await ref.set({ data: { ...draft, state: 'sealed', sealedAt: Date.now() } })
          return { ok: true, draftId: draft.draftId, state: 'sealed' }
        }
        if (event.action === 'getPagedDraftPage') {
          const index = event.index
          if (!Number.isSafeInteger(index) || !draft.root.pages[index] || !draft.uploaded[index]) fail('BAD_PAGE_QUERY')
          const pub = await readOptionalDoc(() => collection.doc(paged.pageDocumentId(draft.root.releaseId, index)).get())
          const priv = await readOptionalDoc(() => collection.doc(sourceId(draft.draftId, index)).get())
          if (!pub || pub.kind !== 'pagedQuestionBankPage' || !priv || priv.kind !== 'pagedSourcePage' || priv.draftId !== draft.draftId ||
              !paged.validPagePair(draft.root, draft.evidence, pub.page, priv.page)) fail('PAGED_STAGE_CORRUPT')
          if (roles.reviewers.includes(actor) && actor !== draft.createdBy && draft.state === 'sealed') {
            const vref = collection.doc(visitId(draft.draftId, actor)), prior = await readOptionalDoc(() => vref.get())
            if (prior && (prior.kind !== 'pagedReviewVisits' || prior.payloadDigest !== draft.payloadDigest || prior.actor !== actor ||
                !Array.isArray(prior.pages) || prior.pages.length !== draft.root.pages.length || prior.pages.some(x => typeof x !== 'boolean') ||
                (protectedMode && prior.policyRead !== undefined && typeof prior.policyRead !== 'boolean'))) fail('INVALID_REVIEW_RECEIPT')
            const pages = prior ? prior.pages.slice() : draft.root.pages.map(() => false); pages[index] = true
            await vref.set({ data: { kind: 'pagedReviewVisits', payloadDigest: draft.payloadDigest, actor, pages,
              ...(protectedMode ? { policyRead: !!(prior && prior.policyRead) } : {}) } })
          }
          return { ok: true, page: pub.page, sourcePage: priv.page }
        }
        if (event.action === 'reviewPagedDraft') {
          if (draft.createdBy === actor) fail('SELF_REVIEW_FORBIDDEN')
          if (draft.state !== 'sealed') {
            const prior = await readOptionalDoc(() => collection.doc(reviewId(draft.draftId)).get())
            if (prior && prior.kind === 'pagedReview' && prior.draftId === draft.draftId && prior.payloadDigest === draft.payloadDigest &&
                prior.reviewedBy === actor && prior.decision === event.decision && prior.note === event.note &&
                prior.sourceVerified === (event.decision === 'approve') && (event.decision !== 'approve' || event.sourceVerified === true) &&
                (!protectedMode || event.decision !== 'approve' || (prior.policyVerified === true && event.policyVerified === true))) return { ok: true, state: draft.state, replayed: true }
            fail('REVIEW_ALREADY_DECIDED')
          }
          if (!['approve', 'reject'].includes(event.decision) || typeof event.note !== 'string' || !event.note.trim() || event.note.length > 2000) fail('BAD_REVIEW')
          if (event.decision === 'approve') {
            if (event.sourceVerified !== true) fail('SOURCE_REVIEW_REQUIRED')
            if (protectedMode && event.policyVerified !== true) fail('POLICY_REVIEW_REQUIRED')
            const visits = await readOptionalDoc(() => collection.doc(visitId(draft.draftId, actor)).get())
            if (!visits || visits.kind !== 'pagedReviewVisits' || visits.actor !== actor || visits.payloadDigest !== draft.payloadDigest ||
                !Array.isArray(visits.pages) || visits.pages.length !== draft.root.pages.length || visits.pages.some(x => x !== true) ||
                (protectedMode && visits.policyRead !== true)) fail('REVIEW_PAGES_REQUIRED')
          }
          const receipt = { kind: 'pagedReview', draftId: draft.draftId, payloadDigest: draft.payloadDigest, reviewedBy: actor,
            decision: event.decision, note: event.note, sourceVerified: event.decision === 'approve',
            ...(protectedMode ? { policyVerified: event.decision === 'approve' } : {}), reviewedAt: Date.now() }
          const receiptRef = collection.doc(reviewId(draft.draftId))
          if (await readOptionalDoc(() => receiptRef.get())) fail('REVIEW_RECEIPT_CONFLICT')
          await receiptRef.set({ data: receipt })
          await ref.set({ data: { ...draft, state: event.decision === 'approve' ? 'approved' : 'rejected', reviewedBy: actor } })
          return { ok: true, state: event.decision === 'approve' ? 'approved' : 'rejected' }
        }
        if (event.action === 'publishPagedDraft') {
          if (draft.state === 'published') {
            if (protectedMode) {
              const active = await readOptionalDoc(() => collection.doc('bank').get())
              const currentPolicy = await readOptionalDoc(() => tx.collection('appConfig').doc('examAccessPolicy').get())
              if (!active || active.schemaVersion !== 4 || active.publicationRevision !== draft.publicationRevision ||
                  !same(active.root, draft.root) || !accessPolicy.validPolicy(active.root, active.publicationRevision, currentPolicy) ||
                  currentPolicy.digest !== draft.accessPolicy.digest) fail('STALE_BASE_RELEASE')
            }
            return { ok: true, releaseId: draft.root.releaseId, publicationRevision: draft.publicationRevision, alreadyPublished: true }
          }
          if (draft.state !== 'approved' || !roles.reviewers.includes(draft.reviewedBy) || draft.reviewedBy === draft.createdBy) fail('DRAFT_NOT_APPROVED')
          const receipt = await readOptionalDoc(() => collection.doc(reviewId(draft.draftId)).get())
          if (!receipt || receipt.kind !== 'pagedReview' || receipt.draftId !== draft.draftId || receipt.payloadDigest !== draft.payloadDigest ||
              receipt.reviewedBy !== draft.reviewedBy || receipt.decision !== 'approve' || receipt.sourceVerified !== true ||
              (protectedMode && receipt.policyVerified !== true)) fail('INVALID_REVIEW_RECEIPT')
          const active = await readOptionalDoc(() => collection.doc('bank').get()); checkBase(active, draft.basePublication)
          if (!Number.isSafeInteger(event.expectedRevision) || event.expectedRevision !== (active ? active.publicationRevision : 0)) fail('STALE_BASE_RELEASE')
          if (protectedMode) {
            const currentPolicy = await readOptionalDoc(() => tx.collection('appConfig').doc('examAccessPolicy').get())
            if ((!active && currentPolicy) || (active && (active.schemaVersion !== 4 || !accessPolicy.validPolicy(active.root, active.publicationRevision, currentPolicy)))) fail('INVALID_ACCESS_POLICY')
          }
          // Both page kinds must still match the approved root inside the activation transaction.
          for (const descriptor of draft.root.pages) {
            const pub = await readOptionalDoc(() => collection.doc(paged.pageDocumentId(draft.root.releaseId, descriptor.index)).get())
            const priv = await readOptionalDoc(() => collection.doc(sourceId(draft.draftId, descriptor.index)).get())
            if (!pub || pub.kind !== 'pagedQuestionBankPage' || !priv || priv.kind !== 'pagedSourcePage' || priv.draftId !== draft.draftId ||
                !paged.validPagePair(draft.root, draft.evidence, pub.page, priv.page)) fail('PAGED_STAGE_CORRUPT')
          }
          const identities = await stageIdentities(collection, draft)
          const releaseRef = collection.doc(draft.root.releaseId), existing = await readOptionalDoc(() => releaseRef.get())
          if (existing && (existing.kind !== 'pagedQuestionBankRelease' || !same(existing.root, draft.root))) fail('RELEASE_CONFLICT')
          await commitIdentities(collection, active, draft.root, identities)
          const revision = (active ? active.publicationRevision : 0) + 1
          if (!Number.isSafeInteger(revision)) fail('BAD_REVISION')
          if (protectedMode && !accessPolicy.validPolicy(draft.root, revision, draft.accessPolicy)) fail('INVALID_ACCESS_POLICY')
          if (!existing) await releaseRef.set({ data: { kind: 'pagedQuestionBankRelease', root: draft.root, publishedAt: Date.now(), publishedBy: actor } })
          await collection.doc('bank_publication_' + revision).set({ data: { kind: 'bankPublication', publicationRevision: revision,
            releaseId: draft.root.releaseId, previousReleaseId: publishedId(active) || null, at: Date.now(), by: actor,
            approval: { draftId: draft.draftId, reviewedBy: draft.reviewedBy, payloadDigest: draft.payloadDigest, sourceVerified: true,
              ...(protectedMode ? { accessPolicyDigest: draft.accessPolicy.digest } : {}) } } })
          if (protectedMode) await tx.collection('appConfig').doc('examAccessPolicy').set({ data: draft.accessPolicy })
          await collection.doc('bank').set({ data: { _id: 'bank', schemaVersion: 4, root: draft.root, publicationRevision: revision,
            workflowVersion: 1, updatedAt: Date.now(), updatedBy: actor } })
          await ref.set({ data: { ...draft, state: 'published', publishedBy: actor, publishedAt: Date.now(), publicationRevision: revision } })
          return { ok: true, releaseId: draft.root.releaseId, publicationRevision: revision }
        }
        fail('BAD_ACTION')
      })
    } catch (e) { return { ok: false, error: e.code || 'PAGED_WORKFLOW_FAILED' } }
  }
}
module.exports = { createPagedWorkflow }
