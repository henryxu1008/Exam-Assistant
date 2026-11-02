const { harness } = require('./bank-harness.js')
const { createCatalogAdmin } = require('../../utils/catalog-admin.js')
function operators() {
  const h = harness()
  for (const id of ['editor', 'reviewer', 'publisher']) h.users.set(id, { _id: id, openid: id, token: id, tokenAt: Date.parse('2026-10-30T06:00:00Z') })
  h.config.set('bankRoles', { editors: ['editor'], reviewers: ['reviewer'], publishers: ['publisher'] })
  const clients = Object.fromEntries(['editor', 'reviewer', 'publisher'].map(id => [id, createCatalogAdmin({
    getSession: () => ({ logged: true, openid: id, token: id }), call: async data => JSON.parse(JSON.stringify(await h.main(data)))
  })]))
  return { h, ...clients, async approve(draftId) { return clients.reviewer.review({ draftId, decision: 'approve', note: '已核对合成测试题及来源', sourceVerified: true }) } }
}
module.exports = { operators }
