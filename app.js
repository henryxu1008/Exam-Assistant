// app.js
const store = require('./utils/store.js')
const user = require('./utils/user.js')

App({
  globalData: {
    /** 待消费的练习参数：{mode, subject, chapter, ids, __stamp} */
    practiceParams: null,
    /** AI 页面预填输入 */
    aiPreInput: '',
    /** AI 页面上下文：{questionId, userAnswer} */
    aiContext: null,
    /** 是否已登录 */
    logged: false,
    /** 启动时的会话校验是否已完成 */
    sessionReady: false
  },

  onLaunch() {
    // 初始化本地数据仓储（答题记录 / 错题 / 学情）
    store.load()

    // 初始化云开发并校验登录会话
    user.initCloud()
    this._sessionWaiters = []
    this._checkSession()
  },

  onHide() {
    // 进入后台时强制落盘，避免节流窗口内的作答丢失
    store.flush()
  },

  /** 启动时恢复/校验会话：未登录时 resolve，由首页拦截跳转登录页 */
  _checkSession() {
    const self = this
    user
      .ensureSession()
      .then((profile) => {
        self._setSession(!!profile)
      })
      .catch(() => {
        self._setSession(false)
      })
  },

  _setSession(logged) {
    this.globalData.logged = logged
    this.globalData.sessionReady = true
    const waiters = this._sessionWaiters || []
    this._sessionWaiters = []
    waiters.forEach((fn) => fn(logged))
  },

  /** 登录态变化（登录页登录成功 / 退出登录时调用） */
  setLogged(logged) {
    this.globalData.logged = !!logged
    this.globalData.sessionReady = true
  },

  /** 等待会话校验完成后回调（已完成时立即回调） */
  whenSessionReady(fn) {
    if (typeof fn !== 'function') return
    if (this.globalData.sessionReady) {
      fn(this.globalData.logged)
      return
    }
    this._sessionWaiters = (this._sessionWaiters || []).concat([fn])
  },

  /**
   * 进入练习页（练习页属于 tabBar 页面，只能通过 switchTab 跳转，参数走 globalData）
   * @param {Object} options {mode, subject, chapter, ids}
   * mode: all 顺序 / random 随机 / weak 薄弱 / review 待复习 / wrong 错题 / chapter 章节 / single 指定题目
   */
  startPractice(options) {
    const params = Object.assign({ mode: 'all' }, options || {})
    // 携带科目时（首页科目卡 / 学情章节专练）同步为全应用当前科目
    if (params.subject) store.setCurrentSubject(params.subject)
    params.__stamp = Date.now()
    this.globalData.practiceParams = params
    // 若练习页已经是当前激活页，switchTab 不会重触发 onShow，需直接消费参数
    const pages = getCurrentPages()
    const cur = pages[pages.length - 1]
    if (cur && cur.route === 'pages/practice/practice' && typeof cur.loadPending === 'function') {
      cur.loadPending()
      return
    }
    // 练习页是 tabBar 页，只能 switchTab；navigateTo 到 tabBar 页必然失败，无需兜底
    wx.switchTab({ url: '/pages/practice/practice' })
  }
})
