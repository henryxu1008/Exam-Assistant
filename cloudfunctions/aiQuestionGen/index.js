const cloud = require('wx-server-sdk')
const { createService } = require('./service.js')
const { createTransport } = require('./transport.js')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const env = process.env
const enabled = env.AI_QUESTION_ENABLED === 'true'
const config = { enabled, configured: !!(env.AI_QUESTION_ENDPOINT && env.AI_QUESTION_API_KEY && env.AI_QUESTION_MODEL),
  globalCap: Number(env.AI_QUESTION_DAILY_CAP || 50), userCap: Number(env.AI_QUESTION_USER_DAILY_CAP || 10), model: env.AI_QUESTION_MODEL || '' }
const callModel = request => createTransport({ endpoint: env.AI_QUESTION_ENDPOINT, apiKey: env.AI_QUESTION_API_KEY, model: env.AI_QUESTION_MODEL })(request)
exports.main = createService({ db: cloud.database(), callModel, config })
