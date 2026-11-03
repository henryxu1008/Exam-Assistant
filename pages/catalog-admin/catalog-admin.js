const user = require('../../utils/user.js')
const { runtimeClient } = require('../../utils/catalog-admin.js')
const editor = require('../../utils/catalog-editor.js')
const { chapterIdentity } = require('../../shared/exam-catalog-domain.js')
const paged = require('../../shared/paged-catalog-domain.js')
const { createCatalogCheckpoint } = require('../../utils/catalog-checkpoint.js')
const { runtimeAiQuestionGenerator } = require('../../utils/ai-question-generator.js')
const { sha256 } = require('../../shared/question-domain.js')
const utf8Bytes = value => encodeURIComponent(value).replace(/%[A-F0-9]{2}/g, 'x').length
const questionTypes = [{ name: '单选题', value: 'single' }, { name: '多选题', value: 'multiple' }, { name: '判断题', value: 'judge' },
  { name: '不定项', value: 'uncertain' }, { name: '填空题', value: 'fill' }, { name: '排序题', value: 'sort' }]
const sourceTypes = [{ name: '原创', value: 'original' }, { name: '授权', value: 'licensed' }, { name: '公有领域', value: 'public_domain' }, { name: 'AI 生成', value: 'ai_generated' }]
const aiTypes = questionTypes.filter(item => ['single', 'multiple', 'judge'].includes(item.value))
const errorMessages = {
  STALE_BASE_RELEASE: '题库已更新，请重新载入并核对后再编辑。', BASE_PUBLICATION_REQUIRED: '请先载入当前已发布题库。',
  NO_EDITABLE_PUBLISHED_DRAFT: '当前发布缺少可核对的草稿或来源，请先核查。', INVALID_PUBLISHED_DRAFT: '当前发布的草稿或来源校验失败。',
  EMPTY_EXAM_DRAFT: '题库至少保留一道题，不能通过空草稿清空。', BAD_EXAMS: '请填写有效且不重复的考试编号和名称。',
  BAD_EXAM_OWNERSHIP: '请为每个科目选择所属考试。', BAD_MANIFEST: '请检查科目、章节编号和名称是否有效且不重复。',
  BAD_OPTIONS: '请检查题目选项及格式。', BAD_ANSWER: '请检查答案是否与题型和选项匹配。', BAD_QUESTION: '请检查题号、题面和题型。',
  BAD_SOURCES: '请补充完整的题目来源与授权信息。', EXAM_IMPORT_NOT_SUPPORTED: '考试题库请使用可视化编辑；批量导入暂不支持。',
  SAVE_QUESTION_REQUIRED: '请先保存或放弃当前题目表单，再继续。', QUESTION_ID_IMMUTABLE: '已创建的题号不能修改。',
  QUESTION_ID_CONFLICT: '题号已存在或题目已不存在。', EXAM_NOT_EMPTY: '请先处理考试下的科目。', SUBJECT_NOT_EMPTY: '请先处理科目下的章节和题目。',
  QUESTION_ID_RETIRED: '题号已撤回，不能再次使用。', QUESTION_SCOPE_IMMUTABLE: '已发布题目的科目和章节不能变更。',
  LEGACY_IDENTITY_MIGRATION_REQUIRED: '旧题库身份与学习记录尚未迁移，无法直接发布为新版。', IDENTITY_REGISTRY_INVALID: '题号登记状态异常，发布已停止，请先核查。', IDENTITY_REGISTRY_FULL: '题号登记容量不足，发布已停止。',
  PAGED_EDITOR_FILE_REQUIRED: '当前是分页题库，请使用完整 JSON 文件导入；可视化逐题编辑尚不支持。', BAD_UTF8: '文件不是有效的 UTF-8 编码。', BAD_FILE_LENGTH: '文件读取不完整，请重试。', FILE_API_UNAVAILABLE: '当前设备不支持选择文件。',
  CHAPTER_NOT_EMPTY: '请先处理章节下的题目。', EXAM_NOT_FOUND: '请先选择考试。', SUBJECT_NOT_FOUND: '请先选择科目。', CHAPTER_NOT_FOUND: '请先选择章节。',
  RIGHTS_CONFIRMATION_REQUIRED: '请先核对来源并确认具有发布权。', PREFLIGHT_REQUIRED: '请先检查完整题库。',
  DRAFT_TOO_LARGE_FOR_PAGE: '完整题库和来源超出页面容量，未提交任何截断内容。', INPUT_TOO_LARGE_FOR_PAGE: '输入超出页面容量。', REVIEW_PAGES_REQUIRED: '请先逐页查看全部题目和来源。',
  EXAM_PROTOCOL_REQUIRED: '当前题库需要对应版本的管理程序。', UNSAVED_WORKSPACE_CHANGES: '请先提交或放弃当前编辑内容，再导入题库。', NETWORK_ERROR: '网络或服务暂不可用，请稍后重试。',
  LOCAL_DRAFT_EXISTS: '本机有已保存的编辑内容，请先恢复或明确丢弃。', LOCAL_DRAFT_CHANGED: '本机编辑内容已在其他页面更新，请重新恢复。',
  LOCAL_DRAFT_READ_FAILED: '本机编辑内容读取失败，请保留现场并重试。', LOCAL_DRAFT_WRITE_FAILED: '本机保存失败，当前修改未被确认保存。',
  PAGED_RELEASE_IN_USE: '题目页仍被其他草稿或发布引用，未清理。', PAGED_REFERENCES_INVALID: '题目页引用登记异常，未清理。',
  AI_GENERATION_DISABLED: 'AI 出题尚未启用或配置。', AI_QUOTA_EXCEEDED: '本日 AI 出题次数已用完。', BAD_AI_RESPONSE: 'AI 返回内容不符合题目规则，请重试。',
  BAD_AI_REQUEST: '请检查知识点、题型、难度和生成数量。', DUPLICATE_AI_QUESTION: '候选题与已有题目重复，请丢弃后重新生成。', AI_CANDIDATES_PENDING: '请先处理或丢弃当前候选题。',
  AI_CANDIDATES_STALE: '题库内容或章节已改变，请重新生成。', AI_SOURCE_REQUIRED: '加入题库前请填写依据及使用权说明。',
  BAD_AI_REVIEW: 'AI 审题结果不完整或无效，候选题未通过，请重试。', AI_REVIEW_CONFIG_INVALID: 'AI 审题服务尚未正确配置。', AI_REVIEW_REQUIRED: '本批题目存在审题问题，请丢弃并重新生成。',
  AI_UPSTREAM_TIMEOUT: 'AI 服务超时，本次可能已消耗部分配额。', AI_UPSTREAM_FAILED: 'AI 服务调用失败，本次可能已消耗部分配额。',
  AI_RESPONSE_TOO_LARGE: 'AI 响应过大，候选题未加入；本次可能已消耗部分配额。',
  LOCAL_DRAFT_INVALID: '本机编辑内容损坏，未自动覆盖。', LOCAL_DRAFT_TOO_LARGE: '本机编辑内容超出单项容量，未截断保存。', LOCAL_DRAFT_CLEANUP_FAILED: '本机备份清理未完成，请重试。'
}
const editorForm = () => ({ examId: '', examName: '', subjectKey: '', subjectName: '', chapterKey: '', chapterName: '', questionId: '',
  type: 'single', stem: '', options: '', answer: '', explain: '', pitfall: '', keyPoint: '', tags: '', level: '1',
  sourceKind: 'original', sourceTitle: '', sourceReference: '', sourcePermission: '', sourceAttribution: '', sourceGenerator: '' })
const resetQuestion = form => ({ ...editorForm(), examId: form.examId, examName: form.examName, subjectKey: form.subjectKey, subjectName: form.subjectName, chapterKey: form.chapterKey, chapterName: form.chapterName })
function jsonArray(value, code) {
  try {
    const parsed = JSON.parse(value.slice(5))
    if (Array.isArray(parsed)) return parsed
  } catch (e) { /* Invalid structured input must be reported as a field error. */ }
  throw Object.assign(new Error(code), { code })
}
function decodeUtf8(buffer) {
  if (!buffer || typeof buffer.byteLength !== 'number') throw Object.assign(new Error('BAD_UTF8'), { code: 'BAD_UTF8' })
  const data = new Uint8Array(buffer), parts = [], units = []
  const bad = () => { throw Object.assign(new Error('BAD_UTF8'), { code: 'BAD_UTF8' }) }
  for (let i = 0; i < data.length;) {
    const first = data[i++]; let n, count
    if (first < 0x80) { n = first; count = 0 }
    else if (first >= 0xc2 && first <= 0xdf) { n = first & 31; count = 1 }
    else if (first >= 0xe0 && first <= 0xef) { n = first & 15; count = 2 }
    else if (first >= 0xf0 && first <= 0xf4) { n = first & 7; count = 3 }
    else bad()
    if (i + count > data.length) bad()
    for (let j = 0; j < count; j++) { const next = data[i++]; if ((next & 0xc0) !== 0x80) bad(); n = (n << 6) | (next & 63) }
    if ((count === 2 && n < 0x800) || (count === 3 && n < 0x10000) || (n >= 0xd800 && n <= 0xdfff) || n > 0x10ffff) bad()
    if (n < 0x10000) units.push(n)
    else { n -= 0x10000; units.push(0xd800 + (n >> 10), 0xdc00 + (n & 1023)) }
    if (units.length >= 4096) { parts.push(String.fromCharCode(...units)); units.length = 0 }
  }
  if (units.length) parts.push(String.fromCharCode(...units))
  return parts.join('')
}
const blank = () => ({ roles: [], canEdit: false, canReview: false, canPublish: false, roleText: '', allowed: false, busy: false, inputText: '', format: 'json', report: '', ready: false,
  rightsConfirmed: false, sourceVerified: false, submissionId: '', draftId: '', note: '', revision: '', removeIds: '', preview: '', result: '', error: '',
  editorReady: false, exams: [], subjects: [], chapters: [], questions: [], questionPage: 1, questionPages: 1, questionTotal: 0, selectedExam: '', selectedSubject: '', selectedChapter: '', editingId: '', form: editorForm(), questionTypes, sourceTypes,
  reviewItems: [], reviewPage: 1, reviewPages: 1, reviewAllSeen: false,
  pagedReady: false, pagedReport: '', pagedSubmissionId: '', pagedRights: false,
  aiTopic: '', aiType: 'single', aiTypeName: '单选题', aiTypes, aiLevel: '1', aiCount: '3', aiReference: '', aiPermission: '', aiResults: [],
  questionTypeName: '单选题', sourceTypeName: '原创', errorMessages })
Page({
  data: blank(),
  onLoad() { this._client = runtimeClient(); this._aiClient = runtimeAiQuestionGenerator(); this._generation = 0 },
  onShow() {
    this._active = true
    this._generation += 1
    this.setData({ allowed: false, busy: false })
    const generation = this._generation
    user.requireAccount(() => {
      if (!this._active || generation !== this._generation) return
      let ctx
      try { ctx = this._client.capture() } catch (e) { this.setData(blank()); return }
      if (!this._context || this._context.openid !== ctx.openid || this._context.token !== ctx.token) {
        this._prepared = null; this._preparedBase = null; this._pagedPrepared = null; this._pagedBase = null; this._draft = null; this._reviewRows = null; this._reviewSeen = null; this._workspace = null; this._editorDirty = false; this._questionFormDirty = false; this._checkpointToken = null; this._aiCandidates = null
        this._checkpoint = createCatalogCheckpoint(wx, ctx.openid)
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
  onHide() { this._active = false; this._generation += 1; this._aiCandidates = null; this.setData({ aiResults: [] }) },
  onUnload() { this.onHide(); this._prepared = null; this._preparedBase = null; this._pagedPrepared = null; this._pagedBase = null; this._draft = null; this._reviewRows = null; this._reviewSeen = null; this._workspace = null; this._context = null; this._checkpoint = null; this._checkpointToken = null },
  async _run(task, apply) {
    if (this.data.busy || !this._active || !this._context || !this._client.current(this._context)) return
    const generation = this._generation, ctx = this._context
    const live = () => this._active && generation === this._generation && ctx && this._client.current(ctx)
    this.setData({ busy: true, error: '', result: '' })
    try {
      const result = await task(live)
      if (live()) { if (apply) apply(result); else this.setData({ result: JSON.stringify(result, null, 2) }) }
    } catch (e) { if (live()) this.setData({ error: /^[A-Z][A-Z0-9_]*$/.test(e.code || '') ? e.code : 'OPERATION_FAILED',
      ...(Number.isSafeInteger(e.row) && e.row > 0 ? { pagedReport: `第 ${e.row} 条题目校验失败，字段 ${e.field || 'question'}；整批未提交。` } : {}) }) }
    finally { if (live()) this.setData({ busy: false }) }
  },
  onInput(e) {
    if (this.data.busy) return
    const field = e.currentTarget.dataset.field
    if (!['inputText', 'submissionId', 'pagedSubmissionId', 'draftId', 'note', 'revision', 'removeIds'].includes(field)) return
    if (field === 'inputText' && utf8Bytes(e.detail.value) > 200000) {
      this._prepared = null; this.setData({ inputText: '', ready: false, report: '', rightsConfirmed: false, error: 'INPUT_TOO_LARGE_FOR_PAGE' }); return
    }
    this.setData({ [field]: e.detail.value })
    if (field === 'inputText') { this._prepared = null; this._preparedBase = null; this.setData({ ready: false, report: '', rightsConfirmed: false }) }
    if (field === 'draftId') { this._draft = null; this._reviewRows = null; this._reviewSeen = null; this.setData({ preview: '', reviewItems: [], reviewAllSeen: false, sourceVerified: false, revision: '' }) }
  },
  onFormat(e) { if (this.data.busy) return; this._prepared = null; this._preparedBase = null; this.setData({ format: e.currentTarget.dataset.format, ready: false, report: '', rightsConfirmed: false }) },
  onConfirm(e) {
    if (this.data.busy) return
    const values = e.detail.value || []
    const field = e.currentTarget && e.currentTarget.dataset.field
    if (field === 'rights') this.setData({ rightsConfirmed: values.includes('rights') })
    else if (field === 'pagedRights') this.setData({ pagedRights: values.includes('rights') })
    else if (field === 'sources') this.setData({ sourceVerified: values.includes('sources') })
    else this.setData({ rightsConfirmed: values.includes('rights'), sourceVerified: values.includes('sources') })
  },
  onCheck() {
    if (this.data.busy) return
    if (this._editorDirty || this._questionFormDirty) { this._prepared = null; this._preparedBase = null; this.setData({ error: 'UNSAVED_WORKSPACE_CHANGES', ready: false, rightsConfirmed: false }); return }
    const { prepared, ...report } = this._client.preflight(this.data.inputText, this.data.format)
    this._prepared = prepared || null
    this._preparedBase = prepared && prepared.bank.schemaVersion === 3 && this._workspace ? this._workspace.basePublication || undefined : undefined
    this.setData({ ready: report.ok, report: JSON.stringify(report, null, 2) })
  },
  onSubmit() {
    if (!this._prepared) { this.setData({ error: 'PREFLIGHT_REQUIRED' }); return }
    this._run(() => this._client.submitDraft(this._prepared, { submissionId: this.data.submissionId, rightsConfirmed: this.data.rightsConfirmed, basePublication: this._preparedBase }), result => {
      if (this._prepared && this._prepared.bank.schemaVersion === 3) this._editorDirty = false
      this._draft = null; this._reviewRows = null; this._reviewSeen = null; this.setData({ draftId: result.draftId, preview: '', reviewItems: [], reviewAllSeen: false, sourceVerified: false, result: JSON.stringify(result, null, 2) })
    })
  },
  onChoosePagedFile() {
    if (this._editorDirty || this._questionFormDirty) { this.setData({ error: 'UNSAVED_WORKSPACE_CHANGES' }); return }
    if (!this.data.canEdit || this.data.busy) return
    this._pagedPrepared = null; this._pagedBase = null; this.setData({ pagedReady: false, pagedRights: false, pagedReport: '' })
    this._run(async live => {
      const chosen = await new Promise((resolve, reject) => {
        if (typeof wx.chooseMessageFile !== 'function') return reject(Object.assign(new Error('FILE_API_UNAVAILABLE'), { code: 'FILE_API_UNAVAILABLE' }))
        wx.chooseMessageFile({ count: 1, type: 'file', extension: ['json'], success: resolve, fail: reject })
      })
      if (!live()) throw Object.assign(new Error('STALE_OPERATOR_CONTEXT'), { code: 'STALE_OPERATOR_CONTEXT' })
      const file = chosen && Array.isArray(chosen.tempFiles) && chosen.tempFiles[0]
      if (!file || typeof file.path !== 'string' || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > 12000000) throw Object.assign(new Error('INPUT_TOO_LARGE_FOR_PAGE'), { code: 'INPUT_TOO_LARGE_FOR_PAGE' })
      const buffer = await new Promise((resolve, reject) => wx.getFileSystemManager().readFile({ filePath: file.path, success: r => resolve(r.data), fail: reject }))
      if (!live()) throw Object.assign(new Error('STALE_OPERATOR_CONTEXT'), { code: 'STALE_OPERATOR_CONTEXT' })
      if (!buffer || buffer.byteLength !== file.size) throw Object.assign(new Error('BAD_FILE_LENGTH'), { code: 'BAD_FILE_LENGTH' })
      const content = decodeUtf8(buffer)
      const prepared = this._client.preparePaged(content), base = await this._client.pagedBase()
      return { prepared, base }
    }, result => {
      this._pagedPrepared = result.prepared; this._pagedBase = result.base
      this.setData({ pagedReady: true, pagedReport: `校验通过：${result.prepared.root.totalQuestions} 题、${result.prepared.root.pages.length} 页。提交的是完整题库快照，将替换当前目录；基线修订 ${result.base ? result.base.revision : 0}。`, error: '' })
    })
  },
  onSubmitPaged() {
    if (!this._pagedPrepared) { this.setData({ error: 'PREFLIGHT_REQUIRED' }); return }
    this._run(live => this._client.submitPaged(this._pagedPrepared, { submissionId: this.data.pagedSubmissionId, rightsConfirmed: this.data.pagedRights,
      basePublication: this._pagedBase, onStarted: (draftId, total) => { if (live()) this.setData({ draftId, pagedReport: `草稿 ${draftId} 已上传 0 / ${total} 页，尚未发布。` }) },
      onProgress: (done, total, draftId) => { if (live()) this.setData({ draftId, pagedReport: `草稿 ${draftId} 已上传 ${done} / ${total} 页，尚未发布。` }) } }, live), result => {
      this._draft = null; this._reviewRows = null; this._reviewSeen = null
      this.setData({ draftId: result.draftId, preview: '', reviewItems: [], reviewAllSeen: false, sourceVerified: false, result: JSON.stringify(result, null, 2) })
    })
  },
  onAbandonPagedDraft() {
    if (!this.data.canEdit || this.data.busy || !this._active || !this._client.current(this._context)) return
    const draftId = this.data.draftId, generation = this._generation, ctx = this._context
    if (!/^qpd_[a-f0-9]{64}$/.test(draftId || '')) { this.setData({ error: 'BAD_DRAFT_ID' }); return }
    wx.showModal({ title: '丢弃未封存的暂存草稿', content: '仅可丢弃本人尚在上传的草稿，并删除其私有来源暂存；已封存或发布的草稿不会删除。此操作无法撤销。', success: result => {
      if (!result.confirm || generation !== this._generation || !this._active || ctx !== this._context || draftId !== this.data.draftId || !this._client.current(ctx)) return
      this._run(() => this._client.abandonPagedDraft(draftId), value => { this._draft = null; this._reviewRows = null; this._reviewSeen = null; this.setData({ preview: '', reviewItems: [], result: JSON.stringify(value, null, 2) }) })
    } })
  },
  onCleanupPagedRelease() {
    if (!this.data.canEdit || this.data.busy || !this._active || !this._client.current(this._context)) return
    const draftId = this.data.draftId, generation = this._generation, ctx = this._context
    if (!/^qpd_[a-f0-9]{64}$/.test(draftId || '')) { this.setData({ error: 'BAD_DRAFT_ID' }); return }
    wx.showModal({ title: '清理未引用的题目暂存', content: '仅针对本人已丢弃的草稿；仍被其他草稿或任何发布引用时会拒绝清理。', success: result => {
      if (!result.confirm || generation !== this._generation || !this._active || ctx !== this._context || draftId !== this.data.draftId || !this._client.current(ctx)) return
      this._run(() => this._client.cleanupPagedRelease(draftId), value => this.setData({ result: JSON.stringify(value, null, 2) }))
    } })
  },
  onReadDraft() {
    if (/^qpd_/.test(this.data.draftId)) {
      this._run(async () => {
        const result = await this._client.getPagedDraft(this.data.draftId), draft = result.draft
        if (!draft || !paged.validRoot(draft.root) || !paged.validEvidence(draft.root, draft.evidence)) throw Object.assign(new Error('INVALID_DRAFT'), { code: 'INVALID_DRAFT' })
        const first = await this._client.getPagedDraftPage(draft.draftId, 0)
        if (!paged.validPagePair(draft.root, draft.evidence, first.page, first.sourcePage)) throw Object.assign(new Error('INVALID_PAGED_PAGE'), { code: 'INVALID_PAGED_PAGE' })
        return { draft, first }
      }, result => {
        this._draft = result.draft; this._reviewRows = null; this._reviewSeen = new Set()
        this.setData({ preview: JSON.stringify({ draftId: result.draft.draftId, state: result.draft.state, manifest: result.draft.root.manifest,
          releaseId: result.draft.root.releaseId, totalQuestions: result.draft.root.totalQuestions }, null, 2), sourceVerified: false })
        this._renderPagedReview(result.first)
      })
      return
    }
    this._run(() => this._client.getDraft(this.data.draftId), result => {
    const preview = JSON.stringify(result.draft)
    if (utf8Bytes(preview) > 800000) { this._draft = null; this._reviewRows = null; this.setData({ preview: '', reviewItems: [], reviewAllSeen: false, sourceVerified: false, error: 'DRAFT_TOO_LARGE_FOR_PAGE' }); return }
    const draft = result.draft
    this._draft = draft
    this._reviewRows = Object.values(draft.bank.questions).flat().map(q => ({ id: q.id, text: JSON.stringify({ question: q, source: draft.sources[q.id] }, null, 2) }))
    this._reviewSeen = new Set()
    this.setData({ preview: JSON.stringify({ draftId: draft.draftId, state: draft.state, manifest: draft.bank.manifest, releaseId: draft.bank.releaseId }, null, 2), sourceVerified: false })
    this._renderReview(1)
    })
  },
  _renderPagedReview(result) {
    const page = result.page, sourcePage = result.sourcePage
    this._reviewSeen.add(page.index)
    this.setData({ reviewPage: page.index + 1, reviewPages: this._draft.root.pages.length,
      reviewItems: page.questions.map(q => ({ id: q.id, text: JSON.stringify({ question: q, source: sourcePage.sources[q.id] }, null, 2) })),
      reviewAllSeen: this._reviewSeen.size === this._draft.root.pages.length })
  },
  _renderReview(page) {
    if (!this._reviewRows || !this._reviewSeen) return
    const pages = Math.max(1, Math.ceil(this._reviewRows.length / 10)), current = Math.max(1, Math.min(page, pages))
    this._reviewSeen.add(current)
    this.setData({ reviewPage: current, reviewPages: pages, reviewItems: this._reviewRows.slice((current - 1) * 10, current * 10), reviewAllSeen: this._reviewSeen.size === pages })
  },
  onReviewPage(e) {
    if (this.data.busy || !this._draft || this._draft.draftId !== this.data.draftId) return
    const delta = Number(e.currentTarget.dataset.delta)
    if (delta !== -1 && delta !== 1) return
    if (this._draft.kind === 'pagedCatalogDraft') {
      const index = Math.max(0, Math.min(this._draft.root.pages.length - 1, this.data.reviewPage - 1 + delta)), draft = this._draft
      this._run(() => this._client.getPagedDraftPage(draft.draftId, index), result => {
        if (!paged.validPagePair(draft.root, draft.evidence, result.page, result.sourcePage) || result.page.index !== index) { this.setData({ error: 'INVALID_PAGED_PAGE' }); return }
        this._renderPagedReview(result)
      })
    } else this._renderReview(this.data.reviewPage + delta)
  },
  onReview(e) {
    if (!this._draft || this._draft.draftId !== this.data.draftId) { this.setData({ error: 'READ_DRAFT_REQUIRED' }); return }
    if (e.currentTarget.dataset.decision === 'approve' && !this.data.reviewAllSeen) { this.setData({ error: 'REVIEW_PAGES_REQUIRED' }); return }
    const method = this._draft.kind === 'pagedCatalogDraft' ? this._client.reviewPaged : this._client.review
    this._run(() => method({ draftId: this.data.draftId, decision: e.currentTarget.dataset.decision, note: this.data.note, sourceVerified: this.data.sourceVerified })) },
  onReadRevision() {
    if (this._draft && this._draft.kind === 'pagedCatalogDraft') this._run(() => this._client.pagedBase(), base => this.setData({ revision: String(base ? base.revision : 0) }))
    else this._run(() => this._client.activeDraft(), result => this.setData({ revision: String(result.basePublication ? result.basePublication.revision : 0) }))
  },
  onPublish() {
    if (!this._draft || this._draft.draftId !== this.data.draftId) { this.setData({ error: 'READ_DRAFT_REQUIRED' }); return }
    if (!/^\d+$/.test(this.data.revision)) { this.setData({ error: 'BAD_REVISION' }); return }
    const method = this._draft.kind === 'pagedCatalogDraft' ? this._client.publishPaged : this._draft.bank.schemaVersion === 3 ? this._client.publishExam : this._client.publish
    this._run(() => method({ draftId: this.data.draftId, expectedRevision: Number(this.data.revision) }))
  },
  onWithdraw() {
    this._run(live => {
      const input = { draftId: this.data.draftId, questionIds: this.data.removeIds.split(/[,，\s]+/).filter(Boolean), submissionId: this.data.submissionId, rightsConfirmed: this.data.rightsConfirmed }
      return /^qpd_/.test(input.draftId) ? this._client.withdrawPaged(input, live) : this._client.withdraw(input)
    }, result => { this._draft = null; this._reviewRows = null; this._reviewSeen = null; this.setData({ draftId: result.draftId, preview: '', reviewItems: [], reviewAllSeen: false, sourceVerified: false, result: JSON.stringify(result, null, 2) }) })
  },
  _renderEditor() {
    const w = this._workspace, subject = w && w.bank.manifest.subjects.find(s => s.key === this.data.selectedSubject)
    const chapter = subject && subject.chapters.find(c => c.key === this.data.selectedChapter)
    const rows = chapter ? w.bank.questions[subject.key].filter(q => q.chapter === chapterIdentity(subject.key, chapter.key)) : []
    const pages = Math.max(1, Math.ceil(rows.length / 20)), page = Math.max(1, Math.min(this.data.questionPage || 1, pages))
    const summaries = rows.slice((page - 1) * 20, page * 20).map(q => {
      const chars = Array.from(q.stem), stem = chars.slice(0, 120).join('') + (chars.length > 120 ? '…' : '')
      return { id: q.id, stem }
    })
    this.setData({ editorReady: !!w, exams: w ? w.bank.manifest.exams : [], subjects: w ? w.bank.manifest.subjects : [],
      chapters: subject ? subject.chapters : [], questions: summaries, questionPage: page, questionPages: pages, questionTotal: rows.length })
  },
  _editorUI(patch = {}) {
    return { form: this.data.form, selectedExam: this.data.selectedExam, selectedSubject: this.data.selectedSubject,
      selectedChapter: this.data.selectedChapter, editingId: this.data.editingId, questionPage: this.data.questionPage,
      editorDirty: !!this._editorDirty, questionFormDirty: !!this._questionFormDirty, ...patch }
  },
  _saveEditorForm(ui) {
    if (!this._active || !this._context || !this._client.current(this._context) || !this._checkpoint || !this._checkpointToken) return false
    try { this._checkpointToken = this._checkpoint.saveForm(this._checkpointToken, ui); return true }
    catch (e) { this.setData({ error: e.code || 'LOCAL_DRAFT_WRITE_FAILED' }); return false }
  },
  onRestoreEditor() {
    if (!this.data.canEdit || this.data.busy || !this._active || !this._client.current(this._context)) return
    try {
      const saved = this._checkpoint.read()
      if (!saved || !editor.validWorkspace(saved.workspace) || !saved.ui || !saved.ui.form ||
        Object.keys(editorForm()).some(k => typeof saved.ui.form[k] !== 'string') ||
        ['selectedExam', 'selectedSubject', 'selectedChapter', 'editingId'].some(k => typeof saved.ui[k] !== 'string') ||
        typeof saved.ui.editorDirty !== 'boolean' || typeof saved.ui.questionFormDirty !== 'boolean' || !Number.isSafeInteger(saved.ui.questionPage) || saved.ui.questionPage < 1) throw Object.assign(new Error('LOCAL_DRAFT_INVALID'), { code: 'LOCAL_DRAFT_INVALID' })
      this._workspace = saved.workspace; this._checkpointToken = saved.token; this._editorDirty = saved.ui.editorDirty; this._questionFormDirty = saved.ui.questionFormDirty
      this._prepared = null; this._preparedBase = null; this._pagedPrepared = null; this._pagedBase = null
      this.setData({ ...saved.ui, ready: false, rightsConfirmed: false, report: '', pagedReady: false, pagedRights: false, pagedReport: '', error: '',
        questionTypeName: (questionTypes.find(x => x.value === saved.ui.form.type) || {}).name || saved.ui.form.type,
        sourceTypeName: (sourceTypes.find(x => x.value === saved.ui.form.sourceKind) || {}).name || saved.ui.form.sourceKind })
      this._renderEditor()
    } catch (e) { this.setData({ error: e.code || 'LOCAL_DRAFT_INVALID' }) }
  },
  onCleanupEditorOrphans() {
    if (!this.data.canEdit || this.data.busy || !this._active || !this._client.current(this._context)) return
    try {
      const result = this._checkpoint.cleanupOrphans()
      this.setData({ result: `已清理 ${result.removed} 个本账号未引用的编辑分片。`, error: '' })
    } catch (e) { this.setData({ error: e.code || 'LOCAL_DRAFT_CLEANUP_FAILED' }) }
  },
  onDiscardEditor() {
    if (!this.data.canEdit || this.data.busy || !this._active || !this._client.current(this._context)) return
    let saved
    try { saved = this._checkpoint.read() } catch (e) { this.setData({ error: e.code || 'LOCAL_DRAFT_READ_FAILED' }); return }
    if (!saved) return
    if (this._workspace && JSON.stringify(this._checkpointToken) !== JSON.stringify(saved.token)) { this.setData({ error: 'LOCAL_DRAFT_CHANGED' }); return }
    const generation = this._generation, ctx = this._context
    wx.showModal({ title: '丢弃本机编辑', content: '仅删除本账号保存在本机的编辑内容；已提交的云端草稿不受影响。', success: result => {
      if (!result.confirm || generation !== this._generation || !this._active || ctx !== this._context || !this._client.current(ctx)) return
      try {
        this._checkpoint.clear(saved.token); this._checkpointToken = null; this._workspace = null; this._editorDirty = false; this._questionFormDirty = false; this._prepared = null; this._preparedBase = null; this._pagedPrepared = null; this._pagedBase = null
        this.setData({ editorReady: false, exams: [], subjects: [], chapters: [], questions: [], selectedExam: '', selectedSubject: '', selectedChapter: '', editingId: '', form: editorForm(), ready: false, rightsConfirmed: false, pagedReady: false, pagedRights: false, pagedReport: '', error: '' })
      } catch (e) { this.setData({ error: e.code || 'LOCAL_DRAFT_CLEANUP_FAILED' }) }
    } })
  },
  onQuestionPage(e) {
    if (this.data.busy || !this._workspace) return
    if (this._questionFormDirty) { this.setData({ error: 'SAVE_QUESTION_REQUIRED' }); return }
    const delta = Number(e.currentTarget.dataset.delta)
    if (delta !== -1 && delta !== 1) return
    const questionPage = Math.max(1, Math.min(this.data.questionPages, this.data.questionPage + delta))
    if (!this._saveEditorForm(this._editorUI({ questionPage }))) return
    this.setData({ questionPage })
    this._renderEditor()
  },
  onLoadEditor() {
    if (!this.data.canEdit || this.data.busy || !this._active || !this._client.current(this._context)) return
    if (!this._workspace) {
      try { if (this._checkpoint.read()) { this.setData({ error: 'LOCAL_DRAFT_EXISTS' }); return } }
      catch (e) { this.setData({ error: e.code || 'LOCAL_DRAFT_READ_FAILED' }); return }
    }
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
    this._run(async live => {
      const current = await this._client.pagedCurrent()
      if (current.root) return { workspace: await this._client.activePagedWorkspace(live) }
      return { result: await this._client.activeDraft() }
    }, loaded => {
      if (loaded.workspace) {
        if (!editor.validWorkspace(loaded.workspace)) throw Object.assign(new Error('INVALID_PUBLISHED_DRAFT'), { code: 'INVALID_PUBLISHED_DRAFT' })
      }
      const result = loaded.result
      if (result && result.draft && result.draft.bank.schemaVersion !== 3) { this.setData({ error: 'LEGACY_IDENTITY_MIGRATION_REQUIRED' }); return }
      const bytes = utf8Bytes(JSON.stringify(result))
      if (result && bytes > 800000) { this.setData({ error: 'DRAFT_TOO_LARGE_FOR_PAGE' }); return }
      const workspace = loaded.workspace || editor.openWorkspace(result), ui = this._editorUI({ selectedExam: '', selectedSubject: '', selectedChapter: '', editingId: '', questionPage: 1, form: editorForm(), editorDirty: false, questionFormDirty: false })
      const token = this._checkpointToken ? this._checkpoint.saveWorkspace(this._checkpointToken, workspace, ui) : this._checkpoint.create(workspace, ui)
      this._workspace = workspace; this._checkpointToken = token; this._prepared = null; this._preparedBase = null; this._pagedPrepared = null; this._pagedBase = null; this._editorDirty = false; this._questionFormDirty = false
      this.setData({ ...ui, questionTypeName: '单选题', sourceTypeName: '原创', ready: false, rightsConfirmed: false, report: '', pagedReady: false, pagedRights: false, pagedReport: '' })
      this._renderEditor()
    })
  },
  onAiInput(e) {
    if (this.data.busy || !this.data.canEdit || !this._workspace) return
    const field = e.currentTarget.dataset.field, value = e.detail.value
    if (!['aiTopic', 'aiLevel', 'aiCount', 'aiReference', 'aiPermission'].includes(field) || typeof value !== 'string') return
    if (this._aiCandidates && ['aiTopic', 'aiLevel', 'aiCount'].includes(field)) { this.setData({ error: 'AI_CANDIDATES_PENDING' }); return }
    if (value.length > (field === 'aiTopic' ? 300 : field === 'aiReference' || field === 'aiPermission' ? 1000 : 4)) { this.setData({ error: 'INPUT_TOO_LARGE_FOR_PAGE' }); return }
    this.setData({ [field]: value, error: '' })
  },
  onAiType(e) {
    if (this.data.busy || this._aiCandidates) { if (this._aiCandidates) this.setData({ error: 'AI_CANDIDATES_PENDING' }); return }
    const selected = aiTypes[Number(e.detail.value)]
    if (selected) this.setData({ aiType: selected.value, aiTypeName: selected.name, error: '' })
  },
  onAiGenerate() {
    if (!this.data.canEdit || this.data.busy || !this._workspace || !this._active || !this._client.current(this._context)) return
    if (this._aiCandidates) { this.setData({ error: 'AI_CANDIDATES_PENDING' }); return }
    if (this._questionFormDirty) { this.setData({ error: 'SAVE_QUESTION_REQUIRED' }); return }
    const workspace = this._workspace, subject = workspace.bank.manifest.subjects.find(s => s.key === this.data.selectedSubject)
    const chapter = subject && subject.chapters.find(c => c.key === this.data.selectedChapter)
    const exam = subject && workspace.bank.manifest.exams.find(e => e.id === subject.examId)
    if (!subject || !chapter || !exam) { this.setData({ error: 'CHAPTER_NOT_FOUND' }); return }
    const request = { requestId: 'a' + sha256(JSON.stringify([Date.now(), Math.random()])), subjectKey: subject.key, chapterKey: chapter.key,
      examName: exam.name, subjectName: subject.name, chapterName: chapter.name, topic: this.data.aiTopic,
      type: this.data.aiType, level: Number(this.data.aiLevel), count: Number(this.data.aiCount) }
    this._run(async live => {
      const result = await this._aiClient.generate(request, live)
      if (workspace !== this._workspace || this.data.selectedSubject !== subject.key || this.data.selectedChapter !== chapter.key) throw Object.assign(new Error('AI_CANDIDATES_STALE'), { code: 'AI_CANDIDATES_STALE' })
      return result
    }, result => {
      this._aiCandidates = { ...result, workspace, subjectKey: subject.key, chapterKey: chapter.key }
      this.setData({ aiResults: result.questions.map((q, i) => ({ id: q.id, stem: q.stem, options: q.options, answer: q.answer.join('、'), explain: q.explain,
        reviewer: result.reviewer,
        reviewStatus: result.reviews[i].status === 'pass' ? '未发现问题，仍须人工核验' : '需修改或重新生成',
        reviewAnswer: result.reviews[i].answer.join('、') || '无法确定', reviewReason: result.reviews[i].reason,
        reviewIssues: result.reviews[i].issues.join('；') || '未发现问题' })), error: '' })
    })
  },
  onAiDiscard() { if (!this.data.busy) { this._aiCandidates = null; this.setData({ aiResults: [], error: '' }) } },
  onAiAdd() {
    if (!this.data.canEdit || this.data.busy || !this._active || !this._client.current(this._context)) return
    const batch = this._aiCandidates
    if (!batch || batch.workspace !== this._workspace || batch.subjectKey !== this.data.selectedSubject || batch.chapterKey !== this.data.selectedChapter) { this.setData({ error: 'AI_CANDIDATES_STALE' }); return }
    if (!Array.isArray(batch.reviews) || batch.reviews.length !== batch.questions.length || batch.reviews.some(review => review.status !== 'pass')) { this.setData({ error: 'AI_REVIEW_REQUIRED' }); return }
    if (this._questionFormDirty) { this.setData({ error: 'SAVE_QUESTION_REQUIRED' }); return }
    if (!this.data.aiReference.trim() || !this.data.aiPermission.trim()) { this.setData({ error: 'AI_SOURCE_REQUIRED' }); return }
    const source = { kind: 'ai_generated', title: 'AI 生成练习题', reference: this.data.aiReference, permission: this.data.aiPermission,
      attribution: 'AI 辅助生成，待人工核验', generator: batch.generator }
    if (this._changeEditor({ type: 'addGeneratedQuestions', subjectKey: batch.subjectKey, chapterKey: batch.chapterKey, questions: batch.questions, source })) {
      this._aiCandidates = null; this.setData({ aiResults: [], result: `已加入 ${batch.questions.length} 道候选题，请逐题核对后提交审核。` })
    }
  },
  onEditorInput(e) {
    if (this.data.busy || !this.data.canEdit || !this._workspace) return
    const field = e.currentTarget.dataset.field
    if (!Object.prototype.hasOwnProperty.call(this.data.form, field)) return
    const value = e.detail.value
    if (utf8Bytes(value) > 120000) { this.setData({ error: 'INPUT_TOO_LARGE_FOR_PAGE' }); return }
    const questionFormDirty = this._questionFormDirty || ['questionId', 'type', 'stem', 'options', 'answer', 'explain', 'pitfall', 'keyPoint', 'tags', 'level', 'sourceKind', 'sourceTitle', 'sourceReference', 'sourcePermission', 'sourceAttribution', 'sourceGenerator'].includes(field)
    const form = { ...this.data.form, [field]: value }
    if (!this._saveEditorForm(this._editorUI({ form, questionFormDirty: !!questionFormDirty, editorDirty: true }))) return
    this._questionFormDirty = !!questionFormDirty; this._editorDirty = true
    this._prepared = null; this._preparedBase = null; this._pagedPrepared = null; this._pagedBase = null
    this.setData({ form, ready: false, rightsConfirmed: false, report: '', pagedReady: false, pagedRights: false, pagedReport: '',
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
    if ((kind === 'subject' && id === this.data.selectedSubject) || (kind === 'chapter' && id === this.data.selectedChapter)) return
    if (this._questionFormDirty && (kind === 'subject' || kind === 'chapter')) { this.setData({ error: 'SAVE_QUESTION_REQUIRED' }); return }
    const reset = { editingId: '', form: resetQuestion(this.data.form), questionTypeName: '单选题', sourceTypeName: '原创' }
    const patch = kind === 'exam' ? { selectedExam: id } : kind === 'subject' ? { selectedSubject: id, selectedChapter: '', editingId: '', questionPage: 1 }
      : kind === 'chapter' ? { selectedChapter: id, editingId: '', questionPage: 1 } : null
    if (patch && kind !== 'exam') Object.assign(patch, reset)
    if (!patch || !this._saveEditorForm(this._editorUI(patch))) return
    this.setData(patch)
    this._renderEditor()
  },
  _changeEditor(action, uiPatch = {}) {
    if (this.data.busy || !this.data.canEdit || !this._workspace || !this._active || !this._client.current(this._context)) return
    try {
      const next = editor.change(this._workspace, action)
      if (next.bank.schemaVersion === 3 && utf8Bytes(JSON.stringify(next)) > 800000) throw Object.assign(new Error('DRAFT_TOO_LARGE_FOR_PAGE'), { code: 'DRAFT_TOO_LARGE_FOR_PAGE' })
      const ui = this._editorUI({ editorDirty: true, ...uiPatch })
      const token = this._checkpoint.saveWorkspace(this._checkpointToken, next, ui)
      this._workspace = next; this._checkpointToken = token; this._prepared = null; this._preparedBase = null; this._pagedPrepared = null; this._pagedBase = null
      this._editorDirty = true
      this._questionFormDirty = ui.questionFormDirty
      this.setData({ ...uiPatch, ready: false, rightsConfirmed: false, report: '', pagedReady: false, pagedRights: false, pagedReport: '', error: '' }); this._renderEditor(); return true
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
    const id = e.currentTarget.dataset.id
    if (!(this.data.questions || []).some(item => item.id === id)) return
    const rows = this._workspace.bank.questions[this.data.selectedSubject] || []
    const q = rows.find(item => item.id === id && item.chapter === chapterIdentity(this.data.selectedSubject, this.data.selectedChapter))
    if (!q) return
    if (this._questionFormDirty) { this.setData({ error: 'SAVE_QUESTION_REQUIRED' }); return }
    const s = this._workspace.sources[q.id], f = this.data.form
    const form = { ...f, questionId: q.id, type: q.type, stem: q.stem,
      options: 'JSON:' + JSON.stringify(q.options), answer: q.type === 'fill' ? 'JSON:' + JSON.stringify(q.answer) : q.answer.join(','),
      explain: q.explain, pitfall: q.pitfall, keyPoint: q.keyPoint, tags: 'JSON:' + JSON.stringify(q.tags), level: String(q.level),
      sourceKind: s.kind, sourceTitle: s.title, sourceReference: s.reference, sourcePermission: s.permission, sourceAttribution: s.attribution, sourceGenerator: s.generator || '' }
    if (!this._saveEditorForm(this._editorUI({ editingId: q.id, form }))) return
    this.setData({ editingId: q.id, questionTypeName: (questionTypes.find(item => item.value === q.type) || {}).name || q.type,
      sourceTypeName: (sourceTypes.find(item => item.value === s.kind) || {}).name || s.kind, form })
  },
  _resetQuestionForm() {
    const form = resetQuestion(this.data.form)
    if (!this._saveEditorForm(this._editorUI({ editingId: '', form, questionFormDirty: false }))) return
    this._questionFormDirty = false
    this.setData({ editingId: '', questionTypeName: '单选题', sourceTypeName: '原创', form, error: '' })
  },
  onNewQuestion() { if (!this.data.busy) { if (this._questionFormDirty) { this.setData({ error: 'SAVE_QUESTION_REQUIRED' }); return } this._resetQuestionForm() } },
  onDiscardQuestion() {
    if (!this._questionFormDirty || !this._active || !this._client.current(this._context)) return
    const generation = this._generation, ctx = this._context, workspace = this._workspace, form = this.data.form
    wx.showModal({ title: '放弃题目修改', content: '尚未保存到题库的题目表单内容将被放弃。', success: result => {
      if (!result.confirm || generation !== this._generation || !this._active || ctx !== this._context || workspace !== this._workspace || form !== this.data.form || !this._client.current(ctx)) return
      this._resetQuestionForm()
    } })
  },
  onSaveQuestion() {
    const f = this.data.form
    try {
      const options = f.type === 'fill' ? [] : f.options.startsWith('JSON:') ? jsonArray(f.options, 'BAD_OPTIONS') : f.options.split('\n').filter(line => line.trim()).map(line => {
        const index = line.indexOf('='); if (index < 1) throw Object.assign(new Error('BAD_OPTIONS'), { code: 'BAD_OPTIONS' })
        return { key: line.slice(0, index).trim(), text: line.slice(index + 1).trim() }
      })
      const answer = f.type === 'fill' ? f.answer.startsWith('JSON:') ? jsonArray(f.answer, 'BAD_ANSWER') : f.answer.split(';').map(part => { const a = part.split('|').map(x => x.trim()); return a.length === 1 ? a[0] : a }) : f.answer.split(',').map(x => x.trim()).filter(Boolean)
      const question = { id: f.questionId, type: f.type, stem: f.stem, options, answer, explain: f.explain, pitfall: f.pitfall, keyPoint: f.keyPoint,
        tags: f.tags.startsWith('JSON:') ? jsonArray(f.tags, 'BAD_QUESTION') : f.tags.split(',').map(x => x.trim()).filter(Boolean), level: Number(f.level) }
      const source = { kind: f.sourceKind, title: f.sourceTitle, reference: f.sourceReference, permission: f.sourcePermission, attribution: f.sourceAttribution, ...(f.sourceKind === 'ai_generated' ? { generator: f.sourceGenerator } : {}) }
      this._changeEditor({ type: 'saveQuestion', subjectKey: this.data.selectedSubject, chapterKey: this.data.selectedChapter, existingId: this.data.editingId, question, source },
        { questionFormDirty: false, editingId: question.id })
    } catch (e) { this.setData({ error: e.code || 'BAD_QUESTION' }) }
  },
  onPrepareEditor() {
    if (this.data.busy || !this.data.canEdit || !this._workspace || !this._active || !this._client.current(this._context)) return
    if (this._questionFormDirty) { this.setData({ ready: false, error: 'SAVE_QUESTION_REQUIRED' }); return }
    try {
      if (this._workspace.bank.schemaVersion === 4) {
        this._pagedPrepared = editor.prepare(this._workspace); this._pagedBase = this._workspace.basePublication
        this._prepared = null; this._preparedBase = null
        this.setData({ ready: false, rightsConfirmed: false, pagedReady: true, pagedRights: false,
          pagedReport: `编辑内容已校验：${this._pagedPrepared.root.totalQuestions} 题、${this._pagedPrepared.root.pages.length} 页。请在下方填写提交 ID 并确认发布权。`, error: '' })
        return
      }
      this._prepared = editor.prepare(this._workspace); this._preparedBase = this._workspace.basePublication || undefined
      const bank = this._prepared.bank, count = Object.values(bank.questions).reduce((sum, rows) => sum + rows.length, 0)
      this.setData({ ready: true, rightsConfirmed: false, report: `内容校验通过：${bank.manifest.exams.length} 个考试、${bank.manifest.subjects.length} 个科目、${count} 道题。请核对来源、填写提交 ID 并确认发布权。`, error: '' })
    } catch (e) { this._prepared = null; this._preparedBase = null; this._pagedPrepared = null; this._pagedBase = null; this.setData({ ready: false, pagedReady: false, pagedRights: false, error: e.code || 'BAD_BANK' }) }
  }
})
