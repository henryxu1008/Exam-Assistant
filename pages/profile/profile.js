// pages/profile/profile.js
const app = getApp()
const bank = require('../../utils/questions.js')
const store = require('../../utils/store.js')
const analytics = require('../../utils/analytics.js')
const user = require('../../utils/user.js')
const config = require('../../utils/config.js')
const { runtimeClient } = require('../../utils/catalog-admin.js')
const { storageStatusView, isStorageReadable } = require('../../utils/storage-status.js')

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
    version: config.version,
    localStorage: storageStatusView(),
    storageReadable: true,
    catalogAccess: false
  },

  onLoad() {
    this._unsubscribeSync = store.onSyncRestored(() => {
      if (this._visible) user.whenReady(() => { if (this._visible) this.refresh() })
    })
    this._unsubscribeStorage = store.onLocalStorageChange(status => {
      if (this._visible) this.setData({ localStorage: storageStatusView(status), storageReadable: isStorageReadable(status) })
    })
  },

  onHide() { this._visible = false; this._catalogGeneration = (this._catalogGeneration || 0) + 1; this.setData({ catalogAccess: false }) },

  onUnload() {
    this.onHide()
    if (this._unsubscribeSync) this._unsubscribeSync()
    if (this._unsubscribeStorage) this._unsubscribeStorage()
  },

  onShow() {
    this._visible = true
    user.whenReady(() => { if (this._visible) { this.refresh(); this.refreshCatalogAccess() } })
  },

  async refreshCatalogAccess() {
    const generation = this._catalogGeneration = (this._catalogGeneration || 0) + 1
    this.setData({ catalogAccess: false })
    // 游客没有身份，管理端入口必然不可见，不必为此发起云调用
    if (!user.isLogged()) return
    try {
      const client = runtimeClient(), ctx = client.capture(), result = await client.access()
      if (this._visible && generation === this._catalogGeneration && client.current(ctx)) this.setData({ catalogAccess: Array.isArray(result.roles) && result.roles.length > 0 })
    } catch (e) { /* swallow: failed permission lookup hides the optional management entry. */ }
  },

  goCatalogAdmin() { if (this.data.catalogAccess) wx.navigateTo({ url: '/pages/catalog-admin/catalog-admin' }) },

  onPullDownRefresh() {
    user.whenReady(() => this.refresh())
    wx.stopPullDownRefresh()
  },

  refresh() {
    const profile = user.getProfile()
    this.setData({ logged: !!profile.logged, user: { nickName: profile.nickName || '', avatarUrl: profile.avatarUrl || '', exam: profile.exam || '' }, initial: user.initial(profile.nickName) })
    let readable = true
    try { this.refreshLearningData() } catch (e) {
      if (isStorageReadable(store.getLocalStorageStatus())) throw e
      readable = false
    }
    const status = store.getLocalStorageStatus()
    this.setData({ localStorage: storageStatusView(status), storageReadable: readable && isStorageReadable(status) })
  },

  refreshLearningData() {
    const settings = store.getSettings()
    const overview = analytics.overview()
    const records = store.getRecords()

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

  onRetryStorage() {
    if (!user.whenReady()) return
    const result = store.retryLocalStorage()
    this.refresh()
    const title = result.ok ? '本地保存检查完成' : result.deferred ? '存储优化仍需延期' : result.cleanupPending ? '存储清理仍待完成' :
      result.error === 'RETRY_ORIGINAL_OPERATION' ? '请返回原操作重试' :
      result.error === 'LOCAL_RESTART_REQUIRED' ? '请重启后核对记录' : '重试未完成，请保留数据'
    wx.showToast({ title, icon: 'none' })
  },

  onClearData() {
    const self = this
    wx.showModal({
      title: '清空学习数据',
      content: '答题记录、错题本、学情数据将被全部删除且无法恢复',
      confirmText: '确认清空',
      confirmColor: '#e5484d',
      success(res) {
        if (!res.confirm) return
        const result = store.clearAll()
        if (!result.ok) {
          wx.showToast({ title: '清空失败，原数据已保留', icon: 'none' })
          return
        }
        wx.showToast({ title: result.pendingLocalReset ? '删除已受理，本地处理待重试' : '已清空', icon: 'none' })
        self.refresh()
      }
    })
  },

  onAbout() {
    wx.showModal({
      title: '关于',
      content: `回练 v${config.version}\n云端题库与 AI 助教；换设备前请确认学习数据已同步。`,
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
      content: '退出后回到游客模式，本机游客记录不受影响；账号学习数据已保存在云端',
      confirmText: '退出',
      confirmColor: '#e5484d',
      success(res) {
        if (!res.confirm) return
        user.logout().then(() => {
          app.setLogged(false)
          // 退出不等于被踢出应用：回到首页以游客身份继续使用
          wx.reLaunch({ url: '/pages/index/index' })
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
