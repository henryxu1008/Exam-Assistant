require('./wx-shim.js')
const { test, beforeEach } = require('node:test')
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
beforeEach(() => global.__wxStorage.clearAll())
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
  assert.ok(p.data.reviewItems[0].text.includes('合成工具样例'))
  input(p, 'note', '已核验测试来源'); p.onConfirm({ detail: { value: ['sources'] } })
  p.onReview({ currentTarget: { dataset: { decision: 'approve' } } }); await settle()
  assert.equal(ops.h.documents.get(draft.draftId).state, 'approved')
  input(p, 'draftId', 'another')
  assert.equal(p.data.preview, ''); assert.equal(p.data.sourceVerified, false)
  p.onPublish(); assert.equal(p.data.error, 'READ_DRAFT_REQUIRED')
})

test('来源审核跨页时必须查看所有题目才能批准', async t => {
  const ops = operators(), inputBank = JSON.parse(sample)
  const q = inputBank.bank.questions.it[0], source = inputBank.sources[q.id]
  for (let i = 0; i < 20; i++) {
    const id = 'PAGE-' + i
    inputBank.bank.questions.it.push({ ...q, id })
    inputBank.sources[id] = { ...source, reference: 'synthetic:' + id }
  }
  const draft = await ops.editor.submitDraft(inputBank, { submissionId: 'pages', rightsConfirmed: true })
  const p = page(t, ops.reviewer); await settle()
  input(p, 'draftId', draft.draftId); p.onReadDraft(); await settle()
  assert.equal(p.data.reviewPages, 3); assert.equal(p.data.reviewItems.length, 10)
  input(p, 'note', '逐页核验'); p.onConfirm({ detail: { value: ['sources'] } })
  p.onReview({ currentTarget: { dataset: { decision: 'approve' } } })
  assert.equal(p.data.error, 'REVIEW_PAGES_REQUIRED')
  p.onReviewPage({ currentTarget: { dataset: { delta: 1 } } })
  assert.equal(p.data.reviewAllSeen, false)
  p.onReviewPage({ currentTarget: { dataset: { delta: 1 } } })
  assert.equal(p.data.reviewItems.length, 2); assert.equal(p.data.reviewAllSeen, true)
  p.onReview({ currentTarget: { dataset: { decision: 'approve' } } }); await settle()
  assert.equal(ops.h.documents.get(draft.draftId).state, 'approved')
})

test('重复选择章节或翻页保留题目编辑绑定；切换章节清空旧题表单', async t => {
  const ops = operators(), imported = JSON.parse(sample), q = imported.bank.questions.it[0]
  imported.bank.schemaVersion = 3; imported.bank.manifest.exams = [{ id: 'arch', name: '架构师' }]; imported.bank.manifest.subjects[0].examId = 'arch'
  imported.bank.manifest.subjects[0].chapters.push({ key: 'other', name: '其他章节' })
  for (let i = 0; i < 20; i++) { const id = 'P-' + i; imported.bank.questions.it.push({ ...q, id }); imported.sources[id] = imported.sources[q.id] }
  const d = await ops.editor.submitDraft(imported, { submissionId: 'nav-base', rightsConfirmed: true })
  await ops.approve(d.draftId); await ops.publisher.publishExam({ draftId: d.draftId, expectedRevision: 0 })
  const p = page(t, ops.editor); await settle(); p.onLoadEditor(); await settle()
  const select = (kind, id) => p.onSelectNode({ currentTarget: { dataset: { kind, id } } })
  select('subject', 'it'); select('chapter', 'net')
  p.onEditQuestion({ currentTarget: { dataset: { id: q.id } } })
  select('chapter', 'net'); assert.equal(p.data.editingId, q.id)
  p.onQuestionPage({ currentTarget: { dataset: { delta: 1 } } }); assert.equal(p.data.editingId, q.id)
  p.onEditorInput({ currentTarget: { dataset: { field: 'stem' } }, detail: { value: '导航后编辑' } })
  p.onSaveQuestion(); assert.equal(p.data.error, '')
  assert.equal(p._workspace.bank.questions.it.find(item => item.id === q.id).stem, '导航后编辑')
  select('chapter', 'other'); assert.equal(p.data.editingId, ''); assert.equal(p.data.form.questionId, ''); assert.equal(p.data.form.stem, '')
  p.onRestoreEditor(); assert.equal(p.data.selectedChapter, 'other'); assert.equal(p.data.form.stem, '')
})

test('载入旧发布时提前提示身份迁移限制，不创建可能误导的编辑副本', async t => {
  const ops = operators(), old = await ops.editor.submitDraft(JSON.parse(sample), { submissionId: 'old-version', rightsConfirmed: true })
  await ops.approve(old.draftId); await ops.publisher.publish({ draftId: old.draftId, expectedRevision: 0 })
  const p = page(t, ops.editor); await settle(); p.onLoadEditor(); await settle()
  assert.equal(p.data.error, 'LEGACY_IDENTITY_MIGRATION_REQUIRED')
  assert.equal(p._workspace, null); assert.equal(p.data.editorReady, false)
})

test('编辑已有题目时保留带换行及首尾空格的选项原文', async t => {
  const ops = operators(), imported = JSON.parse(sample), q = imported.bank.questions.it[0]
  imported.bank.schemaVersion = 3; imported.bank.manifest.exams = [{ id: 'arch', name: '架构师' }]; imported.bank.manifest.subjects[0].examId = 'arch'
  q.options[0].text = '  第一段\n第二段  '
  const old = await ops.editor.submitDraft(imported, { submissionId: 'multiline-options', rightsConfirmed: true })
  await ops.approve(old.draftId); await ops.publisher.publishExam({ draftId: old.draftId, expectedRevision: 0 })
  const p = page(t, ops.editor); await settle(); p.onLoadEditor(); await settle()
  p.onSelectNode({ currentTarget: { dataset: { kind: 'subject', id: 'it' } } })
  p.onSelectNode({ currentTarget: { dataset: { kind: 'chapter', id: 'net' } } })
  const initialVersion = p._workspace.bank.questions.it.find(item => item.id === q.id).versionId
  p.onEditQuestion({ currentTarget: { dataset: { id: q.id } } }); p.onSaveQuestion()
  assert.equal(p.data.error, '')
  assert.equal(p._workspace.bank.questions.it.find(item => item.id === q.id).versionId, initialVersion)
  p.onEditorInput({ currentTarget: { dataset: { field: 'stem' } }, detail: { value: '只改题面' } }); p.onSaveQuestion()
  assert.equal(p.data.error, '')
  assert.deepEqual(p._workspace.bank.questions.it.find(item => item.id === q.id).options, q.options)
  const before = JSON.stringify(p._workspace)
  p.onEditorInput({ currentTarget: { dataset: { field: 'options' } }, detail: { value: 'JSON:{bad}' } }); p.onSaveQuestion()
  assert.equal(p.data.error, 'BAD_OPTIONS'); assert.equal(JSON.stringify(p._workspace), before)
})

test('编辑填空题时保留答案里的分隔符和空格', async t => {
  const ops = operators(), imported = JSON.parse(sample), q = imported.bank.questions.it[0]
  imported.bank.schemaVersion = 3; imported.bank.manifest.exams = [{ id: 'arch', name: '架构师' }]; imported.bank.manifest.subjects[0].examId = 'arch'
  q.type = 'fill'; q.options = []; q.answer = ['TCP;IP', ['A|B', '  C  ']]
  const old = await ops.editor.submitDraft(imported, { submissionId: 'fill-delimiters', rightsConfirmed: true })
  await ops.approve(old.draftId); await ops.publisher.publishExam({ draftId: old.draftId, expectedRevision: 0 })
  const p = page(t, ops.editor); await settle(); p.onLoadEditor(); await settle()
  p.onSelectNode({ currentTarget: { dataset: { kind: 'subject', id: 'it' } } })
  p.onSelectNode({ currentTarget: { dataset: { kind: 'chapter', id: 'net' } } })
  p.onEditQuestion({ currentTarget: { dataset: { id: q.id } } }); p.onSaveQuestion()
  assert.equal(p.data.error, '')
  assert.deepEqual(p._workspace.bank.questions.it.find(item => item.id === q.id).answer, q.answer)
  const before = JSON.stringify(p._workspace)
  p.onEditorInput({ currentTarget: { dataset: { field: 'answer' } }, detail: { value: 'JSON:{bad}' } }); p.onSaveQuestion()
  assert.equal(p.data.error, 'BAD_ANSWER'); assert.equal(JSON.stringify(p._workspace), before)
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

test('可视化维护完整题库后必须独立审核发布，学习端读取考试归属并按发布归档判分', async t => {
  const ops = operators(), imported = JSON.parse(sample)
  imported.bank.schemaVersion = 3; imported.bank.manifest.exams = [{ id: 'arch', name: '架构师' }]; imported.bank.manifest.subjects[0].examId = 'arch'
  const old = await ops.editor.submitDraft(imported, { submissionId: 'old', rightsConfirmed: true })
  await ops.approve(old.draftId); await ops.publisher.publishExam({ draftId: old.draftId, expectedRevision: 0 })
  const p = page(t, ops.editor); await settle()
  const form = (field, value) => p.onEditorInput({ currentTarget: { dataset: { field } }, detail: { value } })
  const action = name => p.onEditorAction({ currentTarget: { dataset: { action: name } } })
  const select = (kind, id) => p.onSelectNode({ currentTarget: { dataset: { kind, id } } })
  p.onLoadEditor(); await settle()
  assert.equal(p.data.editorReady, true)
  select('exam', 'arch'); select('subject', 'it'); select('chapter', 'net')
  for (const [field, value] of Object.entries({ questionId: 'DEMO-3', type: 'single', stem: '合成新增题', options: 'A=甲\nB=乙', answer: 'A',
    sourceKind: 'original', sourceTitle: '测试来源', sourceReference: 'synthetic:new', sourcePermission: '测试授权', sourceAttribution: '测试' })) form(field, value)
  p.onSaveQuestion(); assert.equal(p.data.questions.length, 3)
  assert.equal(p.data.editingId, 'DEMO-3', '新题保存后应进入编辑模式')
  form('stem', '合成新增题（已修改）'); p.onSaveQuestion()
  assert.equal(p.data.error, '')
  assert.equal(p.data.questions.find(item => item.id === 'DEMO-3').stem, '合成新增题（已修改）')
  assert.equal(p.data.questions.length, 3)
  p.onPrepareEditor(); assert.equal(p.data.ready, true)
  input(p, 'submissionId', 'visual'); p.onConfirm({ currentTarget: { dataset: { field: 'rights' } }, detail: { value: ['rights'] } })
  p.onSubmit(); await settle()
  const id = p.data.draftId, draft = ops.h.documents.get(id)
  assert.equal(draft.bank.schemaVersion, 3)
  assert.equal(draft.basePublication.revision, 1)
  assert.equal(draft.bank.questions.it.length, 3)
  assert.equal(draft.sources['DEMO-1'].reference, imported.sources['DEMO-1'].reference)
  await ops.approve(id)
  assert.equal((await ops.publisher.publishExam({ draftId: id, expectedRevision: 1 })).ok, true)
  const { device } = require('./support/study-sync-device.js')
  const { makeHarness } = require('./support/study-sync-harness.js')
  const vm = require('node:vm'), learning = makeHarness({ questionDocuments: ops.h.documents }), proxy = { getSubjects: () => [{ name: '专业知识' }] }
  const consumer = device(learning, undefined, true, proxy)
  try {
    const original = consumer.wx.cloud.callFunction
    consumer.wx.cloud.callFunction = opts => opts.name === 'bankSync' ? ops.h.main(opts.data).then(result => ({ result })) : original(opts)
    const file = path.join(__dirname, '../utils/bank/index.js'), module = { exports: {} }
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, wx: consumer.wx, require: name => require(path.resolve(path.dirname(file), name)) })
    Object.assign(proxy, module.exports)
    assert.equal(await proxy.loadCloudBank(), true)
    assert.equal(proxy.getExams()[0].id, 'arch')
    assert.equal(proxy.getSubjects('arch')[0].label, '专业知识')
    const question = proxy.findQuestion('DEMO-3')
    consumer.store.createPracticeSession({ subject: question.subject, questionIds: [question.id], questions: [question] })
    assert.equal(consumer.store.submitAttempt(question, ['A'], true, 10, 'learn').ok, true)
    await consumer.settle()
    assert.equal(learning.attempts.size, 1)
    assert.equal([...learning.attempts.values()][0].grading.source, 'published_archive')
    assert.equal(consumer.store.load().attemptOutbox.pending.length, 0)
  } finally { consumer.store.__clearFlushTimer() }
})

test('编辑基线已变化时不能提交旧工作区，表单修改会作废先前准备结果', async t => {
  const ops = operators(), imported = JSON.parse(sample)
  imported.bank.schemaVersion = 3; imported.bank.manifest.exams = [{ id: 'arch', name: '架构师' }]; imported.bank.manifest.subjects[0].examId = 'arch'
  const old = await ops.editor.submitDraft(imported, { submissionId: 'base', rightsConfirmed: true })
  await ops.approve(old.draftId); const base = await ops.publisher.publishExam({ draftId: old.draftId, expectedRevision: 0 })
  const p = page(t, ops.editor); await settle(); p.onLoadEditor(); await settle()
  const f = (field, value) => p.onEditorInput({ currentTarget: { dataset: { field } }, detail: { value } })
  p.onSelectNode({ currentTarget: { dataset: { kind: 'exam', id: 'arch' } } })
  p.onSelectNode({ currentTarget: { dataset: { kind: 'subject', id: 'it' } } })
  p.onPrepareEditor(); assert.equal(p.data.ready, true)
  p.onSelectNode({ currentTarget: { dataset: { kind: 'chapter', id: 'net' } } })
  p.onEditQuestion({ currentTarget: { dataset: { id: 'DEMO-1' } } })
  f('stem', '未保存的修改'); assert.equal(p.data.ready, false)
  p.onPrepareEditor(); assert.equal(p.data.error, 'SAVE_QUESTION_REQUIRED')
  p.onSaveQuestion()
  p.onPrepareEditor(); assert.equal(p.data.ready, true)
  const modified = JSON.parse(JSON.stringify(imported)); modified.bank.questions.it[0].stem = '其他人新发布'
  const other = await ops.editor.submitDraft(modified, { submissionId: 'other', rightsConfirmed: true, basePublication: { revision: 1, releaseId: base.releaseId } })
  await ops.approve(other.draftId); await ops.publisher.publishExam({ draftId: other.draftId, expectedRevision: 1 })
  input(p, 'submissionId', 'stale'); p.onConfirm({ currentTarget: { dataset: { field: 'rights' } }, detail: { value: ['rights'] } })
  p.onSubmit(); await settle()
  assert.equal(p.data.error, 'STALE_BASE_RELEASE')
  assert.equal(ops.h.bank().questions.it[0].stem, '其他人新发布')
})

test('账号切换清除题库编辑工作区、未保存表单和旧提交确认', async t => {
  const ops = operators()
  let session = { logged: true, openid: 'editor', token: 'editor' }
  const client = createCatalogAdmin({ getSession: () => session, call: data => ops.h.main(data) })
  const p = page(t, client); await settle(); p.onLoadEditor(); await settle()
  p.onEditorInput({ currentTarget: { dataset: { field: 'sourceReference' } }, detail: { value: 'private-reference' } })
  assert.equal(p._questionFormDirty, true)
  p.onHide(); session = { logged: true, openid: 'reviewer', token: 'reviewer' }; p.onShow(); await settle()
  assert.equal(p.data.canReview, true)
  assert.equal(p._workspace, null)
  assert.equal(p._questionFormDirty, false)
  assert.equal(p.data.form.sourceReference, '')
  assert.equal(p.data.editorReady, false)
})

test('重启可恢复本账号工作区及未保存题目表单，写入失败不改变已保存内容', async t => {
  const ops = operators(), first = page(t, ops.editor); await settle(); first.onLoadEditor(); await settle()
  const form = (p, field, value) => p.onEditorInput({ currentTarget: { dataset: { field } }, detail: { value } })
  form(first, 'examId', 'arch'); form(first, 'examName', '考试')
  first.onEditorAction({ currentTarget: { dataset: { action: 'addExam' } } })
  form(first, 'stem', '尚未完成的题面')
  first.onUnload()
  const restarted = page(t, ops.editor); await settle()
  restarted.onLoadEditor(); assert.equal(restarted.data.error, 'LOCAL_DRAFT_EXISTS')
  restarted.onRestoreEditor()
  assert.equal(restarted.data.form.stem, '尚未完成的题面')
  assert.equal(restarted.data.exams[0].id, 'arch')
  assert.equal(restarted._questionFormDirty, true)
  t.mock.method(wx, 'setStorageSync', () => { throw new Error('disk full') })
  form(restarted, 'stem', '不应被确认保存')
  assert.equal(restarted.data.error, 'LOCAL_DRAFT_WRITE_FAILED')
  assert.equal(restarted.data.form.stem, '尚未完成的题面')
  t.mock.restoreAll()
  restarted.onRestoreEditor()
  assert.equal(restarted.data.form.stem, '尚未完成的题面')
})

test('本地编辑不会在不同账号之间展示', async t => {
  const ops = operators()
  ops.h.users.set('another', { _id: 'another', openid: 'another', token: 'another', tokenAt: Date.parse('2026-10-30T06:00:00Z') })
  ops.h.config.get('bankRoles').editors.push('another')
  let session = { logged: true, openid: 'editor', token: 'editor' }
  const client = createCatalogAdmin({ getSession: () => session, call: data => ops.h.main(data) })
  const p = page(t, client); await settle(); p.onLoadEditor(); await settle()
  p.onEditorInput({ currentTarget: { dataset: { field: 'stem' } }, detail: { value: '仅本账号可见' } })
  p.onHide(); session = { logged: true, openid: 'another', token: 'another' }; p.onShow(); await settle()
  p.onRestoreEditor(); assert.equal(p.data.error, 'LOCAL_DRAFT_INVALID')
  assert.equal(p.data.form.stem, '')
  p.onLoadEditor(); await settle(); assert.equal(p.data.editorReady, true)
  assert.equal(p.data.form.stem, '')
})
