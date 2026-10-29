/**
 * 云函数 userProfile
 * 入参：{ token, action: 'get' | 'update' | 'logout', nickName?, avatarUrl?, exam? }
 * 出参：{ ok, profile }
 *
 * action=update：更新昵称/头像/目标考试
 * action=logout：作废 token
 * action=get（默认）：返回当前用户资料
 *
 * 依赖集合：users
 */

const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const USERS = db.collection('users')

const EDITABLE = ['nickName', 'avatarUrl', 'exam']

/** 字段最长字数，超长截断 */
const FIELD_MAX = { nickName: 32, exam: 40 }

/** 令牌有效期，与小程序端 utils/user.js 的 TOKEN_TTL 保持一致 */
const TOKEN_TTL = 30 * 24 * 60 * 60 * 1000

/**
 * 只放行白名单字段并清洗：昵称/目标考试截断到上限，头像只接受云存储 fileID。
 * 云函数之间不共享本地模块，此实现需与 userLogin 保持一致。
 */
function sanitize(event) {
  const patch = {}
  EDITABLE.forEach((k) => {
    if (event[k] === undefined) return
    const v = String(event[k] || '').trim()
    if (k === 'avatarUrl') {
      // 只接受云存储 fileID，外部 URL 或任意长串一律丢弃
      if (v && v.indexOf('cloud://') !== 0) return
      patch[k] = v
      return
    }
    patch[k] = v.slice(0, FIELD_MAX[k])
  })
  return patch
}

/** 只回传可编辑字段，openid / unionid / token / _id 不下发到端上 */
function publicProfile(doc) {
  const out = {}
  EDITABLE.forEach((k) => {
    out[k] = doc[k] || ''
  })
  return out
}

async function findByToken(token) {
  if (!token) return null
  const res = await USERS.where({ token: token })
    .limit(1)
    .get()
  const doc = res.data && res.data.length ? res.data[0] : null
  if (!doc) return null
  // 过期令牌直接作废，小程序端会静默重新登录换取新令牌
  if (!doc.tokenAt || Date.now() - doc.tokenAt > TOKEN_TTL) {
    await USERS.doc(doc._id)
      .update({ data: { token: '', tokenAt: 0 } })
      .catch(() => {})
    return null
  }
  return doc
}

exports.main = async (event) => {
  const token = event.token
  if (!token) return { ok: false, error: 'NO_TOKEN' }

  const user = await findByToken(token)
  if (!user) return { ok: false, error: 'INVALID_TOKEN' }

  const action = event.action || 'get'

  if (action === 'logout') {
    await USERS.doc(user._id).update({ data: { token: '', tokenAt: 0 } })
    return { ok: true }
  }

  if (action === 'update') {
    const saved = sanitize(event)
    const patch = Object.assign({ updatedAt: Date.now() }, saved)
    await USERS.doc(user._id).update({ data: patch })
    return { ok: true, profile: publicProfile(Object.assign({}, user, saved)) }
  }

  return { ok: true, profile: publicProfile(user) }
}
