/**
 * shared/auth.js
 * 云函数共用的鉴权原语
 *
 * 背景：这些云函数写入的是「共享文档」或「账号级文档」——
 *   - questions/bank      ：全量下发给所有用户的题库
 *   - appConfig/*         ：运营配置（公告 / 功能开关 / 强制更新）
 *   - studyStats/<openid> ：账号学习档案
 * 一旦对匿名调用者开放写入，任何人都能改掉所有用户看到的内容或配置。
 * 因此统一走这里：任何端上调用都无法绕过（判定全在服务端）。
 *
 * 部署约定：云函数按目录独立上传，无法 require 父级代码，
 * 所以 cloudfunctions/<fn>/auth.js 是本文件的部署副本，
 * 由 scripts/check-shared-sync.js 校验必须与本文件逐字节一致。
 */

/** 令牌有效期，与小程序端 utils/user.js 的 TOKEN_TTL 保持一致 */
const TOKEN_TTL = 30 * 24 * 60 * 60 * 1000

/**
 * 按令牌查找登录用户。
 * 无令牌 / 查不到 / 令牌已过期，一律返回 null（调用方按未登录处理）。
 * @param {Object} USERS users 集合句柄（各云函数自带 db）
 * @param {String} token
 * @returns {Promise<Object|null>}
 */
async function findByToken(USERS, token) {
  if (!token) return null
  const res = await USERS.where({ token: token }).limit(1).get()
  const doc = res.data && res.data.length ? res.data[0] : null
  if (!doc) return null
  if (!doc.tokenAt || Date.now() - doc.tokenAt > TOKEN_TTL) return null
  return doc
}

/** 常量时间字符串比较，避免通过响应耗时逐字节猜测密钥 */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  if (ba.length !== bb.length) return false
  let diff = 0
  for (let i = 0; i < ba.length; i++) diff |= ba[i] ^ bb[i]
  return diff === 0
}

/**
 * 读取管理员 openid 名单。
 * 两个来源取并集：
 *   - appConfig.admins 文档（控制台维护，无需改代码 / 重新部署）
 *   - 环境变量 ADMIN_OPENIDS（逗号分隔，作为控制台尚未配置时的兜底）
 * @param {Object} CONFIG appConfig 集合句柄
 * @returns {Promise<string[]>}
 */
async function getAdminOpenids(CONFIG) {
  const fromEnv = String(process.env.ADMIN_OPENIDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  try {
    const res = await CONFIG.doc('admins').get()
    const list = res && res.data && Array.isArray(res.data.openids) ? res.data.openids : []
    return fromEnv.concat(list.map((s) => String(s).trim()).filter(Boolean))
  } catch (e) {
    // 未配置管理员名单：仅环境变量生效
    return fromEnv
  }
}

/**
 * 判定调用方是否具备管理员权限。两条途径任一成立即可：
 *  1) 管理员密钥：event.adminSecret 等于环境变量 ADMIN_SECRET。
 *     用于云开发控制台「运行一次」这类没有登录身份的调用。
 *  2) 管理员账号：event.token 能查到用户，且该 openid 在管理员名单内。
 *     用于端上的管理员工具。
 *
 * 安全默认（fail-closed）：ADMIN_SECRET 未配置时途径 1 直接不成立，
 * 而不是「没配密钥就放行」。名单为空时途径 2 也不成立。
 *
 * @param {Object} event
 * @param {Object} USERS users 集合句柄
 * @param {Object} CONFIG appConfig 集合句柄（可为 null，表示不启用途径 2）
 * @returns {Promise<{ok: Boolean, error?: String, user?: Object}>}
 */
function verifyAdminSecret(event) {
  const expected = String(process.env.ADMIN_SECRET || '')
  if (!expected) return { ok: false, error: 'ADMIN_SECRET_NOT_CONFIGURED' }
  if (!safeEqual(String(event.adminSecret || ''), expected)) return { ok: false, error: 'NOT_ADMIN' }
  return { ok: true }
}

async function authorizeAdmin(event, USERS, CONFIG) {
  if (verifyAdminSecret(event).ok) return { ok: true, via: 'secret' }

  if (!CONFIG || !event.token) return { ok: false, error: 'NOT_ADMIN' }
  const user = await findByToken(USERS, event.token)
  if (!user) return { ok: false, error: 'INVALID_TOKEN' }
  const admins = await getAdminOpenids(CONFIG)
  if (admins.indexOf(user.openid) === -1) return { ok: false, error: 'NOT_ADMIN' }
  return { ok: true, user: user, via: 'openid' }
}

module.exports = {
  TOKEN_TTL,
  findByToken,
  safeEqual,
  getAdminOpenids,
  verifyAdminSecret,
  authorizeAdmin
}
