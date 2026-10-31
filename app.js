// app.js
const config = require('./utils/config.js')
const store = require('./utils/store.js')
const user = require('./utils/user.js')
const bank = require('./utils/questions.js')

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
    sessionReady: false,
    /** 云端运营配置（公告/功能开关/强制更新等） */
    config: null
  },

  onLaunch() {
    // 先初始化云开发（wx.cloud.init），再加载本地仓储——
    // store.load 会触发云端拉取，必须在 cloud 就绪之后调用，否则报 "Cloud API isn't enabled"
    user.initCloud()

    // 冷启动且本地已有登录缓存时，先把数据作用域绑定到该账号，再加载本地仓储。
    // 否则会以 anon 作用域加载并在切作用域时用空档案覆盖该账号的云端备份（评审 P1）。
    user.bindStoredScope()

    // 初始化本地数据仓储（答题记录 / 错题 / 学情）
    store.load()

    this._sessionWaiters = []
    this._checkSession()

    // 以下均为云就绪后的异步操作，不阻塞启动：
    // 1) 拉取运营配置（公告/功能开关/强制更新）
    user.getRuntimeConfig()
      .then((cfg) => {
        this.globalData.config = cfg || null
        this._applyRuntimeConfig(cfg)
      })
      .catch(() => {})
    // 2) 题库云端覆盖（拉取最新题目，无云时保持内置兜底）
    bank.loadCloudBank().catch(() => {})
    // 3) 首次运行把内置题库种入云端（仅一次）
    bank.pushStaticBankToCloud().catch(() => {})
  },

  /** 应用云端运营配置：强制更新校验 + 隐私政策版本变更重新提示 */
  _applyRuntimeConfig(cfg) {
    // cfg 为 null 表示「配置不可用」（无云 / 拉取失败），此时必须保持原状，
    // 既不能置位也不能清除阻断态——把它当成「没有限制」会让上一次判定
    // 的阻断在离线重启后失效（评审 P2 4429855406）。
    if (!cfg) return
    // 1) 强制更新：版本过低且运营要求时，置位持久化阻断态。
    //    提示框本身不阻断任何流程（showCancel 只影响取消按钮的显示），
    //    真正的拦截由 guardEntry() 在各入口完成（评审 P2 4422339109）。
    if (cfg.forceUpdate && this._versionCompare(config.version, cfg.minVersion) < 0) {
      user.markUnsupportedVersion()
      this._showUpdateBlocker()
      return
    }
    // 版本已达标（或运营已解除强制更新）：清除阻断态
    user.clearUnsupportedVersion()
    // 2) 隐私政策更新：云端 privacyVersion 高于本地已同意版本时，提示重新查看（不阻断）
    const accepted = user.getPrivacyAcceptedVersion()
    if (typeof cfg.privacyVersion === 'number' && cfg.privacyVersion > accepted) {
      wx.showModal({
        title: '隐私政策更新',
        content: '我们的隐私政策已更新，点击查看最新版本以了解我们如何保护你的数据。',
        confirmText: '查看',
        cancelText: '稍后',
        success: (res) => {
          if (res.confirm) {
            user.setPrivacyAcceptedVersion(cfg.privacyVersion)
            wx.navigateTo({ url: '/pages/agreement/agreement?type=privacy' })
          }
        }
      })
    }
  },

  /**
   * 入口守卫：版本被判定为过低时阻断操作并提示更新。
   * @returns {Boolean} true 表示已阻断，调用方应立即返回
   */
  guardEntry() {
    if (!user.isVersionBlocked()) return false
    this._showUpdateBlocker()
    return true
  },

  /** 版本过低时的阻断提示（不可取消；更新后重启即可正常进入） */
  _showUpdateBlocker() {
    wx.showModal({
      title: '请更新版本',
      content: '当前版本过低，部分功能已不可用，请更新到最新版本后继续使用。',
      showCancel: false,
      confirmText: '知道了'
    })
  },

  /** 语义化版本比较：a<b 返回 -1，a==b 返回 0，a>b 返回 1 */
  _versionCompare(a, b) {
    const pa = String(a || '').split('.').map((n) => parseInt(n, 10) || 0)
    const pb = String(b || '').split('.').map((n) => parseInt(n, 10) || 0)
    const len = Math.max(pa.length, pb.length)
    for (let i = 0; i < len; i++) {
      const x = pa[i] || 0
      const y = pb[i] || 0
      if (x < y) return -1
      if (x > y) return 1
    }
    return 0
  },

  onHide() {
    // 进入后台时强制落盘，避免节流窗口内的作答丢失
    store.flush()
  },

  /**
   * 启动时恢复/校验会话：未登录时 resolve，由首页拦截跳转登录页。
   *
   * 这里**不能**走 guardEntry()：会话恢复只是读取当前登录态，不是「使用功能」。
   * 一旦在此拦截，sessionReady 永远停在 false，而后面即便运营解除强制更新、
   * _applyRuntimeConfig 清掉了阻断态，也没有任何路径会再补一次会话初始化——
   * 所有 whenSessionReady 的等待者将永久挂起，页面永远不初始化。
   * 鉴权必须与入口限制解耦（评审 P1 4425408864）。
   */
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
    if (this.guardEntry()) return
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
