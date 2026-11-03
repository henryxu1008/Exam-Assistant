const config = require('../../utils/config.js')
const user = require('../../utils/user.js')
const store = require('../../utils/store.js')
const { canonical } = require('../../shared/question-domain.js')
const { judge, validSelection } = require('../../shared/grading-domain.js')
const { runtimeProtectedPracticeClient } = require('../../utils/protected-practice-client.js')
const { runtimeProtectedStudySession } = require('../../utils/protected-study-session.js')
const errors = { ENTITLEMENT_REQUIRED: '该考试尚无有效权限，或权限已到期。', STALE_RELEASE: '题库已更新，请重新开始练习。',
  INVALID_TOKEN: '登录已失效，请重新登录。', STALE_CONTEXT: '账号已切换，请重新开始。',
  PROTECTED_READ_DISABLED: '受保护题库尚未开放，请在隔离环境联调。', NETWORK_ERROR: '网络不可用，请联网后重试。' }
const blank = () => ({ available: config.protectedPracticePreview === true, busy: false, question: null, selected: [], submitted: false,
  correct: false, finished: false, error: '', answered: 0, correctCount: 0, examName: '',
  recordsPreview: config.protectedRecordsPreview === true, historyCount: 0, historyCorrect: 0 })
Page({
  data: blank(),
  onLoad() { this._client = runtimeProtectedPracticeClient(); this._recorder = runtimeProtectedStudySession(); this._generation = 0 },
  onShow() {
    this._active = true; const generation = ++this._generation
    this._ctx = null; this._syncCtx = null; this._operation = null; this._baseline = null; this._cursor = null; this.setData(blank())
    if (config.protectedPracticePreview !== true) return
    user.whenReady(() => { if (this._active && generation === this._generation) this.restart() })
  },
  onHide() { this._active = false; this._generation++; this._ctx = null; this._syncCtx = null; this._operation = null; this._baseline = null; this._cursor = null; this.setData(blank()) },
  onUnload() { this.onHide() },
  _live(generation, ctx) {
    try { return this._active && generation === this._generation && this._ctx === ctx && this._client.current(ctx) && store.getCurrentExam() === this._examId &&
      (config.protectedRecordsPreview !== true || this._recorder.current(this._syncCtx)) }
    catch (e) { return false }
  },
  _clear(message) { this._baseline = null; this._cursor = null; this.setData({ busy: false, question: null, selected: [], submitted: false, finished: false, error: message }) },
  _check() {
    try { if (this._active && this._ctx && this._client.current(this._ctx) && store.getCurrentExam() === this._examId &&
      (config.protectedRecordsPreview !== true || this._recorder.current(this._syncCtx))) return true } catch (e) { /* fail closed on unreadable account or exam */ }
    this._clear(errors.STALE_CONTEXT); return false
  },
  async restart() {
    if (!this._active || config.protectedPracticePreview !== true || this.data.busy) return
    try { this._ctx = this._client.capture(); this._examId = store.getCurrentExam(); this._syncCtx = config.protectedRecordsPreview === true ? this._recorder.capture() : null } catch (e) { this._clear('请先登录并完成学习数据同步或清空操作。'); return }
    if (!this._examId) { this._clear('请先在首页选择考试。'); return }
    this._generation++; this._baseline = null; this._cursor = null; this._operation = null
    const generation = this._generation, ctx = this._ctx
    this.setData({ ...blank(), busy: false })
    if (config.protectedRecordsPreview === true) {
      this.setData({ busy: true })
      try {
        const history = await this._recorder.prepare(this._examId, this._syncCtx)
        if (!this._live(generation, ctx)) { if (this._active && generation === this._generation) this._clear(errors.STALE_CONTEXT); return }
        this.setData({ busy: false, historyCount: history.snapshotSequence, historyCorrect: history.correct })
      } catch (e) { if (this._active && generation === this._generation) this._clear('学习记录同步失败，请联网后重试。'); return }
    }
    return this._load(0, 0)
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
        if (offset < result.page.questions.length) {
          const question = result.page.questions[offset]
          this._operation = null
          this._startedAt = Date.now()
          this._cursor = { pageIndex: current, position: offset }
          this.setData({ question, examName: result.scope.exam.name, selected: question.type === 'fill' ? question.answer.map(() => '') : [], busy: false })
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
      if (config.protectedRecordsPreview === true) {
        if (!this._operation) this._operation = { dataEpoch: this._syncCtx.dataEpoch,
          operationId: 'ps_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2),
          examId: this._examId, releaseId: this._baseline.releaseId, publicationRevision: this._baseline.publicationRevision,
          questionId: question.id, questionVersionId: question.versionId, selected, costMs: Math.min(86400000, Math.max(0, Date.now() - (this._startedAt || Date.now()))) }
        const receipt = await this._recorder.submit(this._syncCtx, this._operation)
        if (!this._live(generation, ctx)) { if (this._active && generation === this._generation) this._clear(errors.STALE_CONTEXT); return }
        const correct = receipt.attempt.score === 1
        this.setData({ busy: false, question, selected, submitted: true, correct, answered: this.data.answered + 1,
          correctCount: this.data.correctCount + (correct ? 1 : 0) })
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
      if (config.protectedRecordsPreview === true && this._operation) this._clear((errors[e.code] ? errors[e.code] + ' ' : '') + '提交尚未确认，请重新开始并核对学习记录。')
      else this._clear(errors[e.code] || '权益校验失败，请联网后重试。')
    }
  },
  onNext() { if (this._check() && this.data.submitted && this._cursor) return this._load(this._cursor.pageIndex, this._cursor.position + 1) }
})
