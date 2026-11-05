/** Marker reads and conditional updates are bound to the protected study context. */
const config = require('./config.js')
const fail = code => { throw Object.assign(new Error(code), { code }) }
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(value)
function createProtectedMarkerClient({ call }) {
  async function request(data, ctx, current) {
    if (!current(ctx)) fail('STALE_CONTEXT')
    let result
    try { result = await call({ ...data, token: ctx.identity.token }) } catch (e) { fail('NETWORK_ERROR') }
    if (!current(ctx)) fail('STALE_CONTEXT')
    if (!result || result.ok !== true) fail(result && /^[A-Z_]+$/.test(result.error || '') ? result.error : 'INVALID_RESPONSE')
    return result
  }
  async function get(examId, ctx, current) {
    if (!id(examId)) fail('BAD_PROTECTED_STATE')
    const result = await request({ action: 'getProtectedMarkers', examId, dataEpoch: ctx.dataEpoch }, ctx, current)
    if (!Number.isSafeInteger(result.revision) || result.revision < 0 || !Array.isArray(result.entries) || result.entries.length > 2000 ||
        result.entries.some(row => !row || !id(row.questionId) || typeof row.starred !== 'boolean' || typeof row.mastered !== 'boolean' ||
          (!row.starred && !row.mastered) || Object.keys(row).sort().join(',') !== 'mastered,questionId,starred') ||
        new Set(result.entries.map(row => row.questionId)).size !== result.entries.length) fail('INVALID_RESPONSE')
    return { revision: result.revision, entries: result.entries }
  }
  async function set(input, ctx, current) {
    if (!input || !id(input.examId) || !id(input.operationId) || !id(input.questionId) || !['starred', 'mastered'].includes(input.field) ||
        typeof input.value !== 'boolean' || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) fail('BAD_PROTECTED_STATE')
    const result = await request({ action: 'setProtectedMarker', ...input, dataEpoch: ctx.dataEpoch }, ctx, current)
    if (typeof result.duplicate !== 'boolean' || result.revision !== input.expectedRevision + 1) fail('INVALID_RESPONSE')
    return { revision: result.revision, duplicate: result.duplicate }
  }
  return { get, set }
}
function runtimeProtectedMarkerClient() {
  return createProtectedMarkerClient({ call: data => new Promise((resolve, reject) => {
    if (!wx.__cloudReady || !wx.cloud || typeof wx.cloud.callFunction !== 'function') { reject(new Error('CLOUD_NOT_READY')); return }
    const success = result => resolve(result && result.result)
    try { const pending = wx.cloud.callFunction({ name: config.functions.bankSync, data, success, fail: reject }); if (pending && typeof pending.then === 'function') pending.then(success, reject) } catch (e) { reject(e) }
  }) })
}
module.exports = { createProtectedMarkerClient, runtimeProtectedMarkerClient }
