/** Authenticated client for private AI question candidates. */
const config = require('./config.js')
const domain = require('../shared/ai-question-domain.js')
const fail = code => { throw Object.assign(new Error(code), { code }) }
function createAiQuestionGenerator({ getSession, call }) {
  function capture() {
    const s = getSession()
    if (!s || !s.logged || typeof s.token !== 'string' || !s.token || typeof s.openid !== 'string' || !s.openid) fail('NO_TOKEN')
    return { token: s.token, openid: s.openid }
  }
  function current(ctx) { try { const s = capture(); return s.token === ctx.token && s.openid === ctx.openid } catch (e) { return false } }
  async function generate(input, live = () => true) {
    const ctx = capture(), request = domain.validateRequest(input)
    if (!live() || !current(ctx)) fail('STALE_OPERATOR_CONTEXT')
    let result
    try { result = await call({ ...request, token: ctx.token }) } catch (e) { fail('NETWORK_ERROR') }
    if (!live() || !current(ctx)) fail('STALE_OPERATOR_CONTEXT')
    if (!result || result.ok !== true) fail(result && /^[A-Z_]+$/.test(result.error || '') ? result.error : 'BAD_AI_RESPONSE')
    return domain.validateCandidates(result, request, ctx.openid)
  }
  return { generate }
}
function runtimeAiQuestionGenerator() {
  return createAiQuestionGenerator({ getSession: () => wx.getStorageSync('exam_quiz_session_v1'), call: data => new Promise((resolve, reject) => {
    if (!wx.__cloudReady || !wx.cloud || typeof wx.cloud.callFunction !== 'function') return reject(new Error('CLOUD_NOT_READY'))
    const success = response => resolve(response && response.result)
    try {
      const pending = wx.cloud.callFunction({ name: config.functions.aiQuestionGen, data, success, fail: reject })
      if (pending && typeof pending.then === 'function') pending.then(success, reject)
    } catch (e) { reject(e) }
  }) })
}
module.exports = { createAiQuestionGenerator, runtimeAiQuestionGenerator }
