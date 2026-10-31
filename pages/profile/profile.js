// pages/profile/profile.js
const app = getApp()
const bank = require('../../utils/questions.js')
const store = require('../../utils/store.js')
const analytics = require('../../utils/analytics.js')
const user = require('../../utils/user.js')

const GOALS = [10, 20, 30, 50, 80]

Page({
  data: {
    user: {
      nickName: '',
      avatarUrl: '',
      exam: ''
    },
    logged: false,
    initial: '备',
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
    starred: 0,
    mastered: 0,
    studyDays: 0,
    studyTimeText: '0 分钟',
    goals: GOALS,
    goal: 30,
    goalPercent: 0,
    goalLeft: 30,
    autoNext: true,
    aiExplain: true,
    bankInfo: { total: 0, subjects: 0, chapters: 0 },
    levelText: 1,
    version: '1.0.0'
  },

  onShow() {
    user.requireLogin(() => this.refresh())
  },

  onPullDownRefresh() {
    user.requireLogin(() => this.refresh())
    wx.stopPullDownRefresh()
  },

  refresh() {
    const settings = store.getSettings()
    const overview = analytics.overview()
    const records = store.getRecords()
    const profile = user.getProfile()

    let starred = 0
    let mastered = 0
    Object.keys(records).forEach((id) => {
      const r = records[id]
      if (!r) return
      if (r.starred) starred += 1
      if (r.mastered) mastered += 1
    })

    const study = store.getStudySummary()
    const minutes = Math.round(study.timeMs / 60000)

    const all = bank.getAllQuestions()
    const goal = settings.dailyGoal || 30

    this.setData({
      overview,
      starred,
      mastered,
      logged: !!profile.logged,
      user: {
        nickName: profile.nickName || '',
        avatarUrl: profile.avatarUrl || '',
        exam: profile.exam || ''
      },
      initial: user.initial(profile.nickName),
      levelText: Math.min(9, Math.floor(overview.total / 100) + 1),
      studyDays: study.days,
      studyTimeText: minutes >= 60 ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分` : `${minutes} 分钟`,
      goal,
      goalPercent: Math.min(100, Math.round((overview.todayTotal / goal) * 100)),
      goalLeft: Math.max(0, goal - overview.todayTotal),
      autoNext: !!settings.autoNext,
      aiExplain: !!settings.aiExplain,
      bankInfo: {
        total: all.length,
        subjects: bank.getSubjects().length,
        chapters: bank.getChapters().length
      }
    })
  },

  /* ---------------- 设置 ---------------- */

  onGoalChange(e) {
    const goal = Number(e.currentTarget.dataset.goal) || 30
    store.saveSettings({ dailyGoal: goal })
    wx.showToast({ title: `每日目标 ${goal} 题`, icon: 'none' })
    this.refresh()
  },

  onAutoNext(e) {
    store.saveSettings({ autoNext: !!e.detail.value })
    this.setData({ autoNext: !!e.detail.value })
  },

  onAiExplain(e) {
    store.saveSettings({ aiExplain: !!e.detail.value })
    this.setData({ aiExplain: !!e.detail.value })
  },

  /* ---------------- 数据管理 ---------------- */

  onClearData() {
    const self = this
    wx.showModal({
      title: '清空学习数据',
      content: '答题记录、错题本、学情数据将被全部删除且无法恢复',
      confirmText: '确认清空',
      confirmColor: '#e5484d',
      success(res) {
        if (!res.confirm) return
        store.clearAll()
        wx.showToast({ title: '已清空', icon: 'none' })
        self.refresh()
      }
    })
  },

  onAbout() {
    wx.showModal({
      title: '关于',
      content: '备考刷题助手 v1.0.0\n云端题库与 AI 助教，学习数据已同步到云端，换设备不丢失。',
      showCancel: false,
      confirmText: '知道了'
    })
  },

  /* 法律与协议 */

  goAgreement(e) {
    const type = e.currentTarget.dataset.type || 'user'
    wx.navigateTo({ url: `/pages/agreement/agreement?type=${type}` })
  },

  /* ---------------- 账号 ---------------- */

  goLogin() {
    wx.navigateTo({ url: '/pages/login/login' })
  },

  goEdit() {
    wx.navigateTo({ url: '/pages/login/login?mode=edit' })
  },

  onLogout() {
    wx.showModal({
      title: '退出登录',
      content: '退出后需要重新微信授权登录（学习数据已保存在云端）',
      confirmText: '退出',
      confirmColor: '#e5484d',
      success(res) {
        if (!res.confirm) return
        user.logout().then(() => {
          app.setLogged(false)
          wx.reLaunch({ url: '/pages/login/login' })
        })
      }
    })
  },

  /* ---------------- 跳转 ---------------- */

  goAnalysis() {
    wx.navigateTo({ url: '/pages/analysis/analysis' })
  },

  goMistakes() {
    wx.switchTab({ url: '/pages/mistakes/mistakes' })
  },

  goAi() {
    wx.switchTab({ url: '/pages/ai/ai' })
  },

  goPractice() {
    app.startPractice({ mode: 'random' })
  }
})
