const user = require('../../utils/user.js')
const { runtimeClient } = require('../../utils/catalog-admin.js')
const editor = require('../../utils/catalog-editor.js')
const utf8Bytes = value => encodeURIComponent(value).replace(/%[A-F0-9]{2}/g, 'x').length
const questionTypes = [{ name: '单选题', value: 'single' }, { name: '多选题', value: 'multiple' }, { name: '判断题', value: 'judge' },
  { name: '不定项', value: 'uncertain' }, { name: '填空题', value: 'fill' }, { name: '排序题', value: 'sort' }]
const sourceTypes = [{ name: '原创', value: 'original' }, { name: '授权', value: 'licensed' }, { name: '公有领域', value: 'public_domain' }, { name: 'AI 生成', value: 'ai_generated' }]
const errorMessages = {
  STALE_BASE_RELEASE: '题库已更新，请重新载入并核对后再编辑。', BASE_PUBLICATION_REQUIRED: '请先载入当前已发布题库。',
  NO_EDITABLE_PUBLISHED_DRAFT: '当前发布缺少可核对的草稿或来源，请先核查。', INVALID_PUBLISHED_DRAFT: '当前发布的草稿或来源校验失败。',
  EMPTY_EXAM_DRAFT: '题库至少保留一道题，不能通过空草稿清空。', BAD_EXAMS: '请填写有效且不重复的考试编号和名称。',
  BAD_EXAM_OWNERSHIP: '请为每个科目选择所属考试。', BAD_MANIFEST: '请检查科目、章节编号和名称是否有效且不重复。',
  BAD_OPTIONS: '请检查题目选项及格式。', BAD_ANSWER: '请检查答案是否与题型和选项匹配。', BAD_QUESTION: '请检查题号、题面和题型。',
  BAD_SOURCES: '请补充完整的题目来源与授权信息。', EXAM_IMPORT_NOT_SUPPORTED: '考试题库请使用可视化编辑；批量导入暂不支持。',
  SAVE_QUESTION_REQUIRED: '请先保存或放弃当前题目表单，再继续。', QUESTION_ID_IMMUTABLE: '已创建的题号不能修改。',
  QUESTION_ID_CONFLICT: '题号已存在或题目已不存在。', EXAM_NOT_EMPTY: '请先处理考试下的科目。', SUBJECT_NOT_EMPTY: '请先处理科目下的章节和题目。',
  CHAPTER_NOT_EMPTY: '请先处理章节下的题目。', EXAM_NOT_FOUND: '请先选择考试。', SUBJECT_NOT_FOUND: '请先选择科目。', CHAPTER_NOT_FOUND: '请先选择章节。',
  RIGHTS_CONFIRMATION_REQUIRED: '请先核对来源并确认具有发布权。', PREFLIGHT_REQUIRED: '请先检查完整题库。',
  DRAFT_TOO_LARGE_FOR_PAGE: '完整题库和来源超出页面容量，未提交任何截断内容。', INPUT_TOO_LARGE_FOR_PAGE: '输入超出页面容量。',
  EXAM_PROTOCOL_REQUIRED: '当前题库需要对应版本的管理程序。', NETWORK_ERROR: '网络或服务暂不可用，请稍后重试。'
}
const editorForm = () => ({ examId: '', examName: '', subjectKey: '', subjectName: '', chapterKey: '', chapterName: '', questionId: '',
  type: 'single', stem: '', options: '', answer: '', explain: '', pitfall: '', keyPoint: '', tags: '', level: '1',
  sourceKind: 'original', sourceTitle: '', sourceReference: '', sourcePermission: '', sourceAttribution: '', sourceGenerator: '' })
const blank = () => ({ roles: [], canEdit: false, canReview: false, canPublish: false, roleText: '', allowed: false, busy: false, inputText: '', format: 'json', report: '', ready: false,
  rightsConfirmed: false, sourceVerified: false, submissionId: '', draftId: '', note: '', revision: '', removeIds: '', preview: '', result: '', error: '',
  editorReady: false, exams: [], subjects: [], chapters: [], questions: [], selectedExam: '', selectedSubject: '', selectedChapter: '', editingId: '', form: editorForm(), questionTypes, sourceTypes,
  questionTypeName: '单选题', sourceTypeName: '原创', errorMessages })
Page({
  data: blank(),
  onLoad() { this._client = runtimeClient(); this._generation = 0 },
  onShow() {
    this._active = true
    this._generation += 1
    this.setData({ allowed: false, busy: false })
    const generation = this._generation
    user.requireLogin(() => {
      if (!this._active || generation !== this._generation) return
      let ctx
      try { ctx = this._client.capture() } catch (e) { this.setData(blank()); return }
      if (!this._context || this._context.openid !== ctx.openid || this._context.token !== ctx.token) {
        this._prepared = null; this._preparedBase = null; this._draft = null; this._workspace = null; this._editorDirty = false; this._questionFormDirty = false
        this.setData(blank())
      }
      this._context = ctx
      this.setData({ busy: false, allowed: false })
      this._run(() => this._client.access(), result => {
        const roles = Array.isArray(result.roles) ? result.roles : []
        this.setData({ roles, roleText: roles.join(' / '), allowed: roles.length > 0, canEdit: roles.includes('editors'), canReview: roles.includes('reviewers'), canPublish: roles.includes('publishers') })
      })
    })
  },
  onHide() { this._active = false; this._generation += 1 },
  onUnload() { this.onHide(); this._prepared = null; this._preparedBase = null; this._draft = null; this._workspace = null; this._context = null },
  async _run(task, apply) {
    if (this.data.busy || !this._active || !this._context || !this._client.current(this._context)) return
    const generation = this._generation, ctx = this._context
    const live = () => this._active && generation === this._generation && ctx && this._client.current(ctx)
    this.setData({ busy: true, error: '', result: '' })
    try {
      const result = await task()
      if (live()) { if (apply) apply(result); else this.setData({ result: JSON.stringify(result, null, 2) }) }
    } catch (e) { if (live()) this.setData({ error: /^[A-Z_]+$/.test(e.code || '') ? e.code : 'OPERATION_FAILED' }) }
    finally { if (live()) this.setData({ busy: false }) }
  },
  onInput(e) {
    if (this.data.busy) return
    const field = e.currentTarget.dataset.field
    if (!['inputText', 'submissionId', 'draftId', 'note', 'revision', 'removeIds'].includes(field)) return
    if (field === 'inputText' && utf8Bytes(e.detail.value) > 200000) {
      this._prepared = null; this.setData({ inputText: '', ready: false, report: '', rightsConfirmed: false, error: 'INPUT_TOO_LARGE_FOR_PAGE' }); return
    }
    this.setData({ [field]: e.detail.value })
    if (field === 'inputText') { this._prepared = null; this._preparedBase = null; this.setData({ ready: false, report: '', rightsConfirmed: false }) }
    if (field === 'draftId') { this._draft = null; this.setData({ preview: '', sourceVerified: false, revision: '' }) }
  },
  onFormat(e) { if (this.data.busy) return; this._prepared = null; this._preparedBase = null; this.setData({ format: e.currentTarget.dataset.format, ready: false, report: '', rightsConfirmed: false }) },
  onConfirm(e) {
    if (this.data.busy) return
    const values = e.detail.value || []
    const field = e.currentTarget && e.currentTarget.dataset.field
    if (field === 'rights') this.setData({ rightsConfirmed: values.includes('rights') })
    else if (field === 'sources') this.setData({ sourceVerified: values.includes('sources') })
    else this.setData({ rightsConfirmed: values.includes('rights'), sourceVerified: values.includes('sources') })
  },
  onCheck() {
    if (this.data.busy) return
    const { prepared, ...report } = this._client.preflight(this.data.inputText, this.data.format)
    this._prepared = prepared || null
    this._preparedBase = null
    this.setData({ ready: report.ok, report: JSON.stringify(report, null, 2) })
  },
  onSubmit() {
    if (!this._prepared) { this.setData({ error: 'PREFLIGHT_REQUIRED' }); return }
    this._run(() => this._client.submitDraft(this._prepared, { submissionId: this.data.submissionId, rightsConfirmed: this.data.rightsConfirmed, basePublication: this._preparedBase }), result => {
      if (this._prepared && this._prepared.bank.schemaVersion === 3) this._editorDirty = false
      this._draft = null; this.setData({ draftId: result.draftId, preview: '', sourceVerified: false, result: JSON.stringify(result, null, 2) })
    })
  },
  onReadDraft() { this._run(() => this._client.getDraft(this.data.draftId), result => {
    const preview = JSON.stringify(result.draft)
    if (utf8Bytes(preview) > 400000) { this._draft = null; this.setData({ preview: '', sourceVerified: false, error: 'DRAFT_TOO_LARGE_FOR_PAGE' }); return }
    this._draft = result.draft; this.setData({ preview, sourceVerified: false })
  }) },
  onReview(e) {
    if (!this._draft || this._draft.draftId !== this.data.draftId) { this.setData({ error: 'READ_DRAFT_REQUIRED' }); return }
    this._run(() => this._client.review({ draftId: this.data.draftId, decision: e.currentTarget.dataset.decision, note: this.data.note, sourceVerified: this.data.sourceVerified })) },
  onReadRevision() { this._run(() => this._client.activeDraft(), result => this.setData({ revision: String(result.basePublication ? result.basePublication.revision : 0) })) },
  onPublish() {
    if (!this._draft || this._draft.draftId !== this.data.draftId) { this.setData({ error: 'READ_DRAFT_REQUIRED' }); return }
    if (!/^\d+$/.test(this.data.revision)) { this.setData({ error: 'BAD_REVISION' }); return }
    this._run(() => (this._draft.bank.schemaVersion === 3 ? this._client.publishExam : this._client.publish)({ draftId: this.data.draftId, expectedRevision: Number(this.data.revision) }))
  },
  onWithdraw() {
    this._run(() => this._client.withdraw({ draftId: this.data.draftId, questionIds: this.data.removeIds.split(/[,，\s]+/).filter(Boolean),
      submissionId: this.data.submissionId, rightsConfirmed: this.data.rightsConfirmed }), result => { this._draft = null; this.setData({ draftId: result.draftId, preview: '', sourceVerified: false, result: JSON.stringify(result, null, 2) }) })
  },
  _renderEditor() {
    const w = this._workspace, subject = w && w.bank.manifest.subjects.find(s => s.key === this.data.selectedSubject)
    const chapter = subject && subject.chapters.find(c => c.key === this.data.selectedChapter)
    this.setData({ editorReady: !!w, exams: w ? w.bank.manifest.exams : [], subjects: w ? w.bank.manifest.subjects : [],
      chapters: subject ? subject.chapters : [], questions: chapter ? w.bank.questions[subject.key].filter(q => q.chapter === chapter.name) : [] })
  },
  onLoadEditor() {
    if (!this.data.canEdit || this.data.busy || !this._active || !this._client.current(this._context)) return
    if (this._editorDirty || this._questionFormDirty) {
      const generation = this._generation, ctx = this._context, workspace = this._workspace
      wx.showModal({ title: '重新载入题库', content: '当前尚未提交的编辑将被放弃，是否继续？', success: result => {
        if (result.confirm && generation === this._generation && this._active && ctx === this._context && workspace === this._workspace && this._client.current(ctx)) this._readEditor()
      } })
      return
    }
    this._readEditor()
  },
  _readEditor() {
    this._run(() => this._client.activeDraft(), result => {
      const bytes = utf8Bytes(JSON.stringify(result))
      if (bytes > 400000) { this._workspace = null; this.setData({ editorReady: false, error: 'DRAFT_TOO_LARGE_FOR_PAGE' }); return }
      this._workspace = editor.openWorkspace(result); this._prepared = null; this._preparedBase = null; this._editorDirty = false; this._questionFormDirty = false
      this.setData({ selectedExam: '', selectedSubject: '', selectedChapter: '', editingId: '', form: editorForm(), questionTypeName: '单选题', sourceTypeName: '原创', ready: false, rightsConfirmed: false, report: '' })
      this._renderEditor()
    })
  },
  onEditorInput(e) {
    if (this.data.busy || !this.data.canEdit || !this._workspace) return
    const field = e.currentTarget.dataset.field
    if (!Object.prototype.hasOwnProperty.call(this.data.form, field)) return
    const value = e.detail.value
    if (utf8Bytes(value) > 20000) { this.setData({ error: 'INPUT_TOO_LARGE_FOR_PAGE' }); return }
    if (['questionId', 'type', 'stem', 'options', 'answer', 'explain', 'pitfall', 'keyPoint', 'tags', 'level', 'sourceKind', 'sourceTitle', 'sourceReference', 'sourcePermission', 'sourceAttribution', 'sourceGenerator'].includes(field)) this._questionFormDirty = true
    this._prepared = null; this._preparedBase = null
    this.setData({ form: { ...this.data.form, [field]: value }, ready: false, rightsConfirmed: false, report: '',
      ...(field === 'type' ? { questionTypeName: (questionTypes.find(item => item.value === value) || {}).name || value } : {}),
      ...(field === 'sourceKind' ? { sourceTypeName: (sourceTypes.find(item => item.value === value) || {}).name || value } : {}) })
  },
  onEditorChoice(e) {
    const field = e.currentTarget.dataset.field, choices = field === 'type' ? questionTypes : field === 'sourceKind' ? sourceTypes : []
    const choice = choices[Number(e.detail.value)]
    if (choice) this.onEditorInput({ currentTarget: { dataset: { field } }, detail: { value: choice.value } })
  },
  onSelectNode(e) {
    if (this.data.busy || !this._workspace) return
    const { kind, id } = e.currentTarget.dataset
    if (this._questionFormDirty && (kind === 'subject' || kind === 'chapter')) { this.setData({ error: 'SAVE_QUESTION_REQUIRED' }); return }
    if (kind === 'exam') this.setData({ selectedExam: id })
    if (kind === 'subject') this.setData({ selectedSubject: id, selectedChapter: '', editingId: '' })
    if (kind === 'chapter') this.setData({ selectedChapter: id, editingId: '' })
    this._renderEditor()
  },
  _changeEditor(action) {
    if (this.data.busy || !this.data.canEdit || !this._workspace || !this._active || !this._client.current(this._context)) return
    try {
      const next = editor.change(this._workspace, action)
      if (utf8Bytes(JSON.stringify(next)) > 400000) throw Object.assign(new Error('DRAFT_TOO_LARGE_FOR_PAGE'), { code: 'DRAFT_TOO_LARGE_FOR_PAGE' })
      this._workspace = next; this._prepared = null; this._preparedBase = null
      this._editorDirty = true
      this.setData({ ready: false, rightsConfirmed: false, report: '', error: '' }); this._renderEditor(); return true
    } catch (e) { this.setData({ error: /^[A-Z_]+$/.test(e.code || '') ? e.code : 'OPERATION_FAILED' }); return false }
  },
  onEditorAction(e) {
    const type = e.currentTarget.dataset.action, f = this.data.form
    const actions = {
      addExam: { id: f.examId, name: f.examName }, renameExam: { id: this.data.selectedExam, name: f.examName },
      addSubject: { examId: this.data.selectedExam, subjectKey: f.subjectKey, name: f.subjectName },
      assignSubject: { examId: this.data.selectedExam, subjectKey: this.data.selectedSubject },
      renameSubject: { subjectKey: this.data.selectedSubject, name: f.subjectName },
      addChapter: { subjectKey: this.data.selectedSubject, chapterKey: f.chapterKey, name: f.chapterName },
      renameChapter: { subjectKey: this.data.selectedSubject, chapterKey: this.data.selectedChapter, name: f.chapterName }
    }
    if (actions[type]) this._changeEditor({ type, ...actions[type] })
  },
  onRemoveEditor(e) {
    if (this.data.busy || !this.data.canEdit || !this._workspace || !this._active || !this._client.current(this._context)) return
    const { action, id } = e.currentTarget.dataset
    const actions = {
      removeExam: { id: this.data.selectedExam },
      removeSubject: { subjectKey: this.data.selectedSubject },
      removeChapter: { subjectKey: this.data.selectedSubject, chapterKey: this.data.selectedChapter },
      removeQuestion: { subjectKey: this.data.selectedSubject, id }
    }
    if (!actions[action]) return
    const generation = this._generation, context = this._context, workspace = this._workspace
    wx.showModal({ title: '从草稿中移除', content: '此操作只修改当前编辑内容；提交后仍需审核发布。非空分类不能直接移除。',
      success: result => {
        if (!result.confirm || generation !== this._generation || !this._active || context !== this._context || workspace !== this._workspace || !this._client.current(context)) return
        this._changeEditor({ type: action, ...actions[action] })
      } })
  },
  onEditQuestion(e) {
    if (!this._workspace || this.data.busy) return
    const q = (this.data.questions || []).find(item => item.id === e.currentTarget.dataset.id)
    if (!q) return
    if (this._questionFormDirty) { this.setData({ error: 'SAVE_QUESTION_REQUIRED' }); return }
    const s = this._workspace.sources[q.id], f = this.data.form
    this.setData({ editingId: q.id, questionTypeName: (questionTypes.find(item => item.value === q.type) || {}).name || q.type,
      sourceTypeName: (sourceTypes.find(item => item.value === s.kind) || {}).name || s.kind, form: { ...f, questionId: q.id, type: q.type, stem: q.stem,
      options: q.options.map(o => o.key + '=' + o.text).join('\n'), answer: q.type === 'fill' ? q.answer.map(a => Array.isArray(a) ? a.join('|') : a).join(';') : q.answer.join(','),
      explain: q.explain, pitfall: q.pitfall, keyPoint: q.keyPoint, tags: q.tags.join(','), level: String(q.level),
      sourceKind: s.kind, sourceTitle: s.title, sourceReference: s.reference, sourcePermission: s.permission, sourceAttribution: s.attribution, sourceGenerator: s.generator || '' } })
  },
  onNewQuestion() { if (!this.data.busy) { if (this._questionFormDirty) { this.setData({ error: 'SAVE_QUESTION_REQUIRED' }); return } this.setData({ editingId: '', questionTypeName: '单选题', sourceTypeName: '原创', form: { ...editorForm(), examId: this.data.form.examId, examName: this.data.form.examName, subjectKey: this.data.form.subjectKey, subjectName: this.data.form.subjectName, chapterKey: this.data.form.chapterKey, chapterName: this.data.form.chapterName } }) } },
  onDiscardQuestion() {
    if (!this._questionFormDirty || !this._active || !this._client.current(this._context)) return
    const generation = this._generation, ctx = this._context, workspace = this._workspace, form = this.data.form
    wx.showModal({ title: '放弃题目修改', content: '尚未保存到题库的题目表单内容将被放弃。', success: result => {
      if (!result.confirm || generation !== this._generation || !this._active || ctx !== this._context || workspace !== this._workspace || form !== this.data.form || !this._client.current(ctx)) return
      this._questionFormDirty = false; this.onNewQuestion(); this.setData({ error: '' })
    } })
  },
  onSaveQuestion() {
    const f = this.data.form
    try {
      const options = f.type === 'fill' ? [] : f.options.split('\n').filter(line => line.trim()).map(line => {
        const index = line.indexOf('='); if (index < 1) throw Object.assign(new Error('BAD_OPTIONS'), { code: 'BAD_OPTIONS' })
        return { key: line.slice(0, index).trim(), text: line.slice(index + 1).trim() }
      })
      const answer = f.type === 'fill' ? f.answer.split(';').map(part => { const a = part.split('|').map(x => x.trim()); return a.length === 1 ? a[0] : a }) : f.answer.split(',').map(x => x.trim()).filter(Boolean)
      const question = { id: f.questionId, type: f.type, stem: f.stem, options, answer, explain: f.explain, pitfall: f.pitfall, keyPoint: f.keyPoint,
        tags: f.tags.split(',').map(x => x.trim()).filter(Boolean), level: Number(f.level) }
      const source = { kind: f.sourceKind, title: f.sourceTitle, reference: f.sourceReference, permission: f.sourcePermission, attribution: f.sourceAttribution, ...(f.sourceKind === 'ai_generated' ? { generator: f.sourceGenerator } : {}) }
      if (this._changeEditor({ type: 'saveQuestion', subjectKey: this.data.selectedSubject, chapterKey: this.data.selectedChapter, existingId: this.data.editingId, question, source })) this._questionFormDirty = false
    } catch (e) { this.setData({ error: e.code || 'BAD_QUESTION' }) }
  },
  onPrepareEditor() {
    if (this.data.busy || !this.data.canEdit || !this._workspace || !this._active || !this._client.current(this._context)) return
    if (this._questionFormDirty) { this.setData({ ready: false, error: 'SAVE_QUESTION_REQUIRED' }); return }
    try {
      this._prepared = editor.prepare(this._workspace); this._preparedBase = this._workspace.basePublication || undefined
      const bank = this._prepared.bank, count = Object.values(bank.questions).reduce((sum, rows) => sum + rows.length, 0)
      this.setData({ ready: true, rightsConfirmed: false, report: `内容校验通过：${bank.manifest.exams.length} 个考试、${bank.manifest.subjects.length} 个科目、${count} 道题。请核对来源、填写提交 ID 并确认发布权。`, error: '' })
    } catch (e) { this._prepared = null; this._preparedBase = null; this.setData({ ready: false, error: e.code || 'BAD_BANK' }) }
  }
})
