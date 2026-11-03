const cloud = require('wx-server-sdk')
const { createService } = require('./service.js')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
// No runtime flag can open orders before a verified payment adapter and content protection exist.
const service = createService({ db: cloud.database(), allowOrders: false })
exports.main = event => service(event, cloud.getWXContext())
