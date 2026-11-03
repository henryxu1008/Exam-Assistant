/** Generates private candidates; never writes a catalog or publishes questions. */
const { findByToken, TOKEN_TTL } = require('./auth.js')
const { readOptionalDoc } = require('./db-error.js')
const { validRoles } = require('./workflow-domain.js')
const { sha256 } = require('./question-domain.js')
const candidate = require('./ai-question-domain.js')
const fail = code => { throw Object.assign(new Error(code), { code }) }
function createService({ db, callModel, solveModel, critiqueModel, config, now = () => Date.now() }) {
  async function authorize(tx, user, token) {
    const identity = await readOptionalDoc(() => tx.collection('users').doc(user._id).get())
    const roles = await readOptionalDoc(() => tx.collection('appConfig').doc('bankRoles').get())
    if (!identity || identity.openid !== user.openid || identity.token !== token || !identity.tokenAt || now() - identity.tokenAt > TOKEN_TTL) fail('INVALID_TOKEN')
    if (!validRoles(roles)) fail('ROLE_CONFIG_REQUIRED')
    if (!roles.editors.includes(identity.openid)) fail('NOT_CATALOG_ROLE')
  }
  return async event => {
    try {
      const request = candidate.validateRequest(event)
      if (!config.enabled || !config.configured) fail('AI_GENERATION_DISABLED')
      if (!Number.isSafeInteger(config.globalCap) || config.globalCap < 1 || !Number.isSafeInteger(config.userCap) || config.userCap < 1 ||
          typeof config.model !== 'string' || !config.model.trim() || config.model.length > 160) fail('AI_GENERATION_CONFIG_INVALID')
      if (typeof db.runTransaction !== 'function') fail('TRANSACTION_REQUIRED')
      const user = await findByToken(db.collection('users'), event.token)
      if (!user || !user._id || !user.openid) fail('INVALID_TOKEN')
      const reserve = () => db.runTransaction(async tx => {
        await authorize(tx, user, event.token)
        const day = new Date(now()).toISOString().slice(0, 10), usage = tx.collection('aiQuestionUsage')
        const globalRef = usage.doc('global_' + day), userRef = usage.doc('user_' + day + '_' + sha256(user.openid))
        const total = await readOptionalDoc(() => globalRef.get()), mine = await readOptionalDoc(() => userRef.get())
        if ((total && (!Number.isSafeInteger(total.count) || total.count < 0)) || (mine && (!Number.isSafeInteger(mine.count) || mine.count < 0))) fail('AI_QUOTA_INVALID')
        const globalCount = total ? total.count : 0, userCount = mine ? mine.count : 0
        if (globalCount >= config.globalCap || userCount >= config.userCap) fail('AI_QUOTA_EXCEEDED')
        await globalRef.set({ data: { day, count: globalCount + 1 } })
        await userRef.set({ data: { day, count: userCount + 1 } })
      })
      const reviewer = config.reviewerModel || config.model
      if (config.reviewConfigured === false || typeof solveModel !== 'function' || typeof critiqueModel !== 'function' || typeof reviewer !== 'string' || !reviewer.trim() || reviewer.length > 160) fail('AI_REVIEW_CONFIG_INVALID')
      await reserve()
      const output = await callModel(request)
      if (!output || !Array.isArray(output.questions)) fail('BAD_AI_RESPONSE')
      const questions = candidate.normalize(output.questions, request, user.openid)
      // The solver sees only the stem/options and scope, never the proposed answer or explanation.
      const blind = { examName: request.examName, subjectName: request.subjectName, chapterName: request.chapterName, topic: request.topic,
        questions: questions.map(q => ({ id: q.id, type: q.type, stem: q.stem, options: q.options })) }
      await reserve()
      const solved = await solveModel(blind)
      const answers = solved && solved.answers
      candidate.buildReviews(questions, answers, questions.map(q => ({ id: q.id, issues: [] })))
      await reserve()
      const checked = await critiqueModel({ ...blind, questions: questions.map(q => ({ id: q.id, type: q.type, stem: q.stem,
        options: q.options, answer: q.answer, explain: q.explain })), independentAnswers: answers })
      const reviews = checked && checked.reviews
      candidate.buildReviews(questions, answers, reviews)
      await db.runTransaction(tx => authorize(tx, user, event.token))
      return { ok: true, questions, generator: config.model, reviewer, reviewEvidence: { answers, reviews } }
    } catch (e) {
      return { ok: false, error: /^[A-Z_]+$/.test(e.code || '') ? e.code : 'AI_GENERATION_FAILED' }
    }
  }
}
module.exports = { createService }
