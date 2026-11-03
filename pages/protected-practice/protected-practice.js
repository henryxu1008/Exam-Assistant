const config = require('../../utils/config.js')
const user = require('../../utils/user.js')
const store = require('../../utils/store.js')
const { canonical } = require('../../shared/question-domain.js')
const { judge, validSelection } = require('../../shared/grading-domain.js')
const { runtimeProtectedPracticeClient } = require('../../utils/protected-practice-client.js')
const errors = { ENTITLEMENT_REQUIRED: '该考试尚无有效权限，或权限已到期。', STALE_RELEASE: '题库已更新，请重新开始练习。',
  INVALID_TOKEN: '登录已失效，请重新登录。', STALE_CONTEXT: '账号已切换，请重新开始。',
  PROTECTED_READ_DISABLED: '受保护题库尚未开放，请在隔离环境联调。', NETWORK_ERROR: '网络不可用，请联网后重试。' }
const blank = () => ({ available: config.protectedPracticePreview === true, busy: false, question: null, selected: [], submitted: false,
  correct: false, finished: false, error: '', answered: 0, correctCount: 0, examName: '' })
Page({
  data: blank(),
  onLoad() { this._client = runtimeProtectedPracticeClient(); this._generation = 0 },
  onShow() {
    this._active = true; const generation = ++this._generation
    this._ctx = null; this._baseline = null; this._cursor = null; this.setData(blank())
    if (config.protectedPracticePreview !== true) return
    user.whenReady(() => { if (this._active && generation === this._generation) this.restart() })
  },
  onHide() { this._active = false; this._generation++; this._ctx = null; this._baseline = null; this._cursor = null; this.setData(blank()) },
  onUnload() { this.onHide() },
  _live(generation, ctx) {
    try { return this._active && generation === this._generation && this._ctx === ctx && this._client.current(ctx) && store.getCurrentExam() === this._examId }
    catch (e) { return false }
  },
  _clear(message) { this._baseline = null; this._cursor = null; this.setData({ busy: false, question: null, selected: [], submitted: false, finished: false, error: message }) },
  _check() {
    try { if (this._active && this._ctx && this._client.current(this._ctx) && store.getCurrentExam() === this._examId) return true } catch (e) { /* fail closed on unreadable account or exam */ }
    this._clear(errors.STALE_CONTEXT); return false
  },
  restart() {
    if (!this._active || config.protectedPracticePreview !== true || this.data.busy) return
    try { this._ctx = this._client.capture(); this._examId = store.getCurrentExam() } catch (e) { this._clear('请先登录并选择考试。'); return }
    if (!this._examId) { this._clear('请先在首页选择考试。'); return }
    this._generation++; this._baseline = null; this._cursor = null
    this.setData({ ...blank(), busy: false }); return this._load(0, 0)
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
      const fresh = await this._client.page(this._examId, cursor.pageIndex, this._baseline, ctx)
      if (!this._live(generation, ctx)) { if (this._active && generation === this._generation) this._clear(errors.STALE_CONTEXT); return }
      if (canonical(fresh.page.questions[cursor.position]) !== canonical(question)) { this._clear(errors.STALE_RELEASE); return }
      const correct = judge(question.type, selected, question.answer)
      this.setData({ busy: false, question, selected, submitted: true, correct, answered: this.data.answered + 1, correctCount: this.data.correctCount + (correct ? 1 : 0) })
    } catch (e) { if (this._active && generation === this._generation) this._clear(errors[e.code] || '权益校验失败，请联网后重试。') }
  },
  onNext() { if (this._check() && this.data.submitted && this._cursor) return this._load(this._cursor.pageIndex, this._cursor.position + 1) }
})
