/** Online only. Never persists question content or trusts client-supplied entitlement. */
const config = require('./config.js')
const qd = require('../shared/question-domain.js')
const exam = require('../shared/exam-catalog-domain.js')
const fail = code => { throw Object.assign(new Error(code), { code }) }
const key = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(value)
const same = (a, b) => qd.canonical(a) === qd.canonical(b)
function createProtectedPracticeClient({ getSession, call }) {
  function capture() {
    const s = getSession()
    if (!s || !s.logged || !s.token || !s.openid) fail('NO_TOKEN')
    return { token: s.token, openid: s.openid }
  }
  function current(ctx) { try { const s = capture(); return s.openid === ctx.openid && s.token === ctx.token } catch (e) { return false } }
  function validateScope(scope, examId, revision) {
    if (!scope || !scope.exam || scope.exam.id !== examId || typeof scope.exam.name !== 'string' || !Array.isArray(scope.subjects) ||
        !/^qb_[a-f0-9]{64}$/.test(scope.releaseId || '') || !Number.isSafeInteger(scope.sourcePageCount) || scope.sourcePageCount < 1 || scope.sourcePageCount > 20 ||
        !Number.isSafeInteger(revision) || revision < 1 || scope.subjects.some(s => !s || !key(s.key) || typeof s.name !== 'string' || !s.name || s.examId !== examId ||
          !Array.isArray(s.chapters) || s.chapters.some(c => !c || !key(c.key) || typeof c.name !== 'string' || !c.name)) ||
        new Set(scope.subjects.map(s => s.key)).size !== scope.subjects.length) fail('INVALID_RESPONSE')
  }
  function validateQuestions(scope, questions) {
    const subjects = new Map(scope.subjects.map(s => [s.key, s])), seen = new Set()
    try {
      for (const q of questions) {
        const subject = q && subjects.get(q.subject)
        if (!subject || !subject.chapters.some(c => c && exam.chapterIdentity(subject.key, c.key) === q.chapter) || seen.has(q.id) || !same(qd.versionQuestion(q), q)) fail('INVALID_RESPONSE')
        seen.add(q.id)
      }
    } catch (e) { fail('INVALID_RESPONSE') }
  }
  async function page(examId, index, baseline, ctx) {
    if (!current(ctx)) fail('STALE_CONTEXT')
    if (!key(examId) || !Number.isSafeInteger(index) || index < 0 || index >= 20 || (!baseline && index !== 0)) fail('BAD_PAGE_QUERY')
    let result
    try { result = await call({ action: 'getProtectedExamPage', token: ctx.token, examId, index, ...(baseline ? { releaseId: baseline.releaseId } : {}) }) } catch (e) { fail('NETWORK_ERROR') }
    if (!current(ctx)) fail('STALE_CONTEXT')
    if (!result || result.ok !== true) fail(result && /^[A-Z_]+$/.test(result.error || '') ? result.error : 'INVALID_RESPONSE')
    const scope = result.scope, data = result.page
    validateScope(scope, examId, result.publicationRevision)
    if (!data || data.releaseId !== scope.releaseId || data.examId !== examId || data.index !== index || index >= scope.sourcePageCount ||
        !Array.isArray(data.questions) || data.questions.length > 100) fail('INVALID_RESPONSE')
    if (baseline && (baseline.releaseId !== scope.releaseId || baseline.publicationRevision !== result.publicationRevision || !same(baseline.scope, scope))) fail('STALE_RELEASE')
    validateQuestions(scope, data.questions)
    return { scope, page: data, baseline: baseline || { releaseId: scope.releaseId, publicationRevision: result.publicationRevision, scope } }
  }
  async function question(examId, questionId, ctx) {
    if (!current(ctx)) fail('STALE_CONTEXT')
    if (!key(examId) || !key(questionId)) fail('BAD_PAGE_QUERY')
    let result
    try { result = await call({ action: 'getProtectedExamQuestion', token: ctx.token, examId, questionId }) } catch (e) { fail('NETWORK_ERROR') }
    if (!current(ctx)) fail('STALE_CONTEXT')
    if (!result || result.ok !== true) fail(result && /^[A-Z_]+$/.test(result.error || '') ? result.error : 'INVALID_RESPONSE')
    const { scope, question: q, cursor } = result
    validateScope(scope, examId, result.publicationRevision)
    if (!q || q.id !== questionId || !cursor || !Number.isSafeInteger(cursor.pageIndex) || cursor.pageIndex < 0 ||
        cursor.pageIndex >= scope.sourcePageCount || !Number.isSafeInteger(cursor.position) || cursor.position < 0 || cursor.position >= 100) fail('INVALID_RESPONSE')
    validateQuestions(scope, [q])
    return { scope, question: q, cursor, baseline: { releaseId: scope.releaseId, publicationRevision: result.publicationRevision, scope } }
  }
  async function scope(examId, ctx) {
    if (!current(ctx)) fail('STAALE_CONTEXT')
    if (!key(examId)) fail('BAD_PAGE_QUERY')
    let result
    try { result = await call({ action: 'getProtectedExamScope', token: ctx.token, examId }) } catch (e) { fail('NETWORK_ERROR') }
    if (!current(ctx)) fail('STALE_CONTEXT')
    if (!result || result.ok !== true) fail(result && /^[A-Z_]+$/.test(result.error || '') ? result.error : 'INVALID_RESPONSE')
    validateScope(result.scope, examId, result.publicationRevision)
    return result.scope
  }
  return { capture, current, page, question, scope }
}
function runtimeProtectedPracticeClient() {
  return createProtectedPracticeClient({ getSession: () => wx.getStorageSync('exam_quiz_session_v1'), call: data => new Promise((resolve, reject) => {
    if (!wx.__cloudReady || !wx.cloud || typeof wx.cloud.callFunction !== 'function') { reject(new Error('CLOUD_NOT_READY')); return }
    const success = result => resolve(result && result.result)
    try { const pending = wx.cloud.callFunction({ name: config.functions.bankSync, data, success, fail: reject }); if (pending && typeof pending.then === 'function') pending.then(success, reject) } catch (e) { reject(e) }
  }) })
}
module.exports = { createProtectedPracticeClient, runtimeProtectedPracticeClient }
