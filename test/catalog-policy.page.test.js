require('./wx-shim.js')
const { test, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const user = require('../utils/user.js')
const { operators } = require('./support/catalog-operators.js')
const { createCatalogAdmin } = require('../utils/catalog-admin.js')
const accessPolicy = require('../shared/exam-access-policy.js')
let definition
global.Page = value => { definition = value }
require('../pages/catalog-admin/catalog-admin.js')
const settle = () => new Promise(setImmediate)
beforeEach(() => global.__wxStorage.clearAll())
function setup(t) {
  const ops = operators()
  let actor = ''
  const main = ops.h.createMain({ protectedMode: true, getContext: () => ({ OPENID: actor }) })
  function client(id) {
    return createCatalogAdmin({ protectedCatalog: true, getSession: () => ({ logged: true, openid: id, token: id }),
      call: data => { actor = id; return main(data) } })
  }
  t.mock.method(user, 'requireAccount', cb => { cb(); return true })
  function page(id) {
    const p = Object.assign({}, definition, { data: JSON.parse(JSON.stringify(definition.data)), setData(value) { Object.assign(this.data, value) } })
    p.onLoad(); p._client = client(id); p.onShow()
    t.after(() => p.onUnload())
    return p
  }
  return { h: ops.h, page }
}
const input = (p, field, value) => p.onInput({ currentTarget: { dataset: { field } }, detail: { value } })
const form = (p, field, value) => p.onEditorInput({ currentTarget: { dataset: { field } }, detail: { value } })
const action = (p, name) => p.onEditorAction({ currentTarget: { dataset: { action: name } } })
const confirm = (p, field, value) => p.onConfirm({ currentTarget: { dataset: { field } }, detail: { value } })

test('逐级创建考试后明确选择访问方式，独立审核并原子发布', async t => {
  const { h, page } = setup(t), editor = page('editor'); await settle(); editor.setData({ protectedCatalog: true })
  editor.onLoadEditor(); await settle(); assert.equal(editor.data.editorReady, true)
  form(editor, 'examName', '合成考试'); action(editor, 'addExam'); const examId = editor.data.selectedExam
  form(editor, 'subjectName', '合成科目'); action(editor, 'addSubject')
  form(editor, 'chapterName', '合成章节'); action(editor, 'addChapter')
  for (const [field, value] of Object.entries({ questionId: 'Q1', type: 'single', stem: '合成题目', options: 'A=甲\nB=乙', answer: 'A',
    sourceKind: 'original', sourceTitle: '合成来源', sourceReference: 'synthetic:test', sourcePermission: '测试授权', sourceAttribution: '测试' })) form(editor, field, value)
  editor.onSaveQuestion(); editor.onPrepareEditor(); assert.equal(editor.data.pagedReady, true)
  assert.equal(editor.data.policyRows[0].access, '')
  input(editor, 'pagedSubmissionId', 'protected_ui'); confirm(editor, 'pagedRights', ['rights'])
  editor.onSubmitPaged(); assert.equal(editor.data.error, 'POLICY_SELECTION_REQUIRED')
  editor.onPolicyChoice({ currentTarget: { dataset: { id: examId, access: 'paid' } } })
  assert.equal(editor.data.pagedRights, false, '更改规则后重新确认发布权')
  confirm(editor, 'pagedRights', ['rights']); editor.onSubmitPaged(); await settle()
  const draftId = editor.data.draftId, draft = h.documents.get(draftId)
  assert.ok(draft, editor.data.error); assert.equal(draft.accessPolicy.entries[0].access, 'paid')
  const reviewer = page('reviewer'); await settle(); reviewer.setData({ protectedCatalog: true })
  input(reviewer, 'draftId', draftId); reviewer.onReadDraft(); await settle()
  assert.equal(reviewer.data.reviewPolicy[0].label, '付费'); assert.equal(reviewer.data.policyRequired, true)
  input(reviewer, 'note', '合成审核'); confirm(reviewer, 'sources', ['sources'])
  reviewer.onReview({ currentTarget: { dataset: { decision: 'approve' } } })
  assert.equal(reviewer.data.error, 'POLICY_REVIEW_REQUIRED')
  confirm(reviewer, 'policy', ['policy']); reviewer.onReview({ currentTarget: { dataset: { decision: 'approve' } } }); await settle()
  assert.equal(h.documents.get(draftId).state, 'approved')
  const publisher = page('publisher'); await settle(); publisher.setData({ protectedCatalog: true })
  input(publisher, 'draftId', draftId); publisher.onReadDraft(); await settle()
  publisher.onReadRevision(); await settle(); assert.equal(publisher.data.revision, '0')
  publisher.onPublish(); await settle(); assert.equal(h.bank().publicationRevision, 1)
  assert.equal(accessPolicy.validPolicy(h.bank().root, 1, h.config.get('examAccessPolicy')), true)
  assert.equal(h.config.get('examAccessPolicy').entries[0].access, 'paid')
  h.users.set('editor2', { _id: 'editor2', openid: 'editor2', token: 'editor2', tokenAt: Date.parse('2026-10-30T06:00:00Z') })
  h.config.get('bankRoles').editors.push('editor2')
  const next = page('editor2'); await settle(); next.setData({ protectedCatalog: true })
  next.onLoadEditor(); await settle(); assert.equal(next.data.editorReady, true, next.data.error)
  next.onPrepareEditor(); assert.equal(next.data.policyRows[0].access, 'paid', '重新载入时保留已审核的策略')
})

test('已有选择在题库变化后保留，新增考试不能悄悄默认为免费', async t => {
  const { h, page } = setup(t), p = page('editor'); await settle(); p.setData({ protectedCatalog: true })
  p.onLoadEditor(); await settle()
  form(p, 'examName', '考试甲'); action(p, 'addExam'); const first = p.data.selectedExam
  form(p, 'subjectName', '科目'); action(p, 'addSubject'); form(p, 'chapterName', '章节'); action(p, 'addChapter')
  for (const [field, value] of Object.entries({ questionId: 'Q1', type: 'single', stem: '合成题', options: 'A=甲\nB=乙', answer: 'A',
    sourceKind: 'original', sourceTitle: '来源', sourceReference: 'test', sourcePermission: '许可', sourceAttribution: '测试' })) form(p, field, value)
  p.onSaveQuestion(); p.onPrepareEditor()
  const storageFailure = t.mock.method(wx, 'setStorageSync', () => { throw new Error('disk full') })
  p.onPolicyChoice({ currentTarget: { dataset: { id: first, access: 'free' } } })
  assert.equal(p.data.error, 'LOCAL_DRAFT_WRITE_FAILED'); assert.equal(p.data.policyRows[0].access, '')
  storageFailure.mock.restore()
  p.onPolicyChoice({ currentTarget: { dataset: { id: first, access: 'free' } } })
  form(p, 'examName', '考试乙'); action(p, 'addExam'); p.onPrepareEditor()
  assert.deepEqual(p.data.policyRows.map(item => item.access), ['free', ''])
  confirm(p, 'pagedRights', ['rights']); p.onSubmitPaged(); assert.equal(p.data.error, 'POLICY_SELECTION_REQUIRED')
  assert.equal([...h.documents.keys()].filter(id => id.startsWith('qpd_')).length, 0)
  p._pagedSource = 'file'
  p.setData({ policyRows: [{ id: first, name: '考试甲', access: 'paid' }] })
  p.onPrepareEditor()
  assert.deepEqual(p.data.policyRows.map(item => item.access), ['', ''], '文件导入的选择不得流入工作区')
})
