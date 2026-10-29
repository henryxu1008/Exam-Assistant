// pages/mistakes/mistakes.js
const app = getApp()
const bank = require('../../utils/questions.js')
const store = require('../../utils/store.js')

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
    emptyTip: ''
  },

  onLoad() {
    this.setData({ subjects: bank.getSubjects() })
  },

  onShow() {
    this.refresh()
  },

  onPullDownRefresh() {
    this.refresh()
    wx.stopPullDownRefresh()
  },

  /* ---------------- 数据 ---------------- */

  refresh() {
    const now = Date.now()
    const records = store.getRecords()
    const pool = []
    Object.keys(records).forEach((id) => {
      const r = records[id]
      if (!r || r.mastered) return
      if (r.wrong > 0 || r.starred) pool.push(r)
    })

    const counts = {
      all: pool.filter((r) => r.wrong > 0).length,
      stubborn: pool.filter((r) => r.wrong >= 2).length,
      due: pool.filter((r) => (r.nextReviewAt || 0) <= now).length,
      starred: pool.filter((r) => r.starred).length
    }

    this._render(pool)
    this.setData({
      counts,
      tabs: TABS.map((t) => ({ key: t.key, label: t.label, count: counts[t.key] }))
    })
  },

  _render(pool) {
    const now = Date.now()
    const { tab, subject } = this.data

    let list = pool.filter((r) => {
      if (tab === 'stubborn') return r.wrong >= 2
      if (tab === 'due') return (r.nextReviewAt || 0) <= now
      if (tab === 'starred') return !!r.starred
      return r.wrong > 0
    })
    if (subject) list = list.filter((r) => r.subject === subject)

    const items = []
    list.forEach((r) => {
      const q = bank.findQuestion(r.id)
      if (!q) return
      items.push({
        id: r.id,
        stem: q.stem,
        subject: r.subject || q.subject,
        chapter: r.chapter || q.chapter,
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
    const subject = e.currentTarget.dataset.subject || ''
    this.setData({ subject }, () => this.refresh())
  },

  onStar(e) {
    const id = e.currentTarget.dataset.id
    const starred = store.toggleStar(id)
    wx.showToast({ title: starred ? '已收藏' : '已取消收藏', icon: 'none' })
    this.refresh()
  },

  /** 标记为已掌握，移出错题本 */
  onMaster(e) {
    const id = e.currentTarget.dataset.id
    const self = this
    wx.showModal({
      title: '标记为已掌握？',
      content: '该题将从错题本移除，并进入长期复习队列',
      confirmText: '已掌握',
      success(res) {
        if (!res.confirm) return
        store.resetWrong(id)
        wx.showToast({ title: '已移出错题本', icon: 'none' })
        self.refresh()
      }
    })
  },

  /** 单题重练 */
  onRedo(e) {
    app.startPractice({ mode: 'single', ids: [e.currentTarget.dataset.id] })
  },

  /** 交给 AI 助教讲解 */
  onAi(e) {
    const id = e.currentTarget.dataset.id
    const q = bank.findQuestion(id)
    if (!q) return
    app.globalData.aiPreInput = '这道题怎么解？'
    app.globalData.aiContext = { questionId: q.id, userAnswer: [] }
    wx.switchTab({ url: '/pages/ai/ai' })
  },

  /** 全部错题重练 */
  redoAll() {
    if (!this.data.counts.all) {
      wx.showToast({ title: '错题本是空的', icon: 'none' })
      return
    }
    app.startPractice({ mode: 'wrong' })
  },

  /** 只练顽固错题 */
  redoStubborn() {
    const ids = this._ids((r) => r.wrong >= 2)
    if (!ids.length) {
      wx.showToast({ title: '暂无顽固错题', icon: 'none' })
      return
    }
    app.startPractice({ mode: 'single', ids })
  },

  /** 只练到期复习 */
  redoDue() {
    const ids = this._ids((r) => (r.nextReviewAt || 0) <= Date.now())
    if (!ids.length) {
      wx.showToast({ title: '暂无待复习题目', icon: 'none' })
      return
    }
    app.startPractice({ mode: 'single', ids })
  },

  _ids(predicate) {
    const records = store.getRecords()
    const now = Date.now()
    return Object.keys(records)
      .filter((id) => {
        const r = records[id]
        return r && !r.mastered && r.wrong > 0 && predicate(r, now)
      })
      .sort((a, b) => records[b].wrong - records[a].wrong)
      .slice(0, 60)
  },

  goPractice() {
    app.startPractice({ mode: 'random' })
  }
})
