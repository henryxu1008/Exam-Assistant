// pages/mistakes/mistakes.js
const app = getApp()
const bank = require('../../utils/questions.js')
const store = require('../../utils/store.js')
const user = require('../../utils/user.js')
const config = require('../../utils/config.js')
const { runtimeProtectedReportLoader } = require('../../utils/protected-report-loader.js')
const { runtimeProtectedPracticeClient } = require('../../utils/protected-practice-client.js')

const TABS = [
  { key: 'all', label: '全部' },
  { key: 'stubborn', label: '顽固' },
  { key: 'due', label: '待复习' },
  { key: 'starred', label: '收藏' }
]

const LEVEL_TEXT = ['未掌握', '生疏', '一般', '较好', '牢固', '已掌握']

const EMPTY_TIPS = {
  all: '错题本是空的，继续保持这个状态',
  stubborn: '还没有错 2 次以上的题目，很稳',
  due: '暂时没有到期的复习题，明天再来',
  starred: '还没有收藏的题目，遇到好题记得收藏'
}

Page({
  data: {
    tabs: TABS,
    tab: 'all',
    subjects: [],
    subject: '',
    list: [],
    total: 0,
    counts: { all: 0, stubborn: 0, due: 0, starred: 0 },
    emptyTip: '', protectedMode: config.protectedCatalog === true, protectedEnabled: (config.protectedRecordsPreview === true || config.protectedCatalog === true), protectedPracticeEnabled: (config.protectedPracticePreview === true || config.protectedCatalog === true),
    protectedBusy: false, protectedLoaded: false, protectedError: '', protectedWrongCount: 0,
    protectedWrongs: [], protectedHasMore: false, protectedQuestion: null, protectedQuestionError: '', protectedQuestionBusy: false
  },

  onLoad() {
    this.setData({ subjects: bank.getSubjects() })
    if ((config.protectedRecordsPreview === true || config.protectedCatalog === true)) { this._protectedLoader = runtimeProtectedReportLoader(); this._protectedReader = runtimeProtectedPracticeClient() }
  },

  onShow() {
    if ((config.protectedRecordsPreview === true || config.protectedCatalog === true) && !this._protectedLoader) { this._protectedLoader = runtimeProtectedReportLoader(); this._protectedReader = runtimeProtectedPracticeClient() }
    this.setData({ protectedMode: config.protectedCatalog === true, protectedEnabled: (config.protectedRecordsPreview === true || config.protectedCatalog === true),
      protectedPracticeEnabled: (config.protectedPracticePreview === true || config.protectedCatalog === true) })
    this._visible = true; const generation = this._protectedGeneration = (this._protectedGeneration || 0) + 1
    user.whenReady(() => { if (this._visible && generation === this._protectedGeneration) { this.refresh(); this.refreshProtected() } })
  },

  onHide() {
    this._visible = false; this._protectedGeneration = (this._protectedGeneration || 0) + 1; this._questionGeneration = (this._questionGeneration || 0) + 1
    this._protectedContext = null; this._protectedRows = []; this.setData({ protectedBusy: false, protectedLoaded: false, protectedError: '', protectedWrongCount: 0,
      protectedWrongs: [], protectedHasMore: false, protectedQuestion: null, protectedQuestionError: '', protectedQuestionBusy: false })
  },
  onUnload() { this.onHide() },

  onPullDownRefresh() {
    user.whenReady(() => { this.refresh(); this.refreshProtected() })
    wx.stopPullDownRefresh()
  },

  /* ---------------- 数据 ---------------- */

  refresh() {
    if (config.protectedCatalog === true) {
      this.setData({ list: [], total: 0, counts: { all: 0, stubborn: 0, due: 0, starred: 0 }, subjects: [], subject: '', emptyTip: '' })
      return
    }
    const now = Date.now()
    const subject = store.getCurrentSubject()
    const records = store.getRecords()
    const pool = []
    Object.keys(records).forEach((id) => {
      const r = records[id]
      if (!r || r.mastered) return
      if (r.wrong > 0 || r.starred) pool.push(r)
    })

    const inSubject = (r) => r.subject === subject
    // 待复习口径统一走 store.getDueRecords()，保证与刷题「到期复习」模式筛选一致
    const dueSet = new Set(store.getDueRecords().map((r) => r.id))
    const counts = {
      all: pool.filter((r) => r.wrong > 0 && inSubject(r)).length,
      stubborn: pool.filter((r) => r.wrong >= 2 && inSubject(r)).length,
      due: pool.filter((r) => dueSet.has(r.id) && inSubject(r)).length,
      starred: pool.filter((r) => r.starred && inSubject(r)).length
    }

    this._render(pool, dueSet)
    this.setData({
      subject,
      subjects: bank.getSubjects(store.getCurrentExam()),
      counts,
      tabs: TABS.map((t) => ({ key: t.key, label: t.label, count: counts[t.key] }))
    })
  },

  async refreshProtected() {
    if ((config.protectedRecordsPreview !== true && config.protectedCatalog !== true) || !this._visible || !this._protectedLoader) return
    const generation = this._protectedGeneration = (this._protectedGeneration || 0) + 1
    this._questionGeneration = (this._questionGeneration || 0) + 1
    this._protectedContext = null; this._protectedRows = []
    this.setData({ protectedBusy: true, protectedLoaded: false, protectedError: '', protectedWrongCount: 0, protectedWrongs: [], protectedHasMore: false,
      protectedQuestion: null, protectedQuestionError: '', protectedQuestionBusy: false })
    try {
      const ctx = this._protectedLoader.capture(), report = await this._protectedLoader.load(ctx)
      if (!this._visible || generation !== this._protectedGeneration) return
      if (!this._protectedLoader.current(ctx)) { this._invalidateProtected(); return }
      this._protectedContext = ctx
      this._protectedRows = report.wrongs.map((item, index) => ({ ...item, label: `错题 ${index + 1}` }))
      this._protectedLimit = 20; this._renderProtected()
      this.setData({ protectedBusy: false, protectedLoaded: true, protectedWrongCount: report.wrongs.length })
    } catch (e) {
      if (this._visible && generation === this._protectedGeneration) this.setData({ protectedBusy: false, protectedLoaded: false,
        protectedError: e.code === 'NO_TOKEN' ? '登录后可查看受保护错题记录。' : e.code === 'STALE_CONTEXT' ? '账号或考试已切换，请重新载入。' : '受保护学习记录读取失败，请联网后重试。' })
    }
  },
  _invalidateProtected() {
    this._protectedContext = null; this._protectedRows = []
    this.setData({ protectedBusy: false, protectedLoaded: false, protectedError: '账号或考试已切换，请重新载入。', protectedWrongCount: 0,
      protectedWrongs: [], protectedHasMore: false, protectedQuestion: null, protectedQuestionError: '', protectedQuestionBusy: false })
  },
  _renderProtected() { this.setData({ protectedWrongs: this._protectedRows.slice(0, this._protectedLimit), protectedHasMore: this._protectedRows.length > this._protectedLimit }) },
  showMoreProtected() { if (!this._protectedContext || !this._protectedLoader.current(this._protectedContext)) { this.refreshProtected(); return }; this._protectedLimit += 20; this._renderProtected() },
  async showProtectedQuestion(e) {
    const ctx = this._protectedContext, row = (this._protectedRows || []).find(item => item.key === e.currentTarget.dataset.key)
    if (!row || !ctx || !this._protectedLoader.current(ctx) || !this._visible) { this.refreshProtected(); return }
    const generation = this._protectedGeneration, request = this._questionGeneration = (this._questionGeneration || 0) + 1
    this.setData({ protectedQuestion: null, protectedQuestionError: '', protectedQuestionBusy: true })
    try {
      const result = await this._protectedReader.question(ctx.examId, row.questionId, ctx.context.identity)
      if (!this._visible || generation !== this._protectedGeneration || request !== this._questionGeneration) return
      if (!this._protectedLoader.current(ctx)) { this._invalidateProtected(); return }
      this.setData({ protectedQuestion: { ...result.question, answerText: typeof bank.answerPlain === 'function' ? bank.answerPlain(result.question) : '',
        updated: result.question.versionId !== row.lastWrongVersion }, protectedQuestionBusy: false })
    } catch (err) {
      if (!this._visible || generation !== this._protectedGeneration || request !== this._questionGeneration) return
      if (!this._protectedLoader.current(ctx)) { this._invalidateProtected(); return }
      const message = err.code === 'ENTITLEMENT_REQUIRED' ? '当前没有有效权限，错题记录仍保留；续费后可查看题目。' :
        err.code === 'QUESTION_UNAVAILABLE' ? '该题已不在当前题库，错题记录仍保留。' : '题目读取失败，请联网后重试。'
      this.setData({ protectedQuestion: null, protectedQuestionBusy: false, protectedQuestionError: message })
    }
  },
  closeProtectedQuestion() { this._questionGeneration = (this._questionGeneration || 0) + 1; this.setData({ protectedQuestion: null, protectedQuestionError: '', protectedQuestionBusy: false }) },
  redoProtected(e) {
    const ctx = this._protectedContext, row = (this._protectedRows || []).find(item => item.key === e.currentTarget.dataset.key)
    if (!row || !ctx || (config.protectedPracticePreview !== true && config.protectedCatalog !== true)) return
    if (!this._protectedLoader.current(ctx)) { this._invalidateProtected(); return }
    wx.navigateTo({ url: '/pages/protected-practice/protected-practice?questionId=' + encodeURIComponent(row.questionId) })
  },

  _render(pool, dueSet) {
    const now = Date.now()
    const { tab } = this.data
    const subject = store.getCurrentSubject()

    let list = pool.filter((r) => {
      if (tab === 'stubborn') return r.wrong >= 2
      if (tab === 'due') return dueSet.has(r.id)
      if (tab === 'starred') return !!r.starred
      return r.wrong > 0
    })
    list = list.filter((r) => r.subject === subject)

    const items = []
    list.forEach((r) => {
      const q = bank.findQuestion(r.id)
      if (!q) return
      items.push({
        id: r.id,
        stem: q.stem,
        subject: r.subject || q.subject,
        subjectLabel: typeof bank.getSubjectLabel === 'function' ? bank.getSubjectLabel(r.subject || q.subject) : (r.subject || q.subject),
        chapter: r.chapter || q.chapter,
        chapterLabel: typeof bank.getChapterLabel === 'function' ? bank.getChapterLabel(r.subject || q.subject, r.chapter || q.chapter) : (r.chapter || q.chapter),
        typeName: bank.typeName(q.type),
        answerText: bank.answerPlain(q),
        wrong: r.wrong,
        right: r.right,
        attempts: r.attempts,
        starred: !!r.starred,
        levelText: LEVEL_TEXT[r.level] || LEVEL_TEXT[0],
        due: (r.nextReviewAt || 0) <= now,
        lastText: this._lastText(r.lastWrongAt),
        lastWrongAt: r.lastWrongAt || 0
      })
    })

    items.sort((a, b) => {
      if (b.wrong !== a.wrong) return b.wrong - a.wrong
      return b.lastWrongAt - a.lastWrongAt
    })

    this.setData({
      list: items,
      total: items.length,
      emptyTip: items.length ? '' : EMPTY_TIPS[tab] || '暂无题目'
    })
  },

  _lastText(ts) {
    if (!ts) return '暂无错题时间'
    const days = Math.floor((Date.now() - ts) / 86400000)
    if (days <= 0) return '今天错过'
    if (days === 1) return '昨天错过'
    return `${days} 天前错过`
  },

  /* ---------------- 事件 ---------------- */

  onTab(e) {
    const tab = e.currentTarget.dataset.key
    if (tab === this.data.tab) return
    this.setData({ tab }, () => this.refresh())
  },

  onSubjectChange(e) {
    if (config.protectedCatalog === true) return
    const subject = e.currentTarget.dataset.subject || ''
    if (!subject) return // 已去掉「全部」
    store.setCurrentSubject(subject)
    this.refresh()
    this.refreshProtected()
  },

  onStar(e) {
    if (config.protectedCatalog === true) return
    const id = e.currentTarget.dataset.id
    const starred = store.toggleStar(id)
    wx.showToast({ title: starred ? '已收藏' : '已取消收藏', icon: 'none' })
    this.refresh()
  },

  /** 标记为已掌握，移出错题本 */
  onMaster(e) {
    if (config.protectedCatalog === true) return
    const id = e.currentTarget.dataset.id
    const self = this
    wx.showModal({
      title: '标记为已掌握？',
      content: '该题将从错题本移除，并进入长期复习队列',
      confirmText: '已掌握',
      success(res) {
        if (!res.confirm || config.protectedCatalog === true) return
        store.resetWrong(id)
        wx.showToast({ title: '已移出错题本', icon: 'none' })
        self.refresh()
      }
    })
  },

  /** 单题重练 */
  onRedo(e) {
    if (config.protectedCatalog === true) return
    app.startPractice({ mode: 'single', ids: [e.currentTarget.dataset.id] })
  },

  /** 交给 AI 助教讲解 */
  onAi(e) {
    if (config.protectedCatalog === true) return
    const id = e.currentTarget.dataset.id
    const q = bank.findQuestion(id)
    if (!q) return
    app.globalData.aiPreInput = '这道题怎么解？'
    app.globalData.aiContext = { questionId: q.id, questionSnapshot: q, userAnswer: [] }
    wx.switchTab({ url: '/pages/ai/ai' })
  },

  /** 全部错题重练 */
  redoAll() {
    if (config.protectedCatalog === true) return
    if (!this.data.counts.all) {
      wx.showToast({ title: '错题本是空的', icon: 'none' })
      return
    }
    app.startPractice({ mode: 'wrong' })
  },

  /** 只练顽固错题 */
  redoStubborn() {
    if (config.protectedCatalog === true) return
    const ids = this._ids((r) => r.wrong >= 2)
    if (!ids.length) {
      wx.showToast({ title: '暂无顽固错题', icon: 'none' })
      return
    }
    app.startPractice({ mode: 'single', ids })
  },

  /** 只练到期复习——与「待复习」列表共用同一选择器 getDueRecords()，避免列表有题却提示无题 */
  redoDue() {
    if (config.protectedCatalog === true) return
    const subject = store.getCurrentSubject()
    const ids = store
      .getDueRecords()
      .filter((r) => r.subject === subject)
      .map((r) => r.id)
    if (!ids.length) {
      wx.showToast({ title: '暂无待复习题目', icon: 'none' })
      return
    }
    app.startPractice({ mode: 'single', ids })
  },

  _ids(predicate) {
    const records = store.getRecords()
    const now = Date.now()
    const subject = store.getCurrentSubject()
    return Object.keys(records)
      .filter((id) => {
        const r = records[id]
        return r && !r.mastered && r.subject === subject && r.wrong > 0 && predicate(r, now)
      })
      .sort((a, b) => records[b].wrong - records[a].wrong)
      .slice(0, 60)
  },

  goPractice() {
    if (config.protectedCatalog === true) return
    app.startPractice({ mode: 'random' })
  }
})
