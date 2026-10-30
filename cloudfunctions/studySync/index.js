/**
 * 云函数 studySync
 * 入参：{ token, action: 'get' | 'update', stats?, attempts? }
 * 出参：{ ok, stats?, attempts? }
 *
 * action=get：返回当前用户的学习档案（studyStats 文档）+ 一页作答流水（attempts 集合）。
 *   作答流水按 createdAt + _id 升序分页，单页上限 100 条；前端带 skip 顺序翻页直到 hasMore 为 false，
 *   从而支持超过 100/1000 条的大流水（云数据库单查上限 100，直接 .get() 会被截断）。
 * action=update：upsert 学习档案（白名单字段），并把新增作答流水 upsert 进 attempts 集合。
 * action=delete：删除当前用户的学习档案（studyStats 文档）与全部作答流水（attempts 集合），
 *   对应前端「清空学习数据」，保证本地与云端一并清空。
 *
 * 设计：
 *  - 聚合/派生数据（records/daily/settings/practiceSession/aiMessages/version）存 studyStats 单文档（按 openid）。
 *  - 原始作答流水 attempts 量可能较大且只追加，单独存 attempts 集合（每条一个文档，
 *    _id = attempt.id、openid 归属），避免单文档 16MB 上限与并发覆盖。
 *
 * 依赖集合：users（校验令牌）、studyStats、attempts。
 */

const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const USERS = db.collection('users')
const STATS = db.collection('studyStats')
const ATTEMPTS = db.collection('attempts')

/** 令牌有效期，与小程序端 utils/user.js 的 TOKEN_TTL 保持一致 */
const TOKEN_TTL = 30 * 24 * 60 * 60 * 1000

/** studyStats 文档允许写入的字段（其余一律丢弃，防越权/脏数据） */
const ALLOWED = ['records', 'daily', 'settings', 'practiceSession', 'aiMessages', 'version']

/** 作答流水允许写入的字段（防止把大对象/无关字段塞进库） */
const ATTEMPT_FIELDS = [
  'id', 'sessionId', 'questionId', 'questionVersionId',
  'selected', 'answer', 'score', 'costMs', 'clientOpId', 'createdAt'
]

/**
 * 只放行白名单字段；云函数之间不共享本地模块，令牌查找逻辑需与 userProfile 保持一致。
 */
function sanitizeStats(payload) {
  const src = payload && typeof payload === 'object' ? payload : {}
  const out = {}
  ALLOWED.forEach((k) => {
    if (src[k] !== undefined) out[k] = src[k]
  })
  return out
}

/** 清洗单条作答；无 id 的丢弃。openid 由调用处填充。 */
function sanitizeAttempt(a) {
  if (!a || !a.id) return null
  const out = { _id: String(a.id) }
  ATTEMPT_FIELDS.forEach((k) => {
    if (a[k] !== undefined) out[k] = a[k]
  })
  return out
}

async function findByToken(token) {
  if (!token) return null
  const res = await USERS.where({ token: token }).limit(1).get()
  const doc = res.data && res.data.length ? res.data[0] : null
  if (!doc) return null
  if (!doc.tokenAt || Date.now() - doc.tokenAt > TOKEN_TTL) return null
  return doc
}

exports.main = async (event) => {
  const token = event.token
  if (!token) return { ok: false, error: 'NO_TOKEN' }

  const user = await findByToken(token)
  if (!user) return { ok: false, error: 'INVALID_TOKEN' }

  const openid = user.openid
  const action = event.action || 'get'

  if (action === 'get') {
    let stats = null
    try {
      const res = await STATS.doc(openid).get()
      stats = res.data || null
    } catch (e) {
      // 文档不存在视为尚未同步过
      stats = null
    }
    // 作答流水可能很多：单查上限 100 条，采用分页拉取（按 createdAt + _id 排序避免重复/遗漏）
    const limit = Math.min(parseInt(event.limit, 10) || 100, 100)
    const skip = Math.max(parseInt(event.skip, 10) || 0, 0)
    let attempts = []
    let hasMore = false
    let nextSkip = null
    try {
      const res = await ATTEMPTS.where({ openid })
        .orderBy('createdAt', 'asc')
        .orderBy('_id', 'asc')
        .skip(skip)
        .limit(limit)
        .get()
      const list = res.data || []
      attempts = list.map((d) => {
        const { _id, openid: _o, ...rest } = d
        return rest
      })
      hasMore = list.length >= limit
      nextSkip = hasMore ? skip + list.length : null
    } catch (e) {
      attempts = []
    }
    return { ok: true, stats, attempts, hasMore, nextSkip }
  }

  if (action === 'update') {
    const clean = sanitizeStats(event.stats)
    clean.updatedAt = Date.now()
    await STATS.doc(openid).set({ data: Object.assign({ _id: openid, openid: openid }, clean) })

    // 增量 upsert 新增作答流水：同一 _id 重复写入是幂等的，不会重复落库
    const list = Array.isArray(event.attempts) ? event.attempts : []
    const tasks = []
    for (const a of list) {
      const cleanA = sanitizeAttempt(a)
      if (!cleanA) continue
      cleanA.openid = openid
      tasks.push(ATTEMPTS.doc(cleanA._id).set({ data: cleanA }))
    }
    if (tasks.length) await Promise.all(tasks)
    return { ok: true }
  }

  if (action === 'delete') {
    // 删除学习档案与全部作答流水（对应前端「清空学习数据」）
    try {
      await STATS.doc(openid).remove()
    } catch (e) {
      /* 文档不存在视为已清空 */
    }
    try {
      await ATTEMPTS.where({ openid }).remove()
    } catch (e) {
      /* 无作答流水视为已清空 */
    }
    return { ok: true }
  }

  return { ok: false, error: 'BAD_ACTION' }
}
