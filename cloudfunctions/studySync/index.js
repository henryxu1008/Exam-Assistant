/**
 * 云函数 studySync
 * 入参：{ token, action: 'get' | 'update' | 'delete', stats?, attempts? }
 * 出参：{ ok, stats?, attempts? }
 *
 * action=get：返回当前用户的学习档案（studyStats 文档）+ 一页作答流水（attempts 集合）。
 *   作答流水按 createdAt + _id 升序分页，单页上限 100 条；前端带 skip 顺序翻页直到 hasMore 为 false，
 *   从而支持超过 100/1000 条的大流水（云数据库单查上限 100，直接 .get() 会被截断）。
 * action=update：与服务端已有档案「合并」后 upsert（白名单字段），并把新增作答流水 upsert 进 attempts 集合。
 * action=delete：删除当前用户的学习档案（studyStats 文档）与全部作答流水（attempts 集合），
 *   对应前端「清空学习数据」，保证本地与云端一并清空。
 *
 * 设计：
 *  - 聚合/派生数据（records/daily/settings/practiceSession/aiMessages/version）存 studyStats 单文档（按 openid）。
 *  - 原始作答流水 attempts 量可能较大且只追加，单独存 attempts 集合（每条一个文档，
 *    _id = attempt.id、openid 归属），避免单文档 16MB 上限与并发覆盖。
 *
 * 为什么必须用合并而不是整doc覆盖（评审 P1 4422245834）：
 *  端上只在「每个作用域启动后」拉取一次，之后的每次 flush 都是直接上传本地快照。
 *  两台设备恢复同一账号后各自练习、各自上传，若服务端无条件 set()，
 *  后到的一方的整份文档会抹掉另一端新增的 records / daily / aiMessages。
 *  因此在事务内「先读已有快照 → 与本次上传 mergeStats 合并 → 再写入」，
 *  让并发上传是累加而非互相覆盖。合并实现与端上共用 shared/stats-merge.js。
 *
 * 依赖集合：users（校验令牌）、studyStats、attempts。
 */

const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const USERS = db.collection('users')
const STATS = db.collection('studyStats')
const ATTEMPTS = db.collection('attempts')

/** 与端上 utils/store.js 相同的合并语义；部署副本随本函数一起上传 */
const { mergeStats } = require('./stats-merge.js')
/** 令牌校验（与 userProfile 保持一致）；部署副本随本函数一起上传 */
const { findByToken } = require('./auth.js')

/** studyStats 文档允许写入的字段（其余一律丢弃，防越权/脏数据） */
const ALLOWED = ['records', 'daily', 'settings', 'practiceSession', 'aiMessages', 'aiEpoch', 'version']

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

/**
 * 清洗单条作答；无 id 的丢弃。
 *
 * 文档 _id 必须按账号隔离（openid 前缀）：attempts 的 get / delete 都按 openid
 * 过滤，但写入若是「谁的 id 都能写」，调用方只要知道别人的 attempt id
 * 就能整doc覆盖那条流水、并把 openid 改成自己的——账号隔离被绕过
 * （评审 P1 4422339084）。加上前缀后，任何写入都只能落进自己的命名空间。
 */
function sanitizeAttempt(a, openid) {
  if (!a || !a.id) return null
  const out = { _id: `${openid}__${String(a.id)}`, openid: openid }
  ATTEMPT_FIELDS.forEach((k) => {
    if (a[k] !== undefined) out[k] = a[k]
  })
  return out
}

/**
 * 读取服务端已有档案快照；不存在返回 null。
 * 事务内读取不存在的文档会抛错，这里统一归一化为 null。
 */
async function readExisting(getDoc) {
  try {
    const got = await getDoc()
    return (got && got.data) || null
  } catch (e) {
    return null
  }
}

exports.main = async (event) => {
  const token = event.token
  if (!token) return { ok: false, error: 'NO_TOKEN' }

  const user = await findByToken(USERS, token)
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
    const incoming = sanitizeStats(event.stats)

    // 事务内「读已有快照 → 合并 → 写入」：并发上传互相累加，而不是后到者覆盖前者。
    // old 版这里是无条件 set()，两台设备各自练习后同步会丢一端的进度。
    const write = async (tx) => {
      const ref = tx.collection('studyStats').doc(openid)
      const existing = await readExisting(() => ref.get())
      const merged = mergeStats(existing, incoming)
      merged._id = openid
      merged.openid = openid
      merged.updatedAt = Date.now()
      await ref.set({ data: merged })
    }

    if (typeof db.runTransaction === 'function') {
      try {
        await db.runTransaction(write)
      } catch (e) {
        return { ok: false, error: 'TX_FAILED' }
      }
    } else {
      // 旧版 SDK 无事务：退化为「读—合并—写」兜底（存在极小并发窗口）
      await write({ collection: (name) => db.collection(name) })
    }

    // 增量 upsert 新增作答流水：同一 _id 重复写入是幂等的，不会重复落库
    const list = Array.isArray(event.attempts) ? event.attempts : []
    const tasks = []
    for (const a of list) {
      const cleanA = sanitizeAttempt(a, openid)
      if (!cleanA) continue
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
