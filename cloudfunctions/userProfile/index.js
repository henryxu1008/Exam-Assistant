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

async function findByToken(token) {
  if (!token) return null
  const res = await USERS.where({ token: token })
    .limit(1)
    .get()
  return res.data && res.data.length ? res.data[0] : null
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
    const patch = { updatedAt: Date.now() }
    EDITABLE.forEach((k) => {
      if (event[k] !== undefined) patch[k] = event[k]
    })
    await USERS.doc(user._id).update({ data: patch })
    return { ok: true, profile: Object.assign({}, user, patch) }
  }

  return { ok: true, profile: user }
}
