const config = require('../../utils/config.js')
const user = require('../../utils/user.js')
const { currentExam } = require('../../utils/protected-catalog.js')
const available = () => config.protectedPracticePreview === true || config.protectedCatalog === true
const recordsEnabled = () => config.protectedRecordsPreview === true || config.protectedCatalog === true
const { canonical } = require('../../shared/question-domain.js')
const { judge, validSelection } = require('../../shared/grading-domain.js')
const { runtimeProtectedPracticeClient } = require('../../utils/protected-practice-client.js')
const { runtimeProtectedStudySession } = require('../../utils/protected-study-session.js')
const { runtimeProtectedMarkerClient } = require('../../utils/protected-marker-client.js')
const errors = { ENTITLEMENT_REQUIRED: '该考试尚无有效权限，或权限已到期。', STALE_RELEASE: '题库已更新，请重新开始练习。',
  INVALID_TOKEN: '登录已失效，请重新登录。', STALE_CONTEXT: '账号已切换，请重新开始。',
  PROTECTED_READ_DISABLED: '受保护题库尚未开放，请在隔离环境联调。', NETWORK_ERROR: '网络不可用，请联网后重试。' }
const blank = () => ({ available: available(), busy: false, question: null, selected: [], submitted: false,
  correct: false, finished: false, error: '', showPlans: false, answered: 0, correctCount: 0, examName: '',
  recordsPreview: recordsEnabled(), historyCount: 0, historyCorrect: 0, markerLoaded: false, markerBusy: false, markerError: '', starred: false })
Page({
  data: blank(),
  onLoad(options) {
    this._client = runtimeProtectedPracticeClient(); this._recorder = runtimeProtectedStudySession(); this._markers = runtimeProtectedMarkerClient(); this._generation = 0
    const id = options && options.questionId
    const subject = options && options.subject
    this._subjectId = typeof subject === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(subject) ? subject : ''
    this._targetQuestionId = typeof id === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(id) ? id : ''
  },
  onShow() {
    this._active = true; const generation = ++this._generation
    this._ctx = null; this._syncCtx = null; this._operation = null; this._baseline = null; this._cursor = null; this.setData(blank())
    if (!available()) return
    user.whenReady(() => { if (this._active && generation === this._generation) this.restart() })
  },
  onHide() { this._active = false; this._generation++; this._ctx = null; this._syncCtx = null; this._operation = null; this._baseline = null; this._cursor = null; this.setData(blank()) },
  onUnload() { this.onHide() },
  _live(generation, ctx) {
    try { return this._active && generation === this._generation && this._ctx === ctx && this._client.current(ctx) && currentExam() === this._examId &&
      (!recordsEnabled() || this._recorder.current(this._syncCtx)) }
    catch (e) { return false }
  },
  _clear(message) { this._baseline = null; this._cursor = null; this.setData({ busy: false, question: null, selected: [], submitted: false, finished: false, error: message, showPlans: message === errors.ENTITLEMENT_REQUIRED }) },
  goPlans() { if (this.data.showPlans) wx.navigateTo({ url: '/pages/exam-plans/exam-plans' }) },
  _check() {
    try { if (this._active && this._ctx && this._client.current(this._ctx) && currentExam() === this._examId &&
      (!recordsEnabled() || this._recorder.current(this._syncCtx))) return true } catch (e) { /* fail closed on unreadable account or exam */ }
    this._clear(errors.STALE_CONTEXT); return false
  },
  async restart() {
    if (!this._active || !available() || this.data.busy) return
    try { this._ctx = this._client.capture(); this._examId = currentExam(); this._syncCtx = recordsEnabled() ? this._recorder.capture() : null } catch (e) { this._clear('请先登录并完成学习数据同步或清空操作。'); return }
    if (!this._examId) { this._clear('请先在首页选择考试。'); return }
    this._generation++; this._baseline = null; this._cursor = null; this._operation = null
    const generation = this._generation, ctx = this._ctx
    this.setData({ ...blank(), busy: false })
    if (recordsEnabled()) {
      this.setData({ busy: true })
      try {
        const history = await this._recorder.prepare(this._examId, this._syncCtx)
        if (!this._live(generation, ctx)) { if (this._active && generation === this._generation) this._clear(errors.STALE_CONTEXT); return }
        this.setData({ busy: false, historyCount: history.snapshotSequence, historyCorrect: history.correct })
      } catch (e) { if (this._active && generation === this._generation) this._clear('学习记录同步失败，请联网后重试。'); return }
    }
    return this._targetQuestionId ? this._loadTarget() : this._load(0, 0)
  },
  async _loadTarget() {
    if (!this._check() || this.data.busy) return
    const ctx = this._ctx, generation = this._generation
    this.setData({ busy: true, question: null, selected: [], submitted: false, error: '' })
    try {
      const result = await this._client.question(this._examId, this._targetQuestionId, ctx)
      if (!this._live(generation, ctx)) { if (this._active && generation === this._generation) this._clear(errors.STALE_CONTEXT); return }
      this._baseline = result.baseline; this._cursor = result.cursor; this._operation = null; this._startedAt = Date.now()
      const question = result.question
      this.setData({ busy: false, question, examName: result.scope.exam.name, selected: question.type === 'fill' ? question.answer.map(() => '') : [], markerLoaded: false, starred: false, markerError: '' })
      if (recordsEnabled()) this._loadMarker(question.id)
    } catch (e) { if (this._active && generation === this._generation) this._clear(e.code === 'QUESTION_UNAVAILABLE' ? '该题已不在当前题库，学习记录仍保留。' : (errors[e.code] || '题目读取失败，请检查网络或稍后重试。')) }
  },
  async _load(pageIndex, position) {
    if (!this._check() || this.data.busy) return
    const ctx = this._ctx, generation = this._generation
    this.setData({ busy: true, question: null, selected: [], submitted: false, error: '' })
    try {
      let current = pageIndex, offset = position
      while (true) {
        const result = await this._client.page(this._examId, current, this._baseline, ctx)
        if (!this._live(generation, ctx)) { if (this._active && generation === this._generation) this._clear(errors.STALE_CONTEXT); return }
        this._baseline = result.baseline
        if (this._subjectId && !result.scope.subjects.some(subject => subject.key === this._subjectId)) { this._clear('该科目已不存在，请返回首页重新选择。'); return }
        offset = result.page.questions.findIndex((question, index) => index >= offset && (!this._subjectId || question.subject === this._subjectId))
        if (offset >= 0) {
          const question = result.page.questions[offset]
          this._operation = null
          this._startedAt = Date.now()
          this._cursor = { pageIndex: current, position: offset }
          this.setData({ question, examName: result.scope.exam.name, selected: question.type === 'fill' ? question.answer.map(() => '') : [], busy: false, markerLoaded: false, starred: false, markerError: '' })
          if (recordsEnabled()) this._loadMarker(question.id)
          return
        }
        current++; offset = 0
        if (current >= result.scope.sourcePageCount) { this._cursor = null; this.setData({ busy: false, finished: true }); return }
      }
    } catch (e) { if (this._active && generation === this._generation) this._clear(errors[e.code] || '题目读取失败，请检查网络或稍后重试。') }
  },
  onSelect(e) {
    if (!this._check() || this.data.busy || this.data.submitted || !this.data.question) return
    const q = this.data.question, key = e.detail.key
    if (!q.options.some(option => option.key === key)) return
    let selected = this.data.selected.slice()
    if (['multiple', 'uncertain', 'sort'].includes(q.type)) { const pos = selected.indexOf(key); if (pos >= 0) selected.splice(pos, 1); else selected.push(key); if (q.type !== 'sort') selected.sort() } else selected = [key]
    this.setData({ selected })
  },
  onFill(e) {
    if (!this._check() || this.data.busy || this.data.submitted || !this.data.question || this.data.question.type !== 'fill') return
    const i = e.detail.index, selected = this.data.selected.slice()
    if (!Number.isSafeInteger(i) || i < 0 || i >= selected.length) return
    selected[i] = String(e.detail.value || ''); this.setData({ selected })
  },
  onSort(e) {
    if (!this._check() || this.data.busy || this.data.submitted || !this.data.question || this.data.question.type !== 'sort') return
    const selected = this.data.selected.slice(), i = e.detail.index, action = e.detail.action
    if (action === 'clear') selected.length = 0
    else if (Number.isSafeInteger(i) && i >= 0 && i < selected.length) {
      if (action === 'remove') selected.splice(i, 1)
      if (action === 'up' && i > 0) [selected[i - 1], selected[i]] = [selected[i], selected[i - 1]]
      if (action === 'down' && i + 1 < selected.length) [selected[i + 1], selected[i]] = [selected[i], selected[i + 1]]
    }
    this.setData({ selected })
  },
  async onSubmit() {
    if (!this._check() || this.data.busy || this.data.submitted || !this.data.question || !this._cursor) return
    const question = this.data.question, selected = this.data.selected.slice(), cursor = this._cursor
    if (!validSelection(question, selected)) { this.setData({ error: '请完成作答后再提交。' }); return }
    const ctx = this._ctx, generation = this._generation
    this.setData({ busy: true, question: null, error: '' })
    try {
      if (recordsEnabled()) {
        if (!this._operation) this._operation = { dataEpoch: this._syncCtx.dataEpoch,
          operationId: 'ps_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2),
          examId: this._examId, releaseId: this._baseline.releaseId, publicationRevision: this._baseline.publicationRevision,
          questionId: question.id, questionVersionId: question.versionId, selected, costMs: Math.min(86400000, Math.max(0, Date.now() - (this._startedAt || Date.now()))) }
        const receipt = await this._recorder.submit(this._syncCtx, this._operation)
        if (!this._live(generation, ctx)) { if (this._active && generation === this._generation) this._clear(errors.STALE_CONTEXT); return }
        const correct = receipt.attempt.score === 1
        this.setData({ busy: false, question, selected, submitted: true, correct, answered: this.data.answered + 1,
          correctCount: this.data.correctCount + (correct ? 1 : 0) })
        if (!this.data.markerLoaded) this._loadMarker(question.id)
        return
      }
      const fresh = await this._client.page(this._examId, cursor.pageIndex, this._baseline, ctx)
      if (!this._live(generation, ctx)) { if (this._active && generation === this._generation) this._clear(errors.STALE_CONTEXT); return }
      if (canonical(fresh.page.questions[cursor.position]) !== canonical(question)) { this._clear(errors.STALE_RELEASE); return }
      const correct = judge(question.type, selected, question.answer)
      this.setData({ busy: false, question, selected, submitted: true, correct, answered: this.data.answered + 1, correctCount: this.data.correctCount + (correct ? 1 : 0) })
    } catch (e) {
      if (!this._active || generation !== this._generation) return
      if (!this._live(generation, ctx)) { this._clear(errors.STALE_CONTEXT); return }
      if (recordsEnabled() && this._operation) this._clear((errors[e.code] ? errors[e.code] + ' ' : '') + '提交尚未确认，请重新开始并核对学习记录。')
      else this._clear(errors[e.code] || '权益校验失败，请联网后重试。')
    }
  },
  async _loadMarker(questionId) {
    if (!this._check() || !recordsEnabled() || !this._syncCtx || !questionId) return
    const ctx = this._ctx, generation = this._generation, request = this._markerGeneration = (this._markerGeneration || 0) + 1
    this.setData({ markerLoaded: false, markerError: '' })
    try {
      const state = await this._markers.get(this._examId, this._syncCtx, value => this._recorder.current(value))
      if (!this._live(generation, ctx) || request !== this._markerGeneration || !this.data.question || this.data.question.id !== questionId) return
      this._markerRevision = state.revision
      const row = state.entries.find(entry => entry.questionId === questionId)
      this.setData({ markerLoaded: true, starred: !!(row && row.starred) })
    } catch (e) {
      if (this._live(generation, ctx) && request === this._markerGeneration && this.data.question && this.data.question.id === questionId) this.setData({ markerError: '收藏状态读取失败，可重试。' })
    }
  },
  retryMarker() { if (this.data.question) return this._loadMarker(this.data.question.id) },
  async toggleStar() {
    if (!this._check() || !this.data.question || !this.data.submitted || !this.data.markerLoaded || this.data.markerBusy) return
    const question = this.data.question, ctx = this._ctx, generation = this._generation
    const input = { examId: this._examId, questionId: question.id, field: 'starred', value: !this.data.starred, expectedRevision: this._markerRevision,
      releaseId: this._baseline.releaseId, publicationRevision: this._baseline.publicationRevision,
      operationId: 'pm_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2) }
    this.setData({ markerBusy: true, markerError: '' })
    try {
      const result = await this._markers.set(input, this._syncCtx, value => this._recorder.current(value))
      if (!this._live(generation, ctx) || !this.data.question || this.data.question.id !== question.id) return
      this._markerRevision = result.revision; this.setData({ starred: input.value })
    } catch (err) {
      if (!this._live(generation, ctx) || !this.data.question || this.data.question.id !== question.id) return
      await this._loadMarker(question.id)
      if (this._live(generation, ctx)) this.setData({ markerError: err.code === 'STATE_CONFLICT' ? '其他设备已修改，请核对后重试。' : '收藏未确认，请核对状态后重试。' })
    } finally { if (this._live(generation, ctx)) this.setData({ markerBusy: false }) }
  },
  onNext() {
    if (!this._check() || !this.data.submitted || !this._cursor) return
    if (this._targetQuestionId) { this._cursor = null; this.setData({ question: null, selected: [], finished: true }); return }
    return this._load(this._cursor.pageIndex, this._cursor.position + 1)
  }
})
