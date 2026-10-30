/**
 * 云函数 bankSync
 * 入参：{ action: 'get' | 'set', token?, bank?, force? }
 * 出参：{ ok, bank? }
 *
 * action=get：返回云端题库（questions 集合 _id='bank' 文档）；不存在返回 { ok:true, bank:null }。
 *   ——题库是全体用户共享的公开内容，读取不需要身份。
 *
 * action=set：写入/覆盖云端题库。题库内容会下发给所有用户，属于高权限写操作，
 *   必须满足以下全部条件，否则拒绝（评审 P1 4422245843 同类的服务端鉴权）：
 *   1) 调用方必须持有有效登录令牌（token 能查到用户且在有效期内）——拒绝匿名直调；
 *   2) 云端尚无题库时：任何已登录调用方都可完成一次性初始化；
 *   3) 云端已有题库时：仅管理员可覆盖，且必须显式 force=true。
 *   4) 「不存在才写」的判定与写入放在同一个事务里，避免并发重复/互相覆盖。
 *
 * 云端题库结构：{ _id:'bank', manifest:{subjects:[...]}, questions:{ <key>: [题目...] } }
 * 与 utils/bank 的静态结构保持一致，前端拉到后整体替换数据源，无需改动查询逻辑。
 *
 * 依赖集合：users（校验令牌）、questions（题库）、appConfig（管理员名单，可选）。
 */

const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const BANK = db.collection('questions')
const USERS = db.collection('users')
const CONFIG = db.collection('appConfig')

/** 令牌校验 + 管理员判定；部署副本随本函数一起上传 */
const { findByToken, verifyAdminSecret, getAdminOpenids } = require('./auth.js')

/** 题库写操作允许的顶层字段（其余一律丢弃，防止写入任意字段） */
const BANK_FIELDS = ['manifest', 'questions']

/** 以管理员密钥发起、无登录身份时记录的写入者标识 */
const ADMIN_ACTOR_ID = 'admin'

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
    const bank = sanitizeBank(event.bank)
    if (!bank.manifest || !bank.questions) return { ok: false, error: 'BAD_BANK' }

    // 身份判定（两条途径二选一，任一成立即可写入）：
    //   - 管理员密钥：控制台运行/运维脚本没有登录身份，只能用它；
    //   - 有效登录令牌：端上调用，再按管理员名单判定是否可覆盖既有题库。
    const admin = verifyAdminSecret(event)
    const providedSecret = event.adminSecret !== undefined && event.adminSecret !== null && event.adminSecret !== ''
    // 显式带了密钥却不对：直接判定无权限，不回退到令牌路径
    if (providedSecret && !admin.ok) return { ok: false, error: 'NOT_ADMIN' }
    const user = admin.ok ? null : await findByToken(USERS, event.token)
    if (!admin.ok && !user) {
      return { ok: false, error: event.token ? 'INVALID_TOKEN' : 'NO_TOKEN' }
    }
    const isAdmin = admin.ok || (await getAdminOpenids(CONFIG)).indexOf(user.openid) !== -1
    const actorId = admin.ok ? ADMIN_ACTOR_ID : user.openid

    const data = Object.assign({ _id: 'bank', updatedAt: Date.now(), updatedBy: actorId }, bank)
    const exists = await bankExists()

    // 覆盖运营已维护的题库：必须显式 force，且调用方具备管理员身份
    if (exists) {
      if (event.force !== true) return { ok: false, error: 'BANK_EXISTS' }
      if (!isAdmin) return { ok: false, error: 'NOT_ADMIN' }
      await BANK.doc('bank').set({ data: data })
      return { ok: true }
    }

    // 一次性初始化：判定与写入放进同一事务，
    // 并发的多个客户端同时首次种入时，后到的会在事务内看到文档已存在而被拒绝。
    const write = async (tx) => {
      const ref = tx.collection('questions').doc('bank')
      let existing = null
      try {
        const got = await ref.get()
        existing = got && got.data
      } catch (e) {
        existing = null // 事务内读取不存在的文档会抛错
      }
      if (existing) return { ok: false, error: 'BANK_EXISTS' }
      await ref.set({ data: data })
      return { ok: true }
    }

    if (typeof db.runTransaction === 'function') {
      try {
        return await db.runTransaction(write)
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
