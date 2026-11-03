const config = require('./config.js')
const fail = code => { throw Object.assign(new Error(code), { code }) }
function createCommerceAdmin({ getSession, call }) {
  function capture() {
    const s = getSession()
    if (!s || !s.logged || !s.token || !s.openid) fail('NO_TOKEN')
    return { token: s.token, openid: s.openid }
  }
  function current(ctx) { try { const s = capture(); return s.token === ctx.token && s.openid === ctx.openid } catch (e) { return false } }
  async function request(data, ctx = capture()) {
    if (!current(ctx)) fail('STALE_CONTEXT')
    let result
    try { result = await call({ ...data, token: ctx.token }) } catch (e) { fail('NETWORK_ERROR') }
    if (!current(ctx)) fail('STALE_CONTEXT')
    if (!result || result.ok !== true) fail(result && /^[A-Z_]+$/.test(result.error || '') ? result.error : 'INVALID_RESPONSE')
    return result
  }
  return { capture, current, access: () => request({ action: 'getManageAccess' }),
    catalog: () => request({ action: 'getManageCatalog' }),
    product: examId => request({ action: 'getManageProduct', examId }),
    save: (product, expectedRevision) => request({ action: 'putProduct', product, expectedRevision }) }
}
function runtimeCommerceAdmin() {
  return createCommerceAdmin({ getSession: () => wx.getStorageSync('exam_quiz_session_v1'), call: data => new Promise((resolve, reject) => {
    if (!wx.__cloudReady || !wx.cloud || typeof wx.cloud.callFunction !== 'function') { reject(new Error('CLOUD_NOT_READY')); return }
    const success = result => resolve(result && result.result)
    try { const pending = wx.cloud.callFunction({ name: config.functions.commerce, data, success, fail: reject }); if (pending && typeof pending.then === 'function') pending.then(success, reject) } catch (e) { reject(e) }
  }) })
}
module.exports = { createCommerceAdmin, runtimeCommerceAdmin }
