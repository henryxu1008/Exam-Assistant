// pages/login/login.js
const app = getApp()
const user = require('../../utils/user.js')

Page({
  data: {
    /** login = 登录流程；edit = 已登录后编辑资料 */
    mode: 'login',
    /** login | profile | done */
    step: 'login',
    loading: false,
    saving: false,
    uploading: false,
    error: '',
    form: {
      nickName: '',
      avatarUrl: '', // 云存储 fileID
      exam: ''
    },
    avatarPreview: '',
    initial: '备',
    /** 目标考试选择器的候选列表与当前下标（来自云端，无本地兜底） */
    examOptions: [],
    examIndex: 0,
    /** 是否已勾选同意《用户协议》与《隐私政策》（登录前强制） */
    agreed: false
  },

  onLoad(options) {
    const profile = user.getProfile()
    const mode = (options && options.mode) || 'login'
    const form = {
      nickName: profile.nickName || '',
      avatarUrl: profile.avatarUrl || '',
      exam: profile.exam || ''
    }

    if (user.isLogged()) {
      this.setData({
        mode,
        form,
        avatarPreview: profile.avatarUrl || '',
        initial: user.initial(profile.nickName),
        step: mode === 'edit' ? 'profile' : 'done'
      })
      wx.setNavigationBarTitle({ title: mode === 'edit' ? '编辑资料' : '账号' })
      this.refreshExamOptions()
      return
    }

    this.setData({
      mode: 'login',
      step: 'login',
      form,
      // 曾同意过隐私政策的老用户预勾选，避免每次登出再登录都强制重勾；新用户须主动勾选
      agreed: user.getPrivacyAcceptedVersion() > 0
    })
    wx.setNavigationBarTitle({ title: '登录' })
    this.refreshExamOptions()
  },

  /**
   * 从云端拉取目标考试可选项（无本地兜底，完全依赖后端配置）。
   * 历史自由文本（旧数据）不在云端列表时，临时保留在列表末尾，避免选中态丢失。
   */
  refreshExamOptions() {
    const self = this
    const current = String(self.data.form.exam || '').trim()
    user.getExamOptions().then((cloud) => {
      const base = Array.isArray(cloud) ? cloud.slice() : []
      if (current && base.indexOf(current) === -1) base.push(current)
      const index = base.indexOf(current)
      self.setData({ examOptions: base, examIndex: index >= 0 ? index : 0 })
    })
  },


  /* ---------------- 登录 ---------------- */

  onWechatLogin() {
    if (this.data.loading) return
    // 强制勾选同意：未勾选则拦截登录，仅提示不报错
    if (!this.data.agreed) {
      wx.showToast({ title: '请先阅读并同意《用户协议》与《隐私政策》', icon: 'none' })
      return
    }
    this.setData({ loading: true, error: '' })
    const self = this
    user
      .login()
      .then((profile) => {
        // 登录成功即视为已同意当前云端隐私政策版本，写入本地已同意版本
        const cfg = (app.globalData && app.globalData.config) || {}
        if (typeof cfg.privacyVersion === 'number') user.setPrivacyAcceptedVersion(cfg.privacyVersion)
        app.setLogged(true)
        const form = {
          nickName: profile.nickName || '',
          avatarUrl: profile.avatarUrl || '',
          exam: profile.exam || ''
        }
        self.setData({
          loading: false,
          step: 'profile',
          initial: user.initial(profile.nickName),
          form,
          avatarPreview: profile.avatarUrl || ''
        })
        self.refreshExamOptions()
        wx.showToast({ title: '登录成功', icon: 'none' })
      })
      .catch((err) => {
        self.setData({ loading: false, error: (err && err.message) || '登录失败' })
        wx.showToast({ title: '登录失败', icon: 'none' })
      })
  },

  /* ---------------- 资料 ---------------- */

  /** 勾选/取消「已同意协议」 */
  onAgreeChange(e) {
    this.setData({ agreed: !!(e.detail && e.detail.value && e.detail.value.length) })
  },

  onChooseAvatar(e) {
    const tempPath = e.detail && e.detail.avatarUrl
    if (!tempPath) return
    const self = this
    this.setData({ avatarPreview: tempPath, uploading: true })
    user
      .uploadAvatar(tempPath)
      .then((fileID) => {
        self.setData({ 'form.avatarUrl': fileID, uploading: false })
      })
      .catch((err) => {
        self.setData({ uploading: false })
        wx.showToast({ title: (err && err.message) || '头像上传失败', icon: 'none' })
      })
  },

  onNickName(e) {
    this.setData({
      'form.nickName': e.detail.value,
      initial: user.initial(e.detail.value)
    })
  },

  onExamChange(e) {
    const options = this.data.examOptions || []
    const index = Number(e.detail.value) || 0
    const exam = options[index] || ''
    this.setData({ examIndex: index, 'form.exam': exam })
  },

  onSave() {
    if (this.data.saving) return
    const form = this.data.form
    const nickName = String(form.nickName || '').trim()
    if (!nickName) {
      wx.showToast({ title: '请填写昵称', icon: 'none' })
      return
    }
    const self = this
    this.setData({ saving: true, error: '' })
    user
      .updateProfile({
        nickName: nickName,
        avatarUrl: form.avatarUrl || '',
        exam: String(form.exam || '').trim()
      })
      .then(() => {
        self.setData({ saving: false })
        wx.showToast({ title: '已保存', icon: 'none' })
        self.goBack()
      })
      .catch((err) => {
        self.setData({ saving: false, error: (err && err.message) || '保存失败' })
        wx.showToast({ title: '保存失败', icon: 'none' })
      })
  },

  onEdit() {
    this.setData({ step: 'profile', mode: 'edit' })
    wx.setNavigationBarTitle({ title: '编辑资料' })
    this.refreshExamOptions()
  },

  onLogout() {
    const self = this
    wx.showModal({
      title: '退出登录',
      content: '退出后需要重新微信授权登录',
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

  goPractice() {
    wx.switchTab({ url: '/pages/practice/practice' })
  },

  /* ---------------- 返回 ---------------- */

  goBack() {
    const pages = getCurrentPages()
    if (pages.length > 1) {
      wx.navigateBack()
      return
    }
    wx.switchTab({ url: '/pages/index/index' })
  }
})
