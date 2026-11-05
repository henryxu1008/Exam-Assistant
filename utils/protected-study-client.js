/** Snapshot-consistent, account-bound protected fact client; caller owns durable operation IDs. */
const config = require('./config.js')
const { canonical } = require('../shared/question-domain.js')
const fail = code => { throw Object.assign(new Error(code), { code }) }
const key = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(value)
const fields = ['id', 'examId', 'releaseId', 'questionId', 'questionVersionId', 'subject', 'chapter', 'selected', 'score', 'costMs', 'createdAt', 'sequence'].sort()
function validFact(a, examId) {
  return a && canonical(Object.keys(a).sort()) === canonical(fields) && /^pa_[a-f0-9]{64}$/.test(a.id || '') && a.examId === examId &&
    /^qb_[a-f0-9]{64}$/.test(a.releaseId || '') && key(a.questionId) && /^qv_[a-f0-9]{64}$/.test(a.questionVersionId || '') &&
    key(a.subject) && key(a.chapter) && Array.isArray(a.selected) && a.selected.length > 0 && a.selected.length <= 30 &&
    a.selected.every(v => typeof v === 'string' && v.length <= 10000) && [0, 1].includes(a.score) &&
    Number.isSafeInteger(a.costMs) && a.costMs >= 0 && a.costMs <= 86400000 && Number.isSafeInteger(a.createdAt) && a.createdAt >= 0 &&
    Number.isSafeInteger(a.sequence) && a.sequence >= 1
}
function createProtectedStudyClient({ getSession, call }) {
  function capture() {
    const s = getSession()
    if (!s || !s.logged || !s.token || !s.openid) fail('NO_TOKEN')
    return { token: s.token, openid: s.openid }
  }
  function current(ctx) { try { const s = capture(); return ctx && s.token === ctx.token && s.openid === ctx.openid } catch (e) { return false } }
  async function request(data, ctx) {
    if (!current(ctx)) fail('STALE_CONTEXT')
    let response
    try { response = await call({ ...data, token: ctx.token }) } catch (e) { fail('NETWORK_ERROR') }
    if (!current(ctx)) fail('STALE_CONTEXT')
    if (!response || response.ok !== true) fail(response && /^[A-Z_]+$/.test(response.error || '') ? response.error : 'INVALID_RESPONSE')
    return response
  }
  async function commit(input, ctx) {
    if (!input || !key(input.examId) || !key(input.operationId) || !Number.isSafeInteger(input.dataEpoch) || input.dataEpoch < 0) fail('BAD_PROTECTED_ATTEMPT')
    const result = await request({ action: 'commitProtectedAttempt', examId: input.examId, dataEpoch: input.dataEpoch, operationId: input.operationId,
      releaseId: input.releaseId, publicationRevision: input.publicationRevision, questionId: input.questionId,
      questionVersionId: input.questionVersionId, selected: input.selected, costMs: input.costMs }, ctx)
    const fact = result.attempt
    if (typeof result.duplicate !== 'boolean' || !validFact(fact, input.examId) || fact.releaseId !== input.releaseId ||
        fact.questionId !== input.questionId || fact.questionVersionId !== input.questionVersionId || fact.costMs !== input.costMs ||
        canonical(fact.selected) !== canonical(input.selected)) fail('INVALID_RESPONSE')
    return { attempt: fact, duplicate: result.duplicate }
  }
  async function restore(examId, dataEpoch, ctx) {
    if (!key(examId) || !Number.isSafeInteger(dataEpoch) || dataEpoch < 0) fail('BAD_CURSOR')
    let afterSequence = 0, snapshotSequence, correct, resultRows = []
    const seen = new Set()
    for (let round = 0; round < 100; round++) {
      const result = await request({ action: 'getProtectedAttempts', examId, dataEpoch, afterSequence, limit: 100,
        ...(snapshotSequence === undefined ? {} : { snapshotSequence }) }, ctx)
      if (!Array.isArray(result.attempts) || result.attempts.length > 100 || !Number.isSafeInteger(result.snapshotSequence) || result.snapshotSequence < 0 ||
          !Number.isSafeInteger(result.correct) || result.correct < 0 || result.correct > result.snapshotSequence || typeof result.hasMore !== 'boolean' ||
          !Number.isSafeInteger(result.nextSequence) || result.nextSequence < afterSequence ||
          (snapshotSequence !== undefined && (result.snapshotSequence !== snapshotSequence || result.correct !== correct))) fail('INVALID_RESPONSE')
      snapshotSequence = result.snapshotSequence; correct = result.correct
      for (const row of result.attempts) {
        if (!validFact(row, examId) || row.sequence !== afterSequence + 1 || seen.has(row.id)) fail('INVALID_RESPONSE')
        seen.add(row.id)
        afterSequence = row.sequence
      }
      if (result.nextSequence !== afterSequence || result.hasMore !== (afterSequence < snapshotSequence)) fail('INVALID_RESPONSE')
      resultRows = resultRows.concat(result.attempts)
      if (!result.hasMore) {
        if (afterSequence !== snapshotSequence || resultRows.reduce((sum, row) => sum + row.score, 0) !== correct) fail('INVALID_RESPONSE')
        return { attempts: resultRows, snapshotSequence, correct }
      }
      if (!result.attempts.length) fail('INVALID_RESPONSE')
    }
    fail('PROTECTED_HISTORY_TOO_LARGE')
  }
  return { capture, current, commit, restore }
}
function runtimeProtectedStudyClient() {
  return createProtectedStudyClient({ getSession: () => wx.getStorageSync('exam_quiz_session_v1'), call: data => new Promise((resolve, reject) => {
    if (!wx.__cloudReady || !wx.cloud || typeof wx.cloud.callFunction !== 'function') { reject(new Error('CLOUD_NOT_READY')); return }
    const success = result => resolve(result && result.result)
    try { const pending = wx.cloud.callFunction({ name: config.functions.bankSync, data, success, fail: reject }); if (pending && typeof pending.then === 'function') pending.then(success, reject) } catch (e) { reject(e) }
  }) })
}
module.exports = { createProtectedStudyClient, runtimeProtectedStudyClient }
