// pages/index/index.js
const app = getApp()
const bank = require('../../utils/questions.js')
const store = require('../../utils/store.js')
const analytics = require('../../utils/analytics.js')
const ai = require('../../utils/ai.js')
const user = require('../../utils/user.js')

Page({
  data: {
    greeting: '你好',
    overview: {
      total: 0,
      correct: 0,
      rate: 0,
      todayTotal: 0,
      todayCorrect: 0,
      todayRate: 0,
      wrongCount: 0,
      stubbornCount: 0,
      dueCount: 0,
      streakDays: 0,
      chapterCount: 0
    },
    goal: 30,
    goalPercent: 0,
    goalLeft: 30,
    advice: [],
    subjects: [],
    weakPreview: [],
    dateText: '',
    userName: ''
  },

  onLoad() {
    this.setData({
      goal: store.getSettings().dailyGoal,
      dateText: this._buildDateText()
    })
  },

  onShow() {
    this.refresh()
    this._checkLogin()
  },

  /** 强制登录：会话校验未通过时跳转登录页 */
  _checkLogin() {
    if (app.globalData.logged) return
    if (this._loginPushed) return
    this._loginPushed = true
    app.whenSessionReady((logged) => {
      this._loginPushed = false
      if (logged) {
        this.refresh()
        return
      }
      wx.navigateTo({ url: '/pages/login/login' })
    })
  },

  onPullDownRefresh() {
    this.refresh()
    wx.stopPullDownRefresh()
  },

  refresh() {
    const hour = new Date().getHours()
    let greeting = '你好'
    if (hour < 6) greeting = '夜深了'
    else if (hour < 11) greeting = '早上好'
    else if (hour < 14) greeting = '中午好'
    else if (hour < 18) greeting = '下午好'
    else greeting = '晚上好'

    const overview = analytics.overview()
    const goal = store.getSettings().dailyGoal
    const goalPercent = Math.min(100, Math.round((overview.todayTotal / goal) * 100))

    this.setData({
      greeting,
      overview,
      goal,
      goalPercent,
      goalLeft: Math.max(0, goal - overview.todayTotal),
      advice: ai.studyAdvice(),
      subjects: this._buildSubjects(),
      weakPreview: analytics.weakPoints(3),
      userName: user.isLogged() ? user.displayName() : ''
    })
  },

  _buildDateText() {
    const d = new Date()
    const weeks = ['日', '一', '二', '三', '四', '五', '六']
    return `${d.getMonth() + 1}月${d.getDate()}日 星期${weeks[d.getDay()]}`
  },

  _buildSubjects() {
    const records = store.getRecords()
    return bank.getSubjects().map((s) => {
      let attempted = 0
      let correct = 0
      Object.keys(records).forEach((id) => {
        const r = records[id]
        if (r && r.subject === s.name) {
          attempted += r.attempts || 0
          correct += r.right || 0
        }
      })
      const percent = s.count ? Math.min(100, Math.round((attempted / s.count) * 100)) : 0
      return Object.assign({}, s, {
        attempted,
        correct,
        percent,
        rate: attempted ? Math.round((correct / attempted) * 100) : 0
      })
    })
  },

  /* ---------------- 事件 ---------------- */

  // 练习页属于 tabBar 页面，无法 navigateTo，统一走 app.startPractice
  goPractice(e) {
    app.startPractice({
      mode: e.currentTarget.dataset.mode || 'all',
      subject: e.currentTarget.dataset.subject || ''
    })
  },

  goWeak() {
    app.startPractice({ mode: 'weak' })
  },

  goReview() {
    app.startPractice({ mode: 'review' })
  },

  goAi(e) {
    const text = e.currentTarget.dataset.text || ''
    wx.switchTab({
      url: '/pages/ai/ai',
      success() {
        if (text) {
          const app = getApp()
          app.globalData.aiPreInput = text
        }
      }
    })
  },

  goAnalysis() {
    wx.navigateTo({ url: '/pages/analysis/analysis' })
  },

  goMistakes() {
    wx.switchTab({ url: '/pages/mistakes/mistakes' })
  }
})
