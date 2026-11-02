require('./wx-shim.js')
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const user = require('../utils/user.js')
const { operators } = require('./support/catalog-operators.js')
const { createCatalogAdmin } = require('../utils/catalog-admin.js')
let definition
global.Page = value => { definition = value }
require('../pages/catalog-admin/catalog-admin.js')
const sample = fs.readFileSync(path.join(__dirname, '../docs/examples/catalog-import.json'), 'utf8')
const settle = () => new Promise(setImmediate)
function page(t, client) {
  t.mock.method(user, 'requireLogin', cb => { cb(); return true })
  const p = Object.assign({}, definition, { data: JSON.parse(JSON.stringify(definition.data)), setData(value) { Object.assign(this.data, value) } })
  p.onLoad(); p._client = client; p.onShow()
  t.after(() => p.onUnload())
  return p
}
const input = (p, field, value) => p.onInput({ currentTarget: { dataset: { field } }, detail: { value } })

test('管理页导入预检、确认和提交，修改内容后必须重新预检/确认', async t => {
  const ops = operators(), p = page(t, ops.editor); await settle()
  assert.equal(p.data.canEdit, true); assert.equal(p.data.canReview, false)
  input(p, 'inputText', sample); p.onCheck()
  assert.equal(p.data.ready, true)
  input(p, 'submissionId', 'page-import')
  p.onSubmit(); await settle()
  assert.equal(p.data.error, 'RIGHTS_CONFIRMATION_REQUIRED')
  p.onConfirm({ detail: { value: ['rights'] } }); p.onSubmit(); await settle()
  assert.match(p.data.draftId, /^qd_/)
  assert.equal(ops.h.bank(), null)
  input(p, 'inputText', sample + '\n')
  assert.equal(p.data.ready, false); assert.equal(p.data.rightsConfirmed, false)
  assert.equal(p.data.report.includes('synthetic:'), false)
  input(p, 'inputText', 'x'.repeat(200001))
  assert.equal(p.data.inputText, ''); assert.equal(p.data.ready, false)
  assert.equal(p.data.error, 'INPUT_TOO_LARGE_FOR_PAGE', '超限必须拒绝，不能截断成可提交的部分 CSV')
})

test('审核与发布前必须读取匹配草稿，切换草稿清除原核验状态', async t => {
  const ops = operators(), draft = await ops.editor.submitDraft(JSON.parse(sample), { submissionId: 'draft', rightsConfirmed: true })
  const p = page(t, ops.reviewer); await settle()
  input(p, 'draftId', draft.draftId)
  p.onReview({ currentTarget: { dataset: { decision: 'approve' } } })
  assert.equal(p.data.error, 'READ_DRAFT_REQUIRED')
  p.onReadDraft(); await settle()
  assert.ok(p.data.preview.includes('合成工具样例'))
  input(p, 'note', '已核验测试来源'); p.onConfirm({ detail: { value: ['sources'] } })
  p.onReview({ currentTarget: { dataset: { decision: 'approve' } } }); await settle()
  assert.equal(ops.h.documents.get(draft.draftId).state, 'approved')
  input(p, 'draftId', 'another')
  assert.equal(p.data.preview, ''); assert.equal(p.data.sourceVerified, false)
  p.onPublish(); assert.equal(p.data.error, 'READ_DRAFT_REQUIRED')
})

test('页面隐藏或账号切换后，旧权限/私有草稿响应不能进入新页面', async t => {
  const ops = operators()
  let session = { logged: true, openid: 'editor', token: 'editor' }, release
  const gate = new Promise(resolve => { release = resolve })
  const client = createCatalogAdmin({ getSession: () => session, call: async data => {
    const result = await ops.h.main(data)
    if (data.token === 'editor') await gate
    return result
  } })
  const p = page(t, client)
  p.onHide(); session = { logged: true, openid: 'reviewer', token: 'reviewer' }; p.onShow(); await settle()
  assert.equal(p.data.canReview, true); assert.equal(p.data.canEdit, false)
  release(); await settle()
  assert.equal(p.data.canReview, true); assert.equal(p.data.canEdit, false)
  assert.equal(p.data.inputText, ''); assert.equal(p.data.preview, '')
})

test('延迟登录回调不能越过新一轮页面生命周期，隐藏页不能发起写操作', async t => {
  const ops = operators(), p = page(t, ops.editor); await settle()
  const callbacks = []
  t.mock.method(user, 'requireLogin', cb => { callbacks.push(cb); return true })
  p.onHide(); p.onShow(); p.onHide(); p.onShow()
  assert.equal(p.data.allowed, false)
  callbacks[0](); await settle(); assert.equal(p.data.allowed, false)
  callbacks[1](); await settle(); assert.equal(p.data.allowed, true)
  input(p, 'inputText', sample); p.onCheck(); input(p, 'submissionId', 'hidden')
  p.onConfirm({ detail: { value: ['rights'] } }); p.onHide(); p.onSubmit(); await settle()
  assert.equal(ops.h.documents.size, 0)
})
