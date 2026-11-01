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
const CONFIG = db.collection('appConfig')

/** 「读失败不得当成不存在」的统一判定；部署副本随本函数一起上传 */
const { isNotFound } = require('./db-error.js')

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

/** 只撤销读取时的令牌；并发新登录写入的新令牌不属于本次操作。 */
function clearTokenIfCurrent(doc) {
  return USERS.where({ _id: doc._id, token: doc.token })
    .update({ data: { token: '', tokenAt: 0 } })
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
    // 过期令牌的清理属于尽力而为，失败不影响本次「令牌已过期」的判定结果
    await clearTokenIfCurrent(doc).catch(() => { /* swallow: 同上，清理失败不影响本次判定 */ })
    return null
  }
  return doc
}

exports.main = async (event) => {
  // 目标考试可选项：无需登录即可获取，完全由云开发后台在 appConfig 集合中维护，
  // 不提供默认兜底——集合/文档不存在或字段缺失时返回空列表。
  // 文档约定：_id = 'examOptions'，字段 options = string[]。
  if ((event.action || 'get') === 'examOptions') {
    try {
      const res = await CONFIG.doc('examOptions').get()
      const doc = res.data || {}
      const options = Array.isArray(doc.options) ? doc.options : []
      return { ok: true, examOptions: options }
    } catch (e) {
      // 集合确实还没建立才等价为空列表；读失败必须报错，
      // 否则端上会把「读不到」当成「没有可选项」（评审 P2 4430849974 同类）
      if (isNotFound(e)) return { ok: true, examOptions: [] }
      return { ok: false, error: 'READ_EXAM_OPTIONS_FAILED' }
    }
  }

  // 运营配置（公告/功能开关/强制更新等）：无需登录，完全由云开发后台在 appConfig 集合中维护。
  // 文档约定：_id = 'runtime'，字段见 initConfig 的 DEFAULT_RUNTIME。
  if ((event.action || 'get') === 'config') {
    try {
      const res = await CONFIG.doc('runtime').get()
      return { ok: true, config: res.data || {} }
    } catch (e) {
      // 读失败绝不能返回 {ok:true, config:{}}：端上拿到的空配置会被
      // user.getRuntimeConfig() 理解为「拉取成功且运营没有任何限制」，
      // 从而清掉上一次判定的版本阻断——
      // 这会让端上针对评审 P2 4429855406 的修复完全失效（同一根因，服务端侧）。
      if (isNotFound(e)) return { ok: true, config: {} }
      return { ok: false, error: 'READ_CONFIG_FAILED' }
    }
  }

  const token = event.token
  if (!token) return { ok: false, error: 'NO_TOKEN' }

  const user = await findByToken(token)
  if (!user) return { ok: false, error: 'INVALID_TOKEN' }

  const action = event.action || 'get'

  if (action === 'logout') {
    await clearTokenIfCurrent(user)
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
