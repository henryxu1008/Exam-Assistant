/**
 * 云函数 bankSync
 * 入参：{ action: 'get' | 'set', token?, bank?, force? }
 * 出参：{ ok, bank? }
 *
 * action=get：返回云端题库（questions 集合 _id='bank' 文档）；不存在返回 { ok:true, bank:null }。
 *   ——题库是全体用户共享的公开内容，读取不需要身份。
 *
 * action=set：写入/覆盖云端题库。题库内容会下发给所有用户，属于高权限写操作，
 *   必须满足以下全部条件，否则拒绝：
 *   1) 调用方必须持有有效登录令牌（token 能查到用户且在有效期内）——拒绝匿名直调；
 *   2) 云端尚无题库时：任何已登录调用方都可完成一次性初始化；
 *   3) 云端已有题库时：仅 appConfig.admins 中登记的管理员可覆盖，且必须显式 force=true。
 *   4) 写入前重新读取文档确认存在性，保证「仅初始化一次」的判定与写入之间不被并发穿透。
 *
 * 云端题库结构：{ _id:'bank', manifest:{subjects:[...]}, questions:{ <key>: [题目...] } }
 * 与 utils/bank 的静态结构保持一致，前端拉到后整体替换数据源，无需改动查询逻辑。
 *
 * 依赖集合：users（校验令牌）、questions（题库）、appConfig（管理员名单，可选）
 */

const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const BANK = db.collection('questions')
const USERS = db.collection('users')
const CONFIG = db.collection('appConfig')

/** 令牌有效期，与小程序端 utils/user.js 的 TOKEN_TTL 保持一致 */
const TOKEN_TTL = 30 * 24 * 60 * 60 * 1000

/** 题库写操作允许的顶层字段（其余一律丢弃，防止写入任意字段） */
const BANK_FIELDS = ['manifest', 'questions']

/** 题库文档是否已存在（不存在才允许一次性初始化） */
async function bankExists() {
  try {
    const res = await BANK.doc('bank').get()
    return !!(res && res.data)
  } catch (e) {
    // 文档不存在视为尚未种子化
    return false
  }
}

/** 按令牌查找用户；无令牌 / 查不到 / 已过期均返回 null（云函数间不共享本地模块） */
async function findByToken(token) {
  if (!token) return null
  const res = await USERS.where({ token: token }).limit(1).get()
  const doc = res.data && res.data.length ? res.data[0] : null
  if (!doc) return null
  if (!doc.tokenAt || Date.now() - doc.tokenAt > TOKEN_TTL) return null
  return doc
}

/**
 * 管理员 openid 名单：优先取 appConfig.admins 文档（可在控制台维护，无需改代码/重新部署），
 * 回落云函数环境变量 BANK_ADMINS（逗号分隔）。两者都未配置时没有任何管理员，
 * 即「题库一旦建立，任何端上调用都无法再覆盖」。
 */
async function getAdminOpenids() {
  const fromEnv = String(process.env.BANK_ADMINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  try {
    const res = await CONFIG.doc('admins').get()
    const list = res && res.data && Array.isArray(res.data.openids) ? res.data.openids : []
    return fromEnv.concat(list.map((s) => String(s).trim()).filter(Boolean))
  } catch (e) {
    // 未配置管理员名单
    return fromEnv
  }
}

function sanitizeBank(payload) {
  const src = payload && typeof payload === 'object' ? payload : {}
  const out = {}
  BANK_FIELDS.forEach((k) => {
    if (src[k] !== undefined) out[k] = src[k]
  })
  return out
}

exports.main = async (event) => {
  const action = event.action || 'get'

  if (action === 'get') {
    try {
      const res = await BANK.doc('bank').get()
      return { ok: true, bank: res.data || null }
    } catch (e) {
      // 文档不存在视为尚未种子化
      return { ok: true, bank: null }
    }
  }

  if (action === 'set') {
    // 题库会全量下发给所有用户，写入是高权限操作，一律要求已登录身份，拒绝匿名直调。
    const token = event.token
    if (!token) return { ok: false, error: 'NO_TOKEN' }
    const user = await findByToken(token)
    if (!user) return { ok: false, error: 'INVALID_TOKEN' }

    const bank = sanitizeBank(event.bank)
    if (!bank.manifest || !bank.questions) return { ok: false, error: 'BAD_BANK' }

    const data = Object.assign({ _id: 'bank', updatedAt: Date.now(), updatedBy: user.openid }, bank)

    // force 覆盖既有题库：仅管理员，且必须显式声明，避免端上误触全量替换
    if (event.force === true) {
      const isAdmin = (await getAdminOpenids()).indexOf(user.openid) !== -1
      if (!isAdmin) return { ok: false, error: 'NOT_ADMIN' }
      await BANK.doc('bank').set({ data: data })
      return { ok: true }
    }

    // 一次性初始化：在事务内「先确认不存在再写入」。
    // 并发的多个客户端同时首次种入时，后到的会在事务内看到文档已存在而被拒绝，
    // 不会出现互相覆盖或重复写入。
    if (typeof db.runTransaction === 'function') {
      try {
        return await db.runTransaction(async (tx) => {
          const ref = tx.collection('questions').doc('bank')
          let existing = null
          try {
            const got = await ref.get()
            existing = got && got.data
          } catch (e) {
            existing = null // 事务内读取不存在的文档会抛错，视为尚未初始化
          }
          if (existing) return { ok: false, error: 'BANK_EXISTS' }
          await ref.set({ data: data })
          return { ok: true }
        })
      } catch (e) {
        return { ok: false, error: 'TX_FAILED' }
      }
    }

    // 旧版 SDK 无事务：退化为「写前复查」（窗口极小，仅作兜底）
    if (await bankExists()) return { ok: false, error: 'BANK_EXISTS' }
    await BANK.doc('bank').set({ data: data })
    return { ok: true }
  }

  return { ok: false, error: 'BAD_ACTION' }
}
