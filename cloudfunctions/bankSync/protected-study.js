/** Content-free protected learning facts; only active in the isolated protected-mode prototype. */
const { readOptionalDoc } = require('./db-error.js')
const { TOKEN_TTL } = require('./auth.js')
const { sha256, canonical } = require('./question-domain.js')
const paged = require('./paged-catalog-domain.js')
const policyDomain = require('./exam-access-policy.js')
const subscription = require('./subscription-domain.js')
const grading = require('./grading-domain.js')
const fail = code => { throw Object.assign(new Error(code), { code }) }
const validId = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(v)
const read = (tx, name, id) => readOptionalDoc(() => tx.collection(name).doc(id).get())
const epochOf = s => s && s.dataEpoch !== undefined ? s.dataEpoch : 0
const headId = (openid, epoch, examId) => 'ph_' + sha256(JSON.stringify([openid, epoch, examId]))
const attemptId = (openid, epoch, operationId) => 'pa_' + sha256(JSON.stringify([openid, epoch, operationId]))
const factFields = ['_id', 'openid', 'dataEpoch', 'operationId', 'requestDigest', 'examId', 'releaseId', 'publicationRevision',
  'questionId', 'questionVersionId', 'subject', 'chapter', 'selected', 'score', 'costMs', 'createdAt', 'sequence']
const factChecksum = fact => sha256(canonical(Object.fromEntries(factFields.map(key => [key, fact[key]]))))
function validFact(a, openid, epoch) {
  if (!a || a.openid !== openid || a.dataEpoch !== epoch || !validId(a.operationId) || a._id !== attemptId(openid, epoch, a.operationId) ||
      !validId(a.examId) || !/^qb_[a-f0-9]{64}$/.test(a.releaseId || '') || !validId(a.questionId) || !/^qv_[a-f0-9]{64}$/.test(a.questionVersionId || '') ||
      !validId(a.subject) || !validId(a.chapter) || !Array.isArray(a.selected) || !a.selected.length || a.selected.length > 30 ||
      a.selected.some(v => typeof v !== 'string' || v.length > 10000) || ![0, 1].includes(a.score) ||
      !Number.isSafeInteger(a.costMs) || a.costMs < 0 || a.costMs > 86400000 || !Number.isSafeInteger(a.createdAt) || a.createdAt < 0 ||
      !Number.isSafeInteger(a.sequence) || a.sequence < 1 || !Number.isSafeInteger(a.publicationRevision) || a.publicationRevision < 1) return false
  const input = { examId: a.examId, releaseId: a.releaseId, publicationRevision: a.publicationRevision, questionId: a.questionId,
    questionVersionId: a.questionVersionId, selected: a.selected, costMs: a.costMs }
  return a.requestDigest === sha256(canonical(input)) && a.factDigest === factChecksum(a)
}
const publicFact = a => ({ id: a._id, examId: a.examId, releaseId: a.releaseId, questionId: a.questionId, questionVersionId: a.questionVersionId,
  subject: a.subject, chapter: a.chapter, selected: a.selected, score: a.score, costMs: a.costMs, createdAt: a.createdAt, sequence: a.sequence })
function validHead(head, openid, epoch, examId) {
  return head && (head._id === undefined || head._id === headId(openid, epoch, examId)) && head.openid === openid && head.dataEpoch === epoch && head.examId === examId &&
    Number.isSafeInteger(head.sequence) && head.sequence >= 0 && Number.isSafeInteger(head.correct) && head.correct >= 0 && head.correct <= head.sequence
}
function createProtectedStudy({ db, now = () => Date.now() }) {
  return async (event = {}, context = {}) => {
    try {
      if (!['commitProtectedAttempt', 'getProtectedAttempts'].includes(event.action)) fail('BAD_ACTION')
      if (!validId(event.examId) || !Number.isSafeInteger(event.dataEpoch) || event.dataEpoch < 0) fail('BAD_PROTECTED_STUDY')
      if (typeof event.token !== 'string' || !event.token || !validId(context.OPENID)) fail('INVALID_TOKEN')
      const found = await db.collection('users').where({ token: event.token }).limit(1).get(), user = found && Array.isArray(found.data) && found.data[0]
      if (!user || !user._id || user.openid !== context.OPENID) fail('INVALID_TOKEN')
      const actor = context.OPENID, hId = headId(actor, event.dataEpoch, event.examId)
      const verifyIdentity = async tx => {
        const current = await read(tx, 'users', user._id), at = now()
        if (!current || current.openid !== actor || current.token !== event.token || !Number.isSafeInteger(current.tokenAt) || current.tokenAt <= 0 ||
            !Number.isSafeInteger(at) || current.tokenAt > at || at - current.tokenAt > TOKEN_TTL) fail('INVALID_TOKEN')
        const stats = await read(tx, 'studyStats', actor), epoch = epochOf(stats)
        if (!Number.isSafeInteger(epoch) || epoch < 0) fail('INVALID_EPOCH')
        if (epoch !== event.dataEpoch) fail('STALE_EPOCH')
        return at
      }
      if (event.action === 'commitProtectedAttempt') {
        if (!validId(event.operationId) || !validId(event.questionId) || !/^qv_[a-f0-9]{64}$/.test(event.questionVersionId || '') ||
            !/^qb_[a-f0-9]{64}$/.test(event.releaseId || '') || !Number.isSafeInteger(event.publicationRevision) || event.publicationRevision < 1 ||
            !Array.isArray(event.selected) || event.selected.length > 30 || !Number.isSafeInteger(event.costMs) || event.costMs < 0 || event.costMs > 86400000) fail('BAD_PROTECTED_ATTEMPT')
        const input = { examId: event.examId, releaseId: event.releaseId, publicationRevision: event.publicationRevision, questionId: event.questionId,
          questionVersionId: event.questionVersionId, selected: event.selected, costMs: event.costMs }
        const requestDigest = sha256(canonical(input)), id = attemptId(actor, event.dataEpoch, event.operationId)
        return await db.runTransaction(async tx => {
          const at = await verifyIdentity(tx)
          const previous = await read(tx, 'protectedAttempts', id)
          if (previous) {
            if (!validFact(previous, actor, event.dataEpoch)) fail('INVALID_PROTECTED_ATTEMPTS')
            if (previous.requestDigest !== requestDigest) fail('OPERATION_CONFLICT')
            return { ok: true, duplicate: true, attempt: publicFact(previous) }
          }
          const active = await read(tx, 'questions', 'bank')
          if (!active || active.schemaVersion !== 4 || !paged.validRoot(active.root) || active.root.releaseId !== event.releaseId || active.publicationRevision !== event.publicationRevision) fail('STALE_RELEASE')
          const scope = active.root.manifest.exams.find(e => e.id === event.examId)
          if (!scope) fail('EXAM_NOT_FOUND')
          const policy = await read(tx, 'appConfig', 'examAccessPolicy')
          if (!policyDomain.validPolicy(active.root, active.publicationRevision, policy)) fail('INVALID_ACCESS_POLICY')
          const rule = policy.entries.find(e => e.examId === event.examId)
          if (!rule) fail('INVALID_ACCESS_POLICY')
          if (rule.access === 'paid') {
            const timeline = await read(tx, 'commerceTimelines', subscription.timelineId(actor, event.examId))
            if (subscription.activeUntil(timeline, actor, event.examId, at) === null) fail('ENTITLEMENT_REQUIRED')
          }
          const archive = await read(tx, 'questions', event.releaseId)
          if (!archive || archive.kind !== 'pagedQuestionBankRelease' || !paged.validRoot(archive.root) || archive.root.releaseId !== event.releaseId ||
              !Number.isSafeInteger(archive.publishedAt) || archive.publishedAt < 0) fail('INVALID_RELEASE')
          const pageIndex = paged.findPageIndex(active.root, event.questionId)
          if (pageIndex < 0) fail('PUBLISHED_QUESTION_NOT_FOUND')
          const page = await read(tx, 'questions', paged.pageDocumentId(event.releaseId, pageIndex))
          if (!page || page.kind !== 'pagedQuestionBankPage' || !paged.validQuestionPage(active.root, page.page)) fail('INVALID_PUBLISHED_PAGE')
          const question = paged.findQuestion(active.root, page.page, event.questionId, event.questionVersionId)
          if (!question || !active.root.manifest.subjects.some(s => s.key === question.subject && s.examId === event.examId)) fail('PUBLISHED_QUESTION_NOT_FOUND')
          if (!grading.validSelection(question, event.selected)) fail('BAD_SELECTION')
          const head = await read(tx, 'protectedStudyHeads', hId) || { openid: actor, dataEpoch: event.dataEpoch, examId: event.examId, sequence: 0, correct: 0 }
          if (!validHead(head, actor, event.dataEpoch, event.examId) || head.sequence >= Number.MAX_SAFE_INTEGER) fail('INVALID_PROTECTED_HEAD')
          const score = grading.judge(question.type, event.selected, question.answer) ? 1 : 0
          const record = { _id: id, openid: actor, dataEpoch: event.dataEpoch, operationId: event.operationId, requestDigest,
            examId: event.examId, releaseId: event.releaseId, publicationRevision: event.publicationRevision, questionId: question.id, questionVersionId: question.versionId,
            subject: question.subject, chapter: question.chapter, selected: event.selected, score, costMs: event.costMs, createdAt: at, sequence: head.sequence + 1 }
          record.factDigest = factChecksum(record)
          await tx.collection('protectedAttempts').doc(id).set({ data: record })
          await tx.collection('protectedStudyHeads').doc(hId).set({ data: { ...head, _id: hId, sequence: record.sequence, correct: head.correct + score } })
          return { ok: true, duplicate: false, attempt: publicFact(record) }
        })
      }
      if (!Number.isSafeInteger(event.afterSequence) || event.afterSequence < 0 || !Number.isSafeInteger(event.limit) || event.limit < 1 || event.limit > 100 ||
          (event.snapshotSequence !== undefined && (!Number.isSafeInteger(event.snapshotSequence) || event.snapshotSequence < 0))) fail('BAD_CURSOR')
      const before = await db.runTransaction(async tx => { await verifyIdentity(tx); return await read(tx, 'protectedStudyHeads', hId) })
      if (before && !validHead(before, actor, event.dataEpoch, event.examId)) fail('INVALID_PROTECTED_HEAD')
      const sequence = before ? before.sequence : 0, correct = before ? before.correct : 0
      if ((event.snapshotSequence !== undefined && event.snapshotSequence !== sequence) || event.afterSequence > sequence) fail('SNAPSHOT_CHANGED')
      const result = await db.collection('protectedAttempts').where({ openid: actor, dataEpoch: event.dataEpoch, examId: event.examId,
        sequence: db.command.gt(event.afterSequence) }).orderBy('sequence', 'asc').limit(event.limit).get()
      if (!result || !Array.isArray(result.data) || result.data.length > event.limit) fail('READ_ATTEMPTS_FAILED')
      let prev = event.afterSequence
      for (const row of result.data) {
        if (!validFact(row, actor, event.dataEpoch) || row.examId !== event.examId || row.sequence !== prev + 1 || row.sequence > sequence) fail('INVALID_PROTECTED_ATTEMPTS')
        prev = row.sequence
      }
      if (prev < sequence && result.data.length < event.limit) fail('INVALID_PROTECTED_ATTEMPTS')
      const after = await db.runTransaction(async tx => { await verifyIdentity(tx); return await read(tx, 'protectedStudyHeads', hId) })
      if ((after ? after.sequence : 0) !== sequence || (after ? after.correct : 0) !== correct || (after && !validHead(after, actor, event.dataEpoch, event.examId))) fail('SNAPSHOT_CHANGED')
      return { ok: true, attempts: result.data.map(publicFact), snapshotSequence: sequence, correct, hasMore: prev < sequence, nextSequence: prev }
    } catch (e) { return { ok: false, error: /^[A-Z_]+$/.test(e.code || '') ? e.code : 'PROTECTED_STUDY_FAILED' } }
  }
}
module.exports = { createProtectedStudy }
