// pages/practice/practice.js
const app = getApp()
const bank = require('../../utils/questions.js')
const store = require('../../utils/store.js')
const analytics = require('../../utils/analytics.js')
const ai = require('../../utils/ai.js')
const user = require('../../utils/user.js')

const MODE_TITLES = {
  all: '顺序练习',
  random: '随机练习',
  weak: '薄弱突破',
  review: '到期复习',
  wrong: '错题重做',
  chapter: '知识点专练',
  single: '专项重练'
}

Page({
  data: {
    mode: 'all',
    modeTitle: '顺序练习',
    subjects: [],
    subject: '',
    chapter: '',
    queue: [],
    total: 0,
    idx: 0,
    question: null,
    selected: [],
    submitted: false,
    starred: false,
    canSubmit: false,
    typeTip: '',
    showExplain: true,
    showAi: false,
    aiExplain: null,
    errorIds: [],
    sessionCorrect: 0,
    sessionTotal: 0,
    finished: false,
    summary: null,
    emptyTip: ''
  },

  onLoad(options) {
    this.setData({ subjects: bank.getSubjects() })
    this._init({
      mode: (options && options.mode) || 'all',
      subject: options && options.subject ? decodeURIComponent(options.subject) : '',
      chapter: options && options.chapter ? decodeURIComponent(options.chapter) : '',
      ids: null
    })
  },

  onShow() {
    if (!user.requireLogin()) return
    // 先消费其他页面携带进来的参数（tabBar 页不支持 URL 传参）。
    // 这些参数本身已带 subject / chapter，必须优先于「科目同步重建」——否则像
    // 「学情报告 -> 切到科目 B 的章节专练」这类带着 chapter 的入口，会被科目守卫
    // 以「整科顺序」重建并提前 return，从而把章节参数吞掉。
    const pending = app.globalData.practiceParams
    if (pending && pending.__stamp && pending.__stamp !== this._stamp) {
      this._stamp = pending.__stamp
      this._init(pending)
      return
    }
    // 其它页面（错题本 / 首页）切换了全局科目、且本页无显式待消费参数时，按新科目重出；
    // 章节可能跨科失效故降级为整科顺序练习
    if (this._params && this._params.subject !== store.getCurrentSubject()) {
      const mode = this._params.mode === 'chapter' ? 'all' : this._params.mode
      this._init({ mode, chapter: '', ids: null })
    }
  },

  onUnload() {
    if (this._timer) clearTimeout(this._timer)
  },

  /* ---------------- 初始化 ---------------- */

  _init(params) {
    const mode = MODE_TITLES[params.mode] ? params.mode : 'all'
    // 从首页科目卡 / 学情章节专练进入时携带科目，先同步为全应用当前科目
    if (params.subject) store.setCurrentSubject(params.subject)
    // 科目是全应用统一口径，永远取全局当前值，保证「切到某科就只看该科」
    const subject = store.getCurrentSubject()
    const chapter = params.chapter || ''
    const ids = params.ids || null

    const snapshot = { mode, subject, chapter, ids }
    const prev = this._params
    if (prev && prev.mode === mode && prev.subject === subject && prev.chapter === chapter && prev.ids === ids && this.data.total) {
      return // 同一组参数重复进入时不重置进度
    }
    this._params = snapshot
    // 换一组题时清空本组作答快照
    this._snapshots = {}

    wx.setNavigationBarTitle({ title: MODE_TITLES[mode] })
    const queue = this._buildQueue(snapshot)
    if (!queue.length) {
      this.setData({
        mode,
        subject,
        chapter,
        modeTitle: MODE_TITLES[mode],
        queue: [],
        total: 0,
        question: null,
        finished: false,
        summary: null,
        emptyTip: this._emptyTip(mode)
      })
      return
    }
    this.setData({
      mode,
      subject,
      chapter,
      modeTitle: MODE_TITLES[mode],
      queue,
      total: queue.length,
      finished: false,
      summary: null,
      sessionCorrect: 0,
      sessionTotal: 0,
      errorIds: [],
      emptyTip: ''
    })
    this._load(0)
  },

  _emptyTip(mode) {
    if (mode === 'wrong') return '错题本是空的，继续保持！'
    if (mode === 'review') return '暂时没有到期的复习题，明天再来或去刷一组新题'
    if (mode === 'weak') return '还没有薄弱知识点，先做一组练习建立学情画像'
    if (mode === 'single') return '没有需要练习的题目'
    return '暂无符合条件的题目'
  },

  _buildQueue(params) {
    const { mode, chapter, ids } = params
    // 科目统一从全局读取；下述数据源在 store / analytics 层已按当前科目过滤，无需二次过滤
    const subject = store.getCurrentSubject()
    let list = []
    if (mode === 'single') {
      // 指定题目：来源已是当前科目（错题本 / 学情 / 举一反三），不按科目二次过滤
      list = bank.getQuestionsByIds(ids || [])
    } else if (mode === 'wrong') {
      list = store
        .getWrongRecords()
        .map((r) => bank.findQuestion(r.id))
        .filter(Boolean)
    } else if (mode === 'review') {
      list = bank.getQuestionsByIds(store.getDueIds(60))
    } else if (mode === 'weak') {
      list = bank.getQuestionsByIds(analytics.weakQuestionIds(60))
    } else if (mode === 'chapter') {
      list = bank.filterQuestions({ subject, chapter })
    } else {
      list = bank.filterQuestions({ subject })
      if (mode === 'random') list = bank.shuffle(list)
    }
    return list.slice(0, 60)
  },

  _load(idx) {
    const queue = this.data.queue
    if (!queue[idx]) return
    const question = queue[idx]
    const record = store.getRecord(question.id)
    // 本组已作答过的题：回看时还原上次作答与解析，且不允许重复提交
    const done = (this._snapshots || {})[question.id]
    let selected = []
    if (done) {
      selected = done.selected.slice()
    } else if (question.type === 'fill') {
      // 填空题按空位数预置空字符串，保证 selected 与 answer 等长
      selected = (question.answer || []).map(() => '')
    }
    this.setData({
      idx,
      question,
      selected,
      submitted: !!done,
      showExplain: done ? true : store.getSettings().aiExplain !== false,
      showAi: false,
      aiExplain: null,
      canSubmit: false,
      typeTip: bank.typeTip(question.type),
      starred: record ? !!record.starred : false
    })
    this._startAt = Date.now()
  },

  /* ---------------- 交互 ---------------- */

  /** 选项点击：单选互斥，多选/不定项可多选，排序按点击顺序入列 */
  onSelect(e) {
    if (this.data.submitted) return
    const key = e.detail.key
    const q = this.data.question
    if (!q) return
    let selected = this.data.selected.slice()
    if (q.type === 'sort') {
      const pos = selected.indexOf(key)
      if (pos > -1) selected.splice(pos, 1)
      else selected.push(key)
    } else if (bank.isMultiSelect(q.type)) {
      const pos = selected.indexOf(key)
      if (pos > -1) selected.splice(pos, 1)
      else selected.push(key)
      selected.sort()
    } else {
      selected = [key]
    }
    this.setData({ selected, canSubmit: this._canSubmit(q, selected) })
  },

  /** 填空输入 */
  onFill(e) {
    if (this.data.submitted) return
    const q = this.data.question
    const index = e.detail.index
    if (!q || isNaN(index)) return
    const selected = this.data.selected.slice()
    selected[index] = e.detail.value
    this.setData({ selected, canSubmit: this._canSubmit(q, selected) })
  },

  /** 排序调整：上移 / 下移 / 移除 / 清空 */
  onSort(e) {
    if (this.data.submitted) return
    const q = this.data.question
    if (!q) return
    const action = e.detail.action
    if (action === 'clear') {
      this.setData({ selected: [], canSubmit: false })
      return
    }
    const index = e.detail.index
    const selected = this.data.selected.slice()
    if (index < 0 || index >= selected.length) return
    if (action === 'remove') {
      selected.splice(index, 1)
    } else if (action === 'up' && index > 0) {
      const t = selected[index - 1]
      selected[index - 1] = selected[index]
      selected[index] = t
    } else if (action === 'down' && index < selected.length - 1) {
      const t = selected[index + 1]
      selected[index + 1] = selected[index]
      selected[index] = t
    }
    this.setData({ selected, canSubmit: this._canSubmit(q, selected) })
  },

  /** 是否满足提交条件：填空需填满、排序需排满、选择类至少选一项 */
  _canSubmit(q, selected) {
    const answer = q.answer || []
    if (q.type === 'fill') {
      return selected.length === answer.length && selected.every((v) => String(v || '').trim() !== '')
    }
    if (q.type === 'sort') {
      return selected.length === answer.length
    }
    return selected.length > 0
  },

  onStar() {
    const q = this.data.question
    if (!q) return
    store.ensureRecord(q)
    const starred = store.toggleStar(q.id)
    this.setData({ starred })
    wx.showToast({ title: starred ? '已收藏' : '已取消收藏', icon: 'none' })
  },

  onSubmit() {
    const q = this.data.question
    if (!q || this.data.submitted) return
    const selected = this.data.selected.slice()
    if (!this._canSubmit(q, selected)) {
      const tip =
        q.type === 'sort' ? '请完成全部排序' : q.type === 'fill' ? '请填写所有空位' : '请先选择答案'
      wx.showToast({ title: tip, icon: 'none' })
      return
    }
    // 判分统一走 bank.judge，与题目卡片展示保持一致
    const correct = bank.judge(q.type, selected, q.answer)
    const cost = Date.now() - (this._startAt || Date.now())

    store.recordAnswer(q, correct, cost)
    // 记录本组作答快照，回看该题时用于还原结果并阻止重复作答
    this._snapshots = this._snapshots || {}
    this._snapshots[q.id] = { selected: selected, correct: correct }

    const errorIds = this.data.errorIds.slice()
    if (!correct && errorIds.indexOf(q.id) === -1) errorIds.push(q.id)

    this.setData({
      submitted: true,
      showExplain: true,
      sessionTotal: this.data.sessionTotal + 1,
      sessionCorrect: this.data.sessionCorrect + (correct ? 1 : 0),
      errorIds
    })

    if (store.getSettings().autoNext && correct) {
      if (this._timer) clearTimeout(this._timer)
      const self = this
      this._timer = setTimeout(() => {
        if (self.data.submitted) self.onNext()
      }, 1200)
    }
  },

  onPrev() {
    if (this.data.idx > 0) this._load(this.data.idx - 1)
  },

  onNext() {
    if (this._timer) clearTimeout(this._timer)
    if (this.data.idx + 1 >= this.data.queue.length) {
      this._finish()
      return
    }
    this._load(this.data.idx + 1)
  },

  onToggleExplain() {
    this.setData({ showExplain: !this.data.showExplain })
  },

  onAiExplain() {
    const q = this.data.question
    if (!q) return
    this.setData({ showAi: true, aiExplain: ai.explainQuestion(q, this.data.selected) })
  },

  onCloseAi() {
    this.setData({ showAi: false })
  },

  /* wxml 里 AI 面板用 catchtap 阻断冒泡，无需处理事件，保留空实现供绑定 */
  onStop() {},

  /** 相似题加入队列 */
  onAddSimilar(e) {
    const id = e.currentTarget.dataset.id
    const target = bank.findQuestion(id)
    if (!target) return
    const queue = this.data.queue.slice()
    if (queue.some((q) => q.id === id)) {
      wx.showToast({ title: '已在练习队列中', icon: 'none' })
      return
    }
    queue.splice(this.data.idx + 1, 0, target)
    this.setData({ queue, total: queue.length, showAi: false })
    wx.showToast({ title: '已加入队列', icon: 'none' })
  },

  onSubjectChange(e) {
    const subject = e.currentTarget.dataset.subject || ''
    if (!subject) return // 已去掉「全部」，dataset 里只会是具体科目
    // 切换全应用当前科目；换科目后原章节约束失效，chapter 降级为整科顺序练习
    store.setCurrentSubject(subject)
    const mode = this.data.mode === 'single' || this.data.mode === 'chapter' ? 'all' : this.data.mode
    this._params = null
    this._init({ mode, chapter: '', ids: null })
  },

  _finish() {
    const { sessionTotal, sessionCorrect, errorIds } = this.data
    const rate = sessionTotal ? Math.round((sessionCorrect / sessionTotal) * 100) : 0
    const wrongList = errorIds
      .map((id) => bank.findQuestion(id))
      .filter(Boolean)
      .map((q) => ({ id: q.id, stem: q.stem, chapter: q.chapter }))
    let comment = '继续保持这个节奏。'
    if (rate >= 90) comment = '这一组非常稳，可以尝试提高难度或限时作答。'
    else if (rate >= 70) comment = '整体不错，错题建议立刻看 AI 讲解再复盘一遍。'
    else if (rate > 0) comment = '错误较多，建议先把错题重做一遍，再回到该模块刷 10 题。'
    this.setData({
      finished: true,
      summary: { total: sessionTotal, correct: sessionCorrect, rate, comment, wrongList }
    })
  },

  restart() {
    this._params = null
    const params = {
      mode: this.data.mode,
      subject: this.data.subject,
      chapter: this.data.chapter,
      ids: null
    }
    if (this.data.mode === 'single') params.mode = 'all'
    this._init(params)
  },

  gotoReview() {
    app.startPractice({ mode: 'review' })
  },

  gotoHome() {
    wx.switchTab({ url: '/pages/index/index' })
  }
})
