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
    initial: '备'
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
      return
    }

    this.setData({ mode: 'login', step: 'login', form })
    wx.setNavigationBarTitle({ title: '登录' })
  },

  /* ---------------- 登录 ---------------- */

  onWechatLogin() {
    if (this.data.loading) return
    this.setData({ loading: true, error: '' })
    const self = this
    user
      .login()
      .then((profile) => {
        app.setLogged(true)
        self.setData({
          loading: false,
          step: 'profile',
          initial: user.initial(profile.nickName),
          form: {
            nickName: profile.nickName || '',
            avatarUrl: profile.avatarUrl || '',
            exam: profile.exam || ''
          },
          avatarPreview: profile.avatarUrl || ''
        })
        wx.showToast({ title: '登录成功', icon: 'none' })
      })
      .catch((err) => {
        self.setData({ loading: false, error: (err && err.message) || '登录失败' })
        wx.showToast({ title: '登录失败', icon: 'none' })
      })
  },

  /* ---------------- 资料 ---------------- */

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

  onExam(e) {
    this.setData({ 'form.exam': e.detail.value })
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
