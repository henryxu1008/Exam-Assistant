/** Account-bound published exam metadata. Question content is never cached here. */
const config = require('./config.js')
const store = require('./store.js')
const fail = code => { throw Object.assign(new Error(code), { code }) }
const validId = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(v)
const copy = v => JSON.parse(JSON.stringify(v))
function createProtectedCatalog({ getSession, captureSync, syncCurrent, call }) {
  let data = null, generation = 0
  function capture() {
    const s = getSession(), sync = captureSync()
    if (!s || !s.logged || !s.token || !s.openid || !sync || sync.scope !== s.openid || sync.token !== s.token) fail('NO_TOKEN')
    return { token: s.token, openid: s.openid, sync }
  }
  function current(ctx) {
    try { const s = getSession(); return !!ctx && !!s && s.logged && s.token === ctx.token && s.openid === ctx.openid && syncCurrent(ctx.sync) }
    catch (e) { return false }
  }
  function read() { if (!data || !current(data.ctx)) { data = null; return null }; return data }
  async function load() {
    const ctx = capture(), request = ++generation
    let result
    try { result = await call({ action: 'getProtectedExamCatalog', token: ctx.token }) } catch (e) { if (request === generation) data = null; fail('NETWORK_ERROR') }
    if (!current(ctx) || request !== generation) fail('STALE_CONTEXT')
    if (!result || result.ok !== true) { data = null; fail(result && /^[A-Z_]+$/.test(result.error || '') ? result.error : 'INVALID_RESPONSE') }
    const exams = result.exams, subjects = result.subjects
    if (!Array.isArray(exams) || !Array.isArray(subjects) || !/^qb_[a-f0-9]{64}$/.test(result.releaseId || '') ||
        !Number.isSafeInteger(result.publicationRevision) || result.publicationRevision < 1 ||
        exams.some(e => !e || !validId(e.id) || typeof e.name !== 'string' || !e.name) ||
        new Set(exams.map(e => e.id)).size !== exams.length || subjects.some(s => !s || !validId(s.key) || typeof s.name !== 'string' || !s.name ||
          !exams.some(e => e.id === s.examId) || !Array.isArray(s.chapters) || s.chapters.some(c => !c || !validId(c.key) || typeof c.name !== 'string' || !c.name)) ||
        new Set(subjects.map(s => s.key)).size !== subjects.length) { data = null; fail('INVALID_RESPONSE') }
    const previous = read(), selected = previous && exams.some(e => e.id === previous.selected) ? previous.selected : (exams[0] && exams[0].id || '')
    data = { ctx, exams: exams.map(e => ({ id: e.id, name: e.name })), subjects: subjects.map(s => ({ key: s.key, name: s.name, examId: s.examId, chapters: s.chapters.map(c => ({ key: c.key, name: c.name })) })), selected, releaseId: result.releaseId, publicationRevision: result.publicationRevision }
    return snapshot()
  }
  function snapshot() {
    const s = read()
    return s ? { exams: copy(s.exams), subjects: copy(s.subjects.filter(subject => subject.examId === s.selected)), selected: s.selected } : null
  }
  function select(examId) { const s = read(); if (!s || !s.exams.some(e => e.id === examId)) return false; s.selected = examId; return true }
  function getCurrentExam() { const s = read(); return s ? s.selected : '' }
  function clear() { generation++; data = null }
  return { load, snapshot, select, getCurrentExam, clear }
}
let runtime
function runtimeProtectedCatalog() {
  if (!runtime) runtime = createProtectedCatalog({ getSession: () => wx.getStorageSync('exam_quiz_session_v1'),
    captureSync: () => store.captureProtectedSyncContext(), syncCurrent: ctx => store.isProtectedSyncContextCurrent(ctx),
    call: data => new Promise((resolve, reject) => {
      if (!wx.__cloudReady || !wx.cloud || typeof wx.cloud.callFunction !== 'function') { reject(new Error('CLOUD_NOT_READY')); return }
      const success = result => resolve(result && result.result)
      try { const pending = wx.cloud.callFunction({ name: config.functions.bankSync, data, success, fail: reject }); if (pending && typeof pending.then === 'function') pending.then(success, reject) } catch (e) { reject(e) }
    }) })
  return runtime
}
function currentExam() { return config.protectedCatalog === true ? runtimeProtectedCatalog().getCurrentExam() : store.getCurrentExam() }
module.exports = { createProtectedCatalog, runtimeProtectedCatalog, currentExam }
