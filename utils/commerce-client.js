const config = require('./config.js')
const fail = code => { throw Object.assign(new Error(code), { code }) }
function createCommerceClient({ getSession, call }) {
  function capture() {
    const s = getSession()
    if (!s || !s.logged || !s.token || !s.openid) fail('NO_TOKEN')
    return { token: s.token, openid: s.openid }
  }
  function current(ctx) { try { const s = capture(); return s.token === ctx.token && s.openid === ctx.openid } catch (e) { return false } }
  async function plans(examId, ctx = capture()) {
    if (!current(ctx)) fail('STALE_CONTEXT')
    let result
    try { result = await call({ action: 'getExamPlans', examId, token: ctx.token }) } catch (e) { fail('NETWORK_ERROR') }
    if (!current(ctx)) fail('STALE_CONTEXT')
    if (!result || result.ok !== true) fail(result && /^[A-Z_]+$/.test(result.error || '') ? result.error : 'INVALID_RESPONSE')
    const sub = result.subscription
    if (!result.exam || result.exam.id !== examId || typeof result.exam.name !== 'string' || !Array.isArray(result.plans) ||
        !sub || typeof sub.active !== 'boolean' || (sub.active ? !Number.isSafeInteger(sub.endAt) : sub.endAt !== null) ||
        result.purchasingAvailable !== false || result.plans.some(p => !p || typeof p.id !== 'string' || typeof p.name !== 'string' ||
          ![30, 90, 365].includes(p.durationDays) || !Number.isSafeInteger(p.priceFen) || p.priceFen < 0)) fail('INVALID_RESPONSE')
    return result
  }
  return { capture, current, plans }
}
function runtimeCommerceClient() {
  return createCommerceClient({ getSession: () => wx.getStorageSync('exam_quiz_session_v1'), call: data => new Promise((resolve, reject) => {
    if (!wx.__cloudReady || !wx.cloud || typeof wx.cloud.callFunction !== 'function') { reject(new Error('CLOUD_NOT_READY')); return }
    const success = result => resolve(result && result.result)
    try { const pending = wx.cloud.callFunction({ name: config.functions.commerce, data, success, fail: reject }); if (pending && typeof pending.then === 'function') pending.then(success, reject) } catch (e) { reject(e) }
  }) })
}
module.exports = { createCommerceClient, runtimeCommerceClient }
