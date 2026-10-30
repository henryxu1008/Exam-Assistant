/**
 * utils/user.js
 * 用户登录与资料 —— 微信云开发版
 *
 * 流程：wx.login 取 code → 云函数 userLogin 换取 openid / token → 本地缓存会话。
 * 身份完全由云端决定，本地仅缓存会话用于渲染；未登录不可使用应用（强制登录）。
 *
 * 依赖：需在开发者工具中开通云开发，并部署 cloudfunctions/userLogin、cloudfunctions/userProfile。
 */

const config = require('./config.js')
const store = require('./store.js')

const SESSION_KEY = 'exam_quiz_session_v1'

/** 令牌有效期，略小于云函数 userProfile 的 TOKEN_TTL，留出边界余量 */
const TOKEN_TTL = 29 * 24 * 60 * 60 * 1000

// 只有明确的身份拒绝才撤销本地会话；业务故障与传输失败保留 unknown 状态。
const SESSION_REJECTIONS = ['INVALID_TOKEN', 'NO_TOKEN']

function defaults() {
  return {
    logged: false,
    openid: '',
    token: '',
    nickName: '',
    avatarUrl: '', // 云存储 fileID
    exam: '',
    loginAt: 0,
    updatedAt: 0
  }
}

let cache = null

function load() {
  if (cache) return cache
  try {
    const raw = wx.getStorageSync(SESSION_KEY)
    cache = raw && typeof raw === 'object' ? Object.assign(defaults(), raw) : defaults()
  } catch (e) {
    cache = defaults()
  }
  return cache
}

function persist(profile) {
  cache = profile
  try {
    wx.setStorageSync(SESSION_KEY, profile)
  } catch (e) {
    console.error('[user] 会话持久化失败', e)
  }
  return Object.assign({}, profile)
}

function getProfile() {
  return Object.assign({}, load())
}

function isLogged() {
  const s = load()
  return !!s.logged && !!s.token
}

/** 初始化云开发（重复调用安全） */
function initCloud() {
  if (!wx.cloud || typeof wx.cloud.init !== 'function') return false
  try {
    const opts = { traceUser: true }
    if (config.cloudEnv) opts.env = config.cloudEnv
    wx.cloud.init(opts)
    return true
  } catch (e) {
    return false // 已初始化
  }
}

function hasCloud() {
  return !!wx.cloud && typeof wx.cloud.callFunction === 'function'
}

/** 统一调用云函数，云端返回 ok:false 时按失败处理 */
function call(name, data) {
  if (!hasCloud()) {
    return Promise.reject(new Error('未开通云开发，请先在开发者工具中开通'))
  }
  return wx.cloud
    .callFunction({ name: name, data: data || {} })
    .then((res) => {
      const r = res && res.result
      if (!r) return Promise.reject(new Error('云函数返回为空'))
      if (r.ok === false) {
        const e = new Error(r.error || '云函数调用失败')
        e.code = r.error || 'SERVER_ERROR'
        return Promise.reject(e)
      }
      return r
    })
}

function getCode() {
  return new Promise((resolve, reject) => {
    if (typeof wx.login !== 'function') {
      reject(new Error('当前环境不支持 wx.login'))
      return
    }
    wx.login({
      timeout: 10000,
      success: (res) => {
        if (res && res.code) resolve(res.code)
        else reject(new Error('wx.login 未返回 code'))
      },
      fail: () => reject(new Error('wx.login 调用失败'))
    })
  })
}

/** 微信会话是否仍然有效 */
function checkSession() {
  return new Promise((resolve) => {
    if (typeof wx.checkSession !== 'function') {
      resolve(true)
      return
    }
    wx.checkSession({ success: () => resolve(true), fail: () => resolve(false) })
  })
}

/**
 * 登录：wx.login → 云函数换取身份与 token
 * @param {Object} extra 附加字段，如 {nickName, avatarUrl, exam}
 * @returns {Promise<Object>} 会话资料
 */
function login(extra) {
  return getCode()
    .then((code) => call(config.functions.login, Object.assign({ code: code }, extra || {})))
    .then((r) => {
      const p = r.profile || {}
      // 以云端可信 openid 绑定数据作用域：后续 store 读写只落在当前用户命名空间
      store.setUserScope(r.openid || '')
      return persist(
        Object.assign({}, load(), {
          logged: true,
          openid: r.openid || '',
          token: r.token || '',
          nickName: p.nickName || '',
          avatarUrl: p.avatarUrl || '',
          exam: p.exam || '',
          loginAt: Date.now(),
          updatedAt: Date.now()
        })
      )
    })
}

/** 令牌临近过期时静默重新登录换取新令牌，避免用到已被云端作废的 token */
function ensureFreshToken(cur) {
  if (cur.loginAt && Date.now() - cur.loginAt < TOKEN_TTL) return Promise.resolve(cur)
  return login({ nickName: cur.nickName, avatarUrl: cur.avatarUrl, exam: cur.exam })
}

/**
 * 服务端校验令牌：以 token 调 userProfile 验证其是否仍有效（覆盖撤销/过期/跨设备失效）。
 * 返回三态：'ok' 有效 / 'invalid' 服务端不认（须重新登录）/ 'unknown' 无云环境无法联网验证。
 * 注意：wx.checkSession 仅验证微信会话是否过期，不能替代我们对自身令牌的校验。
 */
function verifySessionOnServer(token) {
  if (!hasCloud()) return Promise.resolve('unknown')
  return call(config.functions.profile, { token: token, action: 'get' })
    .then(() => 'ok')
    // 仅当服务端显式拒绝才算 invalid；传输层（断网）失败视为 unknown，保留本地会话
    .catch((e) => e && SESSION_REJECTIONS.indexOf(e.code) !== -1 ? 'invalid' : 'unknown')
}

/**
 * 校验并恢复会话：以服务端令牌校验为主（而非仅依赖 wx.checkSession）。
 * - 未登录（无 token）：resolve(null)，由调用方跳转登录页。
 * - 服务端确认有效：临近过期则静默刷新。
 * - 服务端不认（撤销/过期/跨设备失效）：重新登录换取新令牌与作用域。
 * - 无法联网（unknown）：保留本地会话，避免断网时把所有用户踢出登录。
 * @returns {Promise<Object|null>}
 */
function ensureSession() {
  if (!isLogged()) return Promise.resolve(null)
  const cur = load()
  // 以可信 openid 绑定数据作用域，确保后续 store 读写落在当前用户命名空间（而非 anon）
  store.setUserScope(cur.openid || 'anon')
  return verifySessionOnServer(cur.token)
    .then((state) => {
      if (state === 'ok') return ensureFreshToken(cur)
      if (state === 'invalid') {
        // 已知失效与未知状态不可混淆：先撤销旧会话，自动重登只有拿到新令牌才可恢复。
        store.setUserScope('anon')
        persist(defaults())
        return login({ nickName: cur.nickName, avatarUrl: cur.avatarUrl, exam: cur.exam })
          .then((p) => ((p && p.token) ? p : null))
          .catch(() => null)
      }
      return cur // unknown（联网不可用）：保留本地会话，避免误踢出
    })
    .catch(() => cur) // 网络/调用异常等同 unknown，保留本地会话
}

/**
 * 更新资料
 * @param {Object} patch {nickName, avatarUrl, exam}
 */
function updateProfile(patch) {
  const cur = load()
  if (!cur.token) return Promise.reject(new Error('未登录'))
  return ensureFreshToken(cur).then((fresh) =>
    call(config.functions.profile, Object.assign({ token: fresh.token, action: 'update' }, patch)).then((r) => {
      const p = r.profile || {}
      return persist(
        Object.assign({}, fresh, {
          nickName: p.nickName !== undefined ? p.nickName : cur.nickName,
          avatarUrl: p.avatarUrl !== undefined ? p.avatarUrl : cur.avatarUrl,
          exam: p.exam !== undefined ? p.exam : cur.exam,
          updatedAt: Date.now()
        })
      )
    })
  )
}

/** 头像上传到云存储，返回 fileID */
function uploadAvatar(tempPath) {
  if (!tempPath) return Promise.resolve('')
  if (!hasCloud()) return Promise.reject(new Error('未开通云开发'))
  if (String(tempPath).indexOf('cloud://') === 0) return Promise.resolve(tempPath) // 已是 fileID
  const openid = load().openid || 'anonymous'
  const cloudPath = `avatars/${openid}_${Date.now()}.png`
  return wx.cloud.uploadFile({ cloudPath: cloudPath, filePath: tempPath }).then((res) => res.fileID || '')
}

/** 退出登录：清云端 token + 清本地会话 + 切回匿名数据作用域 */
function logout() {
  const cur = load()
  const clear = () => {
    store.setUserScope('anon')
    return persist(defaults())
  }
  if (!cur.token || !hasCloud()) return Promise.resolve(clear())
  return call(config.functions.profile, { token: cur.token, action: 'logout' }).then(clear, clear)
}

/** 头像文字兜底：昵称首字 */
function initial(name) {
  const s = String(name || '').trim()
  return s ? s.slice(0, 1) : '备'
}

function displayName() {
  const p = load()
  return p.logged ? p.nickName || '' : ''
}

/** 登录页跳转的去重标记，避免多个页面同时触发重复跳转 */
let loginRedirecting = false

/**
 * 页面级登录拦截：应在页面 onShow 中调用。
 * 会等 App 的会话校验结束后再判断，避免把「会话可用但尚未校验完」误判为未登录。
 * @param {Function} [onLogged] 确认已登录后的回调，用于刷新依赖用户资料的内容
 * @returns {Boolean} 当前是否已登录；返回 false 时不应继续渲染需登录后才有意义的内容
 */
function requireLogin(onLogged) {
  if (isLogged()) {
    if (typeof onLogged === 'function') onLogged()
    return true
  }
  if (loginRedirecting) return false
  loginRedirecting = true
  const done = (logged) => {
    loginRedirecting = false
    if (logged) {
      if (typeof onLogged === 'function') onLogged()
      return
    }
    wx.navigateTo({ url: '/pages/login/login' })
  }
  const app = typeof getApp === 'function' ? getApp() : null
  if (app && typeof app.whenSessionReady === 'function') app.whenSessionReady(done)
  else done(false)
  return false
}

module.exports = {
  initCloud,
  hasCloud,
  getProfile,
  isLogged,
  requireLogin,
  login,
  ensureSession,
  updateProfile,
  uploadAvatar,
  logout,
  initial,
  displayName
}
