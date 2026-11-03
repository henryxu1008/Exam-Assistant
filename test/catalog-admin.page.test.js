require('./wx-shim.js')
const { test, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const user = require('../utils/user.js')
const { operators } = require('./support/catalog-operators.js')
const { createCatalogAdmin } = require('../utils/catalog-admin.js')
const { createAiQuestionGenerator } = require('../utils/ai-question-generator.js')
const { createService: createAiService } = require('../cloudfunctions/aiQuestionGen/service.js')
const aiDomain = require('../shared/ai-question-domain.js')
let definition
global.Page = value => { definition = value }
require('../pages/catalog-admin/catalog-admin.js')
const sample = fs.readFileSync(path.join(__dirname, '../docs/examples/catalog-import.json'), 'utf8')
const settle = () => new Promise(setImmediate)
beforeEach(() => global.__wxStorage.clearAll())
function page(t, client) {
  t.mock.method(user, 'requireAccount', cb => { cb(); return true })
  const p = Object.assign({}, definition, { data: JSON.parse(JSON.stringify(definition.data)), setData(value) { Object.assign(this.data, value) } })
  p.onLoad(); p._client = client; p.onShow()
  t.after(() => p.onUnload())
  return p
}
const input = (p, field, value) => p.onInput({ currentTarget: { dataset: { field } }, detail: { value } })

for (const unsupported of ['getPagedPublished', 'getActiveCatalogDraft', 'getActivePagedDraft']) {
  test(`载入题库遇到 ${unsupported} 不受支持时提示云端版本并保持只读`, async t => {
    const ops = operators(), actions = []
    const client = createCatalogAdmin({ getSession: () => ({ logged: true, openid: 'editor', token: 'editor' }), call: async data => {
      actions.push(data.action)
      if (data.action === unsupported) return { ok: false, error: 'BAD_ACTION' }
      if (unsupported === 'getActivePagedDraft' && data.action === 'getPagedPublished') return { ok: true, root: { placeholder: true }, publicationRevision: 1 }
      return ops.h.main(data)
    } })
    const p = page(t, client); await settle(); p.onLoadEditor(); await settle()
    assert.equal(p.data.error, 'CATALOG_API_VERSION_MISMATCH')
    assert.equal(p.data.editorReady, false); assert.equal(p._workspace, null)
    assert.equal(ops.h.documents.size, 0)
    assert.deepEqual(actions, unsupported === 'getPagedPublished'
      ? ['getCatalogAccess', 'getPagedPublished']
      : ['getCatalogAccess', 'getPagedPublished', unsupported])
  })
}

test('当前 bankSync 识别载入题库所用的公开查询和个人草稿查询', async () => {
  const ops = operators()
  const paged = await ops.h.main({ action: 'getPagedPublished' })
  const draft = await ops.h.main({ action: 'getActiveCatalogDraft', token: 'editor' })
  assert.equal(paged.ok, true); assert.equal(paged.root, null)
  assert.equal(draft.ok, true); assert.equal(draft.draft, null)
  assert.equal(ops.h.documents.size, 0)
})

test('数据库读取失败不能被误判为接口版本不匹配', async t => {
  const ops = operators()
  const client = createCatalogAdmin({ getSession: () => ({ logged: true, openid: 'editor', token: 'editor' }), call: async data =>
    data.action === 'getPagedPublished' ? { ok: false, error: 'READ_BANK_FAILED' } : ops.h.main(data) })
  const p = page(t, client); await settle(); p.onLoadEditor(); await settle()
  assert.equal(p.data.error, 'READ_BANK_FAILED'); assert.equal(p.data.editorReady, false)
  assert.equal(p._workspace, null); assert.equal(ops.h.documents.size, 0)
})

test('管理页切换分组保留表单与草稿上下文，权限变化后回到可用分组', async t => {
  const ops = operators(), editor = page(t, ops.editor); await settle()
  const go = (p, tab) => p.onWorkspaceTab({ currentTarget: { dataset: { tab } } })
  const editorTab = tab => editor.onEditorTab({ currentTarget: { dataset: { tab } } })
  assert.equal(editor.data.activeTab, 'edit'); assert.equal(editor.data.roleText, '编辑')
  editor.setData({ form: { ...editor.data.form, stem: '尚未保存的题面' }, draftId: 'draft-context' })
  editorTab('ai'); assert.equal(editor.data.editorTab, 'ai')
  go(editor, 'review'); assert.equal(editor.data.activeTab, 'review')
  go(editor, 'edit'); editorTab('questions')
  assert.equal(editor.data.form.stem, '尚未保存的题面'); assert.equal(editor.data.draftId, 'draft-context')
  editor.setData({ busy: true }); go(editor, 'publish'); editorTab('ai')
  assert.equal(editor.data.activeTab, 'edit'); assert.equal(editor.data.editorTab, 'questions')
  editor.setData({ busy: false }); editor._client = ops.reviewer; editor.onShow(); await settle()
  assert.equal(editor.data.activeTab, 'review'); assert.equal(editor.data.canEdit, false)
  go(editor, 'edit'); assert.equal(editor.data.activeTab, 'review')
  go(editor, 'publish'); assert.equal(editor.data.activeTab, 'publish')
})

test('按考试、科目、章节逐级创建并自动分配稳定 ID', async t => {
  const ops = operators(), p = page(t, ops.editor); await settle(); p.onLoadEditor(); await settle()
  const form = (field, value) => p.onEditorInput({ currentTarget: { dataset: { field } }, detail: { value } })
  const act = action => p.onEditorAction({ currentTarget: { dataset: { action } } })
  form('examName', '系统架构设计师'); act('addExam')
  const examId = p.data.selectedExam
  assert.match(examId, /^exam_[a-f0-9]{24}$/); assert.equal(p.data.exams[0].name, '系统架构设计师')
  form('subjectName', '综合知识'); act('addSubject')
  const subjectId = p.data.selectedSubject
  assert.match(subjectId, /^subject_[a-f0-9]{24}$/); assert.equal(p.data.visibleSubjects[0].examId, examId)
  form('chapterName', '软件架构'); act('addChapter')
  const chapterId = p.data.selectedChapter
  assert.match(chapterId, /^chapter_[a-f0-9]{24}$/); assert.equal(p.data.chapters[0].name, '软件架构')
  p.onRestoreEditor()
  assert.equal(p.data.selectedExam, examId); assert.equal(p.data.selectedSubject, subjectId); assert.equal(p.data.selectedChapter, chapterId)
})

test('自动编号的新考试从创建到独立审核发布，再到学习端作答', async t => {
  const ops = operators(), editor = page(t, ops.editor); await settle()
  editor.onLoadEditor(); await settle()
  const form = (field, value) => editor.onEditorInput({ currentTarget: { dataset: { field } }, detail: { value } })
  const action = name => editor.onEditorAction({ currentTarget: { dataset: { action: name } } })
  form('examName', '合成考试'); action('addExam'); const examId = editor.data.selectedExam
  form('subjectName', '合成科目'); action('addSubject'); const subjectId = editor.data.selectedSubject
  form('chapterName', '合成章节'); action('addChapter'); const chapterId = editor.data.selectedChapter
  for (const [field, value] of Object.entries({ questionId: 'NEW-1', type: 'single', stem: '合成新题', options: 'A=甲\nB=乙', answer: 'A',
    sourceKind: 'original', sourceTitle: '测试来源', sourceReference: 'synthetic:new', sourcePermission: '测试授权', sourceAttribution: '测试' })) form(field, value)
  editor.onSaveQuestion(); assert.equal(editor.data.error, '')
  editor.onPrepareEditor(); assert.equal(editor.data.ready, true)
  input(editor, 'submissionId', 'generated-catalog'); editor.onConfirm({ currentTarget: { dataset: { field: 'rights' } }, detail: { value: ['rights'] } })
  editor.onSubmit(); await settle()
  const draftId = editor.data.draftId, draft = ops.h.documents.get(draftId)
  assert.ok(draft, editor.data.error)
  assert.equal(draft.bank.manifest.exams[0].id, examId)
  assert.equal(draft.bank.manifest.subjects[0].key, subjectId)
  assert.equal(draft.bank.manifest.subjects[0].chapters[0].key, chapterId)
  await assert.rejects(ops.editor.review({ draftId, decision: 'approve', note: '自审', sourceVerified: true }))
  await assert.rejects(ops.editor.publishExam({ draftId, expectedRevision: 0 }))
  await ops.approve(draftId)
  assert.equal((await ops.publisher.publishExam({ draftId, expectedRevision: 0 })).ok, true)
  const { device } = require('./support/study-sync-device.js'), { makeHarness } = require('./support/study-sync-harness.js')
  const vm = require('node:vm'), learning = makeHarness({ questionDocuments: ops.h.documents }), proxy = { getSubjects: () => [] }
  const consumer = device(learning, undefined, true, proxy)
  try {
    const original = consumer.wx.cloud.callFunction
    consumer.wx.cloud.callFunction = opts => opts.name === 'bankSync' ? ops.h.main(opts.data).then(result => ({ result })) : original(opts)
    const file = path.join(__dirname, '../utils/bank/index.js'), module = { exports: {} }
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, wx: consumer.wx, require: name => require(path.resolve(path.dirname(file), name)) })
    Object.assign(proxy, module.exports)
    assert.equal(await proxy.loadCloudBank(), true)
    assert.equal(proxy.getExams()[0].id, examId)
    assert.equal(proxy.getSubjects(examId)[0].name, subjectId)
    const question = proxy.findQuestion('NEW-1')
    assert.ok(question)
    consumer.store.createPracticeSession({ subject: question.subject, questionIds: [question.id], questions: [question] })
    assert.equal(consumer.store.submitAttempt(question, ['A'], true, 10, 'learn').ok, true)
    await consumer.settle()
    assert.equal([...learning.attempts.values()][0].grading.source, 'published_archive')
    assert.equal(consumer.store.load().attemptOutbox.pending.length, 0)
  } finally { consumer.store.__clearFlushTimer() }
})

test('切换考试不串科目，未保存的题目表单阻止切换', async t => {
  const ops = operators(), p = page(t, ops.editor); await settle(); p.onLoadEditor(); await settle()
  const form = (field, value) => p.onEditorInput({ currentTarget: { dataset: { field } }, detail: { value } })
  const act = action => p.onEditorAction({ currentTarget: { dataset: { action } } })
  const select = (kind, id) => p.onSelectNode({ currentTarget: { dataset: { kind, id } } })
  form('examName', '考试甲'); act('addExam'); const a = p.data.selectedExam
  form('subjectName', '科目甲'); act('addSubject'); const aSubject = p.data.selectedSubject
  form('chapterName', '章节甲'); act('addChapter')
  form('examName', '考试乙'); act('addExam'); const b = p.data.selectedExam
  assert.equal(p.data.selectedSubject, ''); assert.equal(p.data.selectedChapter, ''); assert.deepEqual(p.data.visibleSubjects, [])
  form('subjectName', '科目乙'); act('addSubject'); const bSubject = p.data.selectedSubject
  select('exam', a); assert.deepEqual(p.data.visibleSubjects.map(s => s.key), [aSubject])
  assert.equal(p.data.selectedSubject, ''); select('subject', bSubject); assert.equal(p.data.selectedSubject, '')
  select('subject', aSubject); form('stem', '未保存的题目')
  select('exam', b); assert.equal(p.data.selectedExam, a); assert.equal(p.data.form.stem, '未保存的题目')
  assert.equal(p.data.error, 'SAVE_QUESTION_REQUIRED')
})

test('调整科目归属后自动切换考试并保留科目及章节', async t => {
  const ops = operators(), p = page(t, ops.editor); await settle(); p.onLoadEditor(); await settle()
  const form = (field, value) => p.onEditorInput({ currentTarget: { dataset: { field } }, detail: { value } })
  const act = action => p.onEditorAction({ currentTarget: { dataset: { action } } })
  const select = (kind, id) => p.onSelectNode({ currentTarget: { dataset: { kind, id } } })
  form('examName', '考试甲'); act('addExam'); const a = p.data.selectedExam
  form('subjectName', '综合知识'); act('addSubject'); const subject = p.data.selectedSubject
  form('chapterName', '基础章节'); act('addChapter'); const chapter = p.data.selectedChapter
  form('examName', '考试乙'); act('addExam'); const b = p.data.selectedExam
  select('exam', a); select('subject', subject); select('chapter', chapter)
  p.onMoveSubject({ detail: { value: '1' } })
  assert.equal(p.data.selectedExam, b); assert.equal(p.data.selectedSubject, subject); assert.equal(p.data.selectedChapter, chapter)
  assert.deepEqual(p.data.visibleSubjects.map(s => s.key), [subject])
  p.onRestoreEditor(); assert.equal(p.data.selectedExam, b); assert.equal(p._workspace.bank.manifest.subjects[0].examId, b)
})

test('自动编号遇到碰撞会重试，本机写入失败不会确认创建', async t => {
  const ops = operators(), p = page(t, ops.editor); await settle(); p.onLoadEditor(); await settle()
  const form = (field, value) => p.onEditorInput({ currentTarget: { dataset: { field } }, detail: { value } })
  const create = () => p.onEditorAction({ currentTarget: { dataset: { action: 'addExam' } } })
  t.mock.method(Date, 'now', () => 123456789); t.mock.method(Math, 'random', () => 0.125)
  form('examName', '考试甲'); create(); const firstId = p.data.selectedExam
  form('examName', '考试乙'); create(); const secondId = p.data.selectedExam
  assert.notEqual(firstId, secondId); assert.equal(p.data.exams.length, 2)
  form('examName', '考试丙')
  t.mock.method(wx, 'setStorageSync', () => { throw new Error('disk full') })
  create()
  assert.equal(p.data.error, 'LOCAL_DRAFT_WRITE_FAILED'); assert.equal(p.data.exams.length, 2)
  assert.equal(p.data.selectedExam, secondId); assert.equal(p.data.form.examName, '考试丙')
})

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

test('已有标签包含逗号、空格和 30 项时编辑保存可无损往返', async t => {
  const ops = operators(), imported = JSON.parse(sample), q = imported.bank.questions.it[0]
  imported.bank.schemaVersion = 3; imported.bank.manifest.exams = [{ id: 'arch', name: '架构师' }]; imported.bank.manifest.subjects[0].examId = 'arch'
  q.tags = ['TCP,UDP', ' spaced ', ...Array.from({ length: 28 }, (_, i) => 'tag-' + i)]
  const old = await ops.editor.submitDraft(imported, { submissionId: 'tags-roundtrip', rightsConfirmed: true })
  await ops.approve(old.draftId); await ops.publisher.publishExam({ draftId: old.draftId, expectedRevision: 0 })
  const p = page(t, ops.editor); await settle(); p.onLoadEditor(); await settle()
  p.onSelectNode({ currentTarget: { dataset: { kind: 'subject', id: 'it' } } })
  p.onSelectNode({ currentTarget: { dataset: { kind: 'chapter', id: 'net' } } })
  const version = p._workspace.bank.questions.it.find(item => item.id === q.id).versionId
  p.onEditQuestion({ currentTarget: { dataset: { id: q.id } } }); p.onSaveQuestion()
  assert.equal(p.data.error, '')
  assert.equal(p._workspace.bank.questions.it.find(item => item.id === q.id).versionId, version)
  p.onEditorInput({ currentTarget: { dataset: { field: 'stem' } }, detail: { value: '仅修改题面' } }); p.onSaveQuestion()
  assert.deepEqual(p._workspace.bank.questions.it.find(item => item.id === q.id).tags, q.tags)
  const before = JSON.stringify(p._workspace)
  p.onEditorInput({ currentTarget: { dataset: { field: 'tags' } }, detail: { value: 'JSON:{bad}' } }); p.onSaveQuestion()
  assert.equal(p.data.error, 'BAD_QUESTION'); assert.equal(JSON.stringify(p._workspace), before)
})

test('管理页从文件导入 700 题，分批上传、逐页审核并发布', async t => {
  const ops = operators(), imported = JSON.parse(sample), first = imported.bank.questions.it[0], source = imported.sources[first.id]
  imported.bank.schemaVersion = 4; imported.bank.manifest.exams = [{ id: 'exam', name: '考试' }]; imported.bank.manifest.subjects[0].examId = 'exam'
  imported.bank.questions.it = Array.from({ length: 700 }, (_, i) => ({ ...first, id: 'q' + String(i).padStart(4, '0') }))
  imported.sources = Object.fromEntries(imported.bank.questions.it.map(q => [q.id, source]))
  const bytes = Buffer.from(JSON.stringify(imported)), data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  const oldChoose = wx.chooseMessageFile, oldFs = wx.getFileSystemManager
  wx.chooseMessageFile = opts => opts.success({ tempFiles: [{ path: 'synthetic.json', size: bytes.length }] })
  wx.getFileSystemManager = () => ({ readFile: opts => opts.success({ data }) })
  t.after(() => { wx.chooseMessageFile = oldChoose; wx.getFileSystemManager = oldFs })
  async function done(p) { for (let i = 0; p.data.busy && i < 10000; i++) await settle(); assert.equal(p.data.busy, false) }
  const editor = page(t, ops.editor); await settle(); editor.onChoosePagedFile(); await done(editor)
  assert.equal(editor.data.pagedReady, true); assert.match(editor.data.pagedReport, /700 题/)
  input(editor, 'pagedSubmissionId', 'large-file'); editor.onConfirm({ currentTarget: { dataset: { field: 'pagedRights' } }, detail: { value: ['rights'] } })
  editor.onSubmitPaged(); await done(editor)
  assert.match(editor.data.draftId, /^qpd_/)
  const id = editor.data.draftId, reviewer = page(t, ops.reviewer); await settle(); input(reviewer, 'draftId', id)
  reviewer.onReadDraft(); await done(reviewer)
  assert.equal(reviewer.data.reviewAllSeen, false)
  while (reviewer.data.reviewPage < reviewer.data.reviewPages) { reviewer.onReviewPage({ currentTarget: { dataset: { delta: 1 } } }); await done(reviewer) }
  assert.equal(reviewer.data.reviewAllSeen, true)
  input(reviewer, 'note', '已逐页核验'); reviewer.onConfirm({ currentTarget: { dataset: { field: 'sources' } }, detail: { value: ['sources'] } })
  reviewer.onReview({ currentTarget: { dataset: { decision: 'approve' } } }); await done(reviewer)
  const publisher = page(t, ops.publisher); await settle(); input(publisher, 'draftId', id); publisher.onReadDraft(); await done(publisher)
  publisher.onReadRevision(); await done(publisher); assert.equal(publisher.data.revision, '0')
  publisher.onPublish(); await done(publisher)
  assert.equal((await ops.h.main({ action: 'getPagedPublished' })).root.totalQuestions, 700)
  const { device } = require('./support/study-sync-device.js'), { makeHarness } = require('./support/study-sync-harness.js')
  const vm = require('node:vm'), learning = makeHarness({ questionDocuments: ops.h.documents }), proxy = { getSubjects: () => [] }
  const consumer = device(learning, undefined, true, proxy)
  try {
    const callStudy = consumer.wx.cloud.callFunction
    consumer.wx.cloud.callFunction = opts => opts.name === 'bankSync' ? ops.h.main(opts.data).then(result => ({ result })) : callStudy(opts)
    const file = path.join(__dirname, '../utils/bank/index.js'), module = { exports: {} }
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, wx: consumer.wx, require: name => require(path.resolve(path.dirname(file), name)) })
    Object.assign(proxy, module.exports); assert.equal(await proxy.loadCloudBank(), true)
    assert.equal(proxy.getAllQuestions().length, 700)
    const question = proxy.findQuestion('q0000')
    consumer.store.createPracticeSession({ subject: question.subject, questionIds: [question.id], questions: [question] })
    assert.equal(consumer.store.submitAttempt(question, ['A'], true, 10, 'learn-paged').ok, true)
    await consumer.settle(); assert.equal(learning.attempts.size, 1)
    assert.equal(consumer.store.load().attemptOutbox.pending.length, 0)
  } finally { consumer.store.__clearFlushTimer() }
})

test('超过单记录容量的分页题库可以逐题编辑、重启恢复并提交完整快照', async t => {
  const ops = operators(), imported = JSON.parse(sample), first = imported.bank.questions.it[0], source = imported.sources[first.id]
  imported.bank.schemaVersion = 4; imported.bank.manifest.exams = [{ id: 'exam', name: '考试' }]; imported.bank.manifest.subjects[0].examId = 'exam'
  imported.bank.questions.it = Array.from({ length: 700 }, (_, i) => ({ ...first, id: 'q' + String(i).padStart(4, '0'), stem: first.stem + 'x'.repeat(1200) }))
  imported.sources = Object.fromEntries(imported.bank.questions.it.map(q => [q.id, source]))
  assert.ok(Buffer.byteLength(JSON.stringify(imported)) > 800000)
  const prepared = ops.editor.preparePaged(JSON.stringify(imported))
  const draft = await ops.editor.submitPaged(prepared, { submissionId: 'editor-base', rightsConfirmed: true, basePublication: null })
  for (const page of prepared.publicPages) await ops.reviewer.getPagedDraftPage(draft.draftId, page.index)
  await ops.reviewer.reviewPaged({ draftId: draft.draftId, decision: 'approve', note: '合成来源', sourceVerified: true })
  await ops.publisher.publishPaged({ draftId: draft.draftId, expectedRevision: 0 })
  const p = page(t, ops.editor), done = async () => { for (let i = 0; p.data.busy && i < 10000; i++) await settle(); assert.equal(p.data.busy, false) }
  await settle(); p.onLoadEditor(); await done()
  assert.equal(p.data.error, ''); assert.equal(p._workspace.bank.questions.it.length, 700)
  p.onSelectNode({ currentTarget: { dataset: { kind: 'subject', id: 'it' } } })
  p.onSelectNode({ currentTarget: { dataset: { kind: 'chapter', id: 'net' } } })
  p.onEditQuestion({ currentTarget: { dataset: { id: 'q0000' } } })
  const editedStem = '改'.repeat(7001)
  p.onEditorInput({ currentTarget: { dataset: { field: 'stem' } }, detail: { value: editedStem } }); p.onSaveQuestion()
  assert.equal(p.data.error, '')
  p._workspace = null; p.onRestoreEditor(); assert.equal(p._workspace.bank.questions.it.length, 700)
  assert.equal(p._workspace.bank.questions.it.find(q => q.id === 'q0000').stem, editedStem)
  p.onPrepareEditor(); assert.equal(p.data.pagedReady, true)
  assert.equal(p._pagedPrepared.root.totalQuestions, 700)
  assert.deepEqual(p._pagedPrepared.privatePages.flatMap(x => Object.keys(x.sources)).sort(), Object.keys(imported.sources).sort())
  input(p, 'pagedSubmissionId', 'editor-change')
  p.onConfirm({ currentTarget: { dataset: { field: 'pagedRights' } }, detail: { value: ['rights'] } })
  p.onSubmitPaged(); await done()
  assert.equal(ops.h.documents.get(p.data.draftId).state, 'sealed')
  assert.equal(ops.h.bank().publicationRevision, 1)
})

test('大题目列表使用有界摘要，编辑时从完整工作区读取原题和来源', async t => {
  const ops = operators(), imported = JSON.parse(sample), first = imported.bank.questions.it[0], source = imported.sources[first.id]
  imported.bank.schemaVersion = 4; imported.bank.manifest.exams = [{ id: 'exam', name: '考试' }]; imported.bank.manifest.subjects[0].examId = 'exam'
  imported.bank.questions.it = Array.from({ length: 20 }, (_, i) => ({ ...first, id: 'large' + String(i).padStart(2, '0'), stem: '题'.repeat(20000) }))
  imported.sources = Object.fromEntries(imported.bank.questions.it.map(q => [q.id, source]))
  const prepared = ops.editor.preparePaged(JSON.stringify(imported))
  assert.equal(prepared.root.pages.length, 20)
  const questions = { it: prepared.publicPages.flatMap(page => page.questions) }, sources = Object.assign({}, ...prepared.privatePages.map(page => page.sources))
  const p = page(t, ops.editor); await settle()
  const workspace = { bank: { schemaVersion: 4, manifest: prepared.root.manifest, questions }, sources, basePublication: null }
  const ui = p._editorUI({ selectedSubject: 'it', selectedChapter: 'net', questionPage: 1 })
  p._checkpointToken = p._checkpoint.create(workspace, ui); p._workspace = workspace
  p.setData({ selectedSubject: 'it', selectedChapter: 'net', questionPage: 1 })
  let renderBytes = 0, setData = p.setData
  p.setData = function (patch) { if (patch.questions) renderBytes = Buffer.byteLength(JSON.stringify(patch)); return setData.call(this, patch) }
  p._renderEditor()
  assert.ok(renderBytes < 100000, `列表更新负载 ${renderBytes} 字节应保持有界`)
  assert.equal(p.data.questions.length, 20); assert.ok(p.data.questions[0].stem.length < 1000)
  p.onEditQuestion({ currentTarget: { dataset: { id: 'large00' } } })
  assert.equal(p.data.form.stem, workspace.bank.questions.it[0].stem)
  const version = workspace.bank.questions.it[0].versionId
  p.onSaveQuestion(); assert.equal(p.data.error, '')
  assert.equal(p._workspace.bank.questions.it.find(q => q.id === 'large00').versionId, version)
  assert.deepEqual(p._workspace.sources.large00, workspace.sources.large00)
})

test('管理端生成候选题需填写来源并一次性加入当前工作区，不直接发布', async t => {
  const ops = operators(), imported = JSON.parse(sample)
  imported.bank.schemaVersion = 3; imported.bank.manifest.exams = [{ id: 'exam', name: '考试' }]; imported.bank.manifest.subjects[0].examId = 'exam'
  const base = await ops.editor.submitDraft(imported, { submissionId: 'ai-base', rightsConfirmed: true })
  await ops.approve(base.draftId); await ops.publisher.publishExam({ draftId: base.draftId, expectedRevision: 0 })
  const p = page(t, ops.editor); await settle(); p.onLoadEditor(); await settle()
  p.onSelectNode({ currentTarget: { dataset: { kind: 'subject', id: 'it' } } })
  p.onSelectNode({ currentTarget: { dataset: { kind: 'chapter', id: 'net' } } })
  let calls = 0, reviewIssue = false
  p._aiClient = createAiQuestionGenerator({ getSession: () => ({ logged: true, openid: 'editor', token: 'editor' }), call: async request => {
    calls++
    const items = Array.from({ length: request.count }, (_, i) => ({ type: request.type, level: request.level, stem: '合成 AI 候选题 ' + i,
      options: [{ key: 'A', text: '甲' }, { key: 'B', text: '乙' }], answer: ['A'], explain: '合成解析' }))
    const questions = aiDomain.normalize(items, request, 'editor')
    return { ok: true, generator: '合成模型', reviewer: '合成审题模型', questions,
      reviewEvidence: { answers: questions.map(q => ({ id: q.id, answer: [reviewIssue ? 'B' : 'A'], reason: '独立分析' })), reviews: questions.map(q => ({ id: q.id, issues: [] })) } }
  } })
  const setAi = (field, value) => p.onAiInput({ currentTarget: { dataset: { field } }, detail: { value } })
  setAi('aiTopic', '网络基础'); setAi('aiCount', '2')
  const before = p._workspace.bank.questions.it.length, revision = ops.h.bank().publicationRevision
  p.onAiGenerate(); await settle(); assert.equal(calls, 1); assert.equal(p.data.aiResults.length, 2)
  assert.match(p.data.aiResults[0].reviewStatus, /人工核验/); assert.equal(p.data.aiResults[0].reviewAnswer, 'A')
  assert.equal(p._workspace.bank.questions.it.length, before)
  p.onAiAdd(); assert.equal(p.data.error, 'AI_SOURCE_REQUIRED'); assert.equal(p._workspace.bank.questions.it.length, before)
  setAi('aiReference', '合成知识点'); setAi('aiPermission', '合成测试许可'); p.onAiAdd()
  assert.equal(p.data.editorTab, 'questions', '候选题加入后转到题目编辑')
  assert.equal(p.data.aiResults.length, 0); assert.equal(p._workspace.bank.questions.it.length, before + 2)
  const generated = p._workspace.bank.questions.it.filter(q => q.id.startsWith('AI_'))
  assert.equal(generated.length, 2); assert.equal(p._workspace.sources[generated[0].id].kind, 'ai_generated')
  assert.equal(p._workspace.sources[generated[0].id].generator, '合成模型'); assert.equal(ops.h.bank().publicationRevision, revision)
  p.onPrepareEditor(); assert.equal(p.data.ready, true); assert.equal(p.data.activeTab, 'draft')
  reviewIssue = true; p.onAiGenerate(); await settle()
  assert.match(p.data.aiResults[0].reviewStatus, /需修改/); assert.match(p.data.aiResults[0].reviewIssues, /不一致/)
  p.onAiAdd(); assert.equal(p.data.error, 'AI_REVIEW_REQUIRED'); assert.equal(p._workspace.bank.questions.it.length, before + 2)
  p.onAiDiscard(); reviewIssue = false
  p.onAiGenerate(); await settle(); assert.equal(p.data.aiResults.length, 2)
  p._changeEditor({ type: 'renameChapter', subjectKey: 'it', chapterKey: 'net', name: '改名后章节' })
  const afterChange = JSON.stringify(p._workspace)
  p.onAiAdd(); assert.equal(p.data.error, 'AI_CANDIDATES_STALE'); assert.equal(JSON.stringify(p._workspace), afterChange)
  p.onAiDiscard(); assert.equal(p.data.aiResults.length, 0)
})

test('AI 候选题经编辑、独立审核和发布后才能进入学习题库', async t => {
  const ops = operators(), imported = JSON.parse(sample)
  imported.bank.schemaVersion = 3; imported.bank.manifest.exams = [{ id: 'exam', name: '合成考试' }]; imported.bank.manifest.subjects[0].examId = 'exam'
  const base = await ops.editor.submitDraft(imported, { submissionId: 'ai-flow-base', rightsConfirmed: true })
  await ops.approve(base.draftId); await ops.publisher.publishExam({ draftId: base.draftId, expectedRevision: 0 })
  let modelCalls = 0
  const service = createAiService({ db: ops.h.db, now: () => Date.parse('2026-10-30T06:00:00Z'),
    config: { enabled: true, configured: true, globalCap: 5, userCap: 5, model: '合成模型' },
    callModel: async request => { modelCalls++; return { questions: [{ type: request.type, level: request.level,
      stem: '合成出题流程验收', options: [{ key: 'A', text: '甲' }, { key: 'B', text: '乙' }], answer: ['A'], explain: '合成解析' }] } },
    solveModel: async request => ({ answers: request.questions.map(q => ({ id: q.id, answer: ['A'], reason: '独立分析' })) }),
    critiqueModel: async request => ({ reviews: request.questions.map(q => ({ id: q.id, issues: [] })) }) })
  const editor = page(t, ops.editor); await settle(); editor.onLoadEditor(); await settle()
  editor.onSelectNode({ currentTarget: { dataset: { kind: 'subject', id: 'it' } } })
  editor.onSelectNode({ currentTarget: { dataset: { kind: 'chapter', id: 'net' } } })
  editor._aiClient = createAiQuestionGenerator({ getSession: () => ({ logged: true, openid: 'editor', token: 'editor' }), call: service })
  const aiInput = (field, value) => editor.onAiInput({ currentTarget: { dataset: { field } }, detail: { value } })
  aiInput('aiTopic', '网络基础'); aiInput('aiCount', '1')
  editor.onAiGenerate(); await settle()
  assert.equal(modelCalls, 1); assert.equal(editor.data.aiResults.length, 1)
  const id = editor.data.aiResults[0].id
  assert.ok(!ops.h.bank().questions.it.some(q => q.id === id), '候选不直接发布')
  aiInput('aiReference', '合成测试依据'); aiInput('aiPermission', '合成测试许可'); editor.onAiAdd()
  editor.onEditQuestion({ currentTarget: { dataset: { id } } })
  editor.onEditorInput({ currentTarget: { dataset: { field: 'stem' } }, detail: { value: '合成出题流程验收（人工修订）' } })
  editor.onSaveQuestion(); assert.equal(editor.data.error, '')
  editor.onPrepareEditor(); assert.equal(editor.data.ready, true)
  input(editor, 'submissionId', 'ai-flow-draft'); editor.onConfirm({ currentTarget: { dataset: { field: 'rights' } }, detail: { value: ['rights'] } })
  editor.onSubmit(); await settle()
  const draftId = editor.data.draftId, draft = ops.h.documents.get(draftId)
  assert.ok(draft, editor.data.error); assert.equal(draft.sources[id].kind, 'ai_generated')
  assert.ok(!ops.h.bank().questions.it.some(q => q.id === id), '提交草稿不直接发布')
  await assert.rejects(ops.editor.review({ draftId, decision: 'approve', note: '自审', sourceVerified: true }))
  await assert.rejects(ops.editor.publishExam({ draftId, expectedRevision: 1 }))
  const reviewer = page(t, ops.reviewer); await settle(); input(reviewer, 'draftId', draftId); reviewer.onReadDraft(); await settle()
  assert.ok(reviewer.data.reviewItems.some(row => row.id === id && row.text.includes('合成模型') && row.text.includes('合成测试依据')))
  input(reviewer, 'note', '已核验合成题和来源'); reviewer.onConfirm({ currentTarget: { dataset: { field: 'sources' } }, detail: { value: ['sources'] } })
  reviewer.onReview({ currentTarget: { dataset: { decision: 'approve' } } }); await settle()
  assert.equal(ops.h.documents.get(draftId).state, 'approved')
  const publisher = page(t, ops.publisher); await settle(); input(publisher, 'draftId', draftId); publisher.onReadDraft(); await settle()
  publisher.onReadRevision(); await settle(); assert.equal(publisher.data.revision, '1')
  publisher.onPublish(); await settle(); assert.equal(ops.h.bank().publicationRevision, 2)
  const { device } = require('./support/study-sync-device.js'), { makeHarness } = require('./support/study-sync-harness.js')
  const vm = require('node:vm'), learning = makeHarness({ questionDocuments: ops.h.documents }), proxy = { getSubjects: () => [{ name: '专业知识' }] }
  const consumer = device(learning, undefined, true, proxy)
  try {
    const original = consumer.wx.cloud.callFunction
    consumer.wx.cloud.callFunction = opts => opts.name === 'bankSync' ? ops.h.main(opts.data).then(result => ({ result })) : original(opts)
    const file = path.join(__dirname, '../utils/bank/index.js'), module = { exports: {} }
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, wx: consumer.wx, require: name => require(path.resolve(path.dirname(file), name)) })
    Object.assign(proxy, module.exports)
    assert.equal(await proxy.loadCloudBank(), true)
    const question = proxy.findQuestion(id)
    assert.equal(question.stem, '合成出题流程验收（人工修订）')
    consumer.store.createPracticeSession({ subject: question.subject, questionIds: [id], questions: [question] })
    assert.equal(consumer.store.submitAttempt(question, ['A'], true, 10, 'learn').ok, true)
    await consumer.settle()
    assert.equal([...learning.attempts.values()][0].grading.source, 'published_archive')
  } finally { consumer.store.__clearFlushTimer() }
})

test('大题库文件含非法 UTF-8 或长度不符时拒绝导入', async t => {
  const ops = operators(), p = page(t, ops.editor); await settle()
  const oldChoose = wx.chooseMessageFile, oldFs = wx.getFileSystemManager
  wx.chooseMessageFile = opts => opts.success({ tempFiles: [{ path: 'bad.json', size: 2 }] })
  wx.getFileSystemManager = () => ({ readFile: opts => opts.success({ data: Uint8Array.from([0xc0, 0xaf]).buffer }) })
  t.after(() => { wx.chooseMessageFile = oldChoose; wx.getFileSystemManager = oldFs })
  p.onChoosePagedFile(); await settle(); assert.equal(p.data.error, 'BAD_UTF8'); assert.equal(p.data.pagedReady, false)
  wx.getFileSystemManager = () => ({ readFile: opts => opts.success({ data: Uint8Array.from([0x7b]).buffer }) })
  p.onChoosePagedFile(); await settle(); assert.equal(p.data.error, 'BAD_FILE_LENGTH'); assert.equal(p.data.pagedReady, false)
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
  t.mock.method(user, 'requireAccount', cb => { callbacks.push(cb); return true })
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
  form(first, 'examName', '考试')
  first.onEditorAction({ currentTarget: { dataset: { action: 'addExam' } } })
  const examId = first.data.selectedExam
  form(first, 'stem', '尚未完成的题面')
  first.onUnload()
  const restarted = page(t, ops.editor); await settle()
  restarted.onLoadEditor(); assert.equal(restarted.data.error, 'LOCAL_DRAFT_EXISTS')
  restarted.onRestoreEditor()
  assert.equal(restarted.data.form.stem, '尚未完成的题面')
  assert.equal(restarted.data.exams[0].id, examId)
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
