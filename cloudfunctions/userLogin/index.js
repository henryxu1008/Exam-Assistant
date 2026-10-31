/**
 * 云函数 userLogin
 * 入参：{ code, nickName?, avatarUrl?, exam? }
 * 出参：{ ok, openid, token, profile, isNew }
 *
 * 身份来源：
 *   1. 默认使用 cloud.getWXContext().OPENID（云开发原生可信身份，无需 AppSecret）
 *   2. 若在云函数环境变量中配置了 APP_SECRET，则额外用 code 调 jscode2session 换取 openid/unionid
 *
 * 需要在云开发控制台创建集合：users
 */

const cloud = require('wx-server-sdk')
const https = require('https')
const crypto = require('crypto')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const USERS = db.collection('users')

const EDITABLE = ['nickName', 'avatarUrl', 'exam']

/** 字段最长字数，超长截断 */
const FIELD_MAX = { nickName: 32, exam: 40 }

/** 微信接口请求超时（毫秒） */
const REQUEST_TIMEOUT = 5000

/**
 * 只放行白名单字段并清洗：昵称/目标考试截断到上限，头像只接受云存储 fileID。
 * 云函数之间不共享本地模块，此实现需与 userProfile 保持一致。
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

/** code 换 openid/unionid（可选，需配置 APP_SECRET 环境变量） */
function jscode2session(code, appid, secret) {
  return new Promise((resolve) => {
    const url =
      'https://api.weixin.qq.com/sns/jscode2session' +
      `?appid=${appid}&secret=${secret}&js_code=${code}&grant_type=authorization_code`
    const req = https.get(url, (res) => {
      let body = ''
      res.on('data', (d) => {
        body += d
      })
      res.on('end', () => {
        let data = null
        try {
          data = JSON.parse(body)
        } catch (e) {
          // swallow: 响应体不是合法 JSON 时按「换票失败」往下走，
          // 下方 data && !data.errcode && data.openid 校验会因 data 为 null 而拒绝
          data = null
        }
        // 微信接口出错时 HTTP 状态码仍是 200，必须校验 errcode
        resolve(data && !data.errcode && data.openid ? data : null)
      })
    })
    req.on('error', () => resolve(null))
    // 不设超时会一直挂起，耗尽云函数执行时间
    req.setTimeout(REQUEST_TIMEOUT, () => {
      req.destroy()
      resolve(null)
    })
  })
}

/** 会话令牌：随机源必须加密学安全，Math.random() 可被预测 */
function makeToken(openid) {
  return crypto
    .createHash('sha256')
    .update(`${openid}:${Date.now()}:${crypto.randomBytes(32).toString('hex')}`)
    .digest('hex')
}

exports.main = async (event) => {
  const wxCtx = cloud.getWXContext()
  let openid = wxCtx.OPENID
  let unionid = wxCtx.UNIONID || ''

  // 可选：用 code 换取（能拿到 unionid）
  const secret = process.env.APP_SECRET || ''
  if (event.code && secret && wxCtx.APPID) {
    const s = await jscode2session(event.code, wxCtx.APPID, secret)
    if (s && s.openid) {
      openid = s.openid
      unionid = s.unionid || unionid
    }
  }

  if (!openid) return { ok: false, error: 'NO_OPENID' }

  const now = Date.now()
  const token = makeToken(openid)

  const patch = {
    openid: openid,
    unionid: unionid,
    token: token,
    tokenAt: now,
    lastLoginAt: now
  }
  // 入库前清洗，避免任意长度内容或外部 URL 落库
  Object.assign(patch, sanitize(event))

  const exist = await USERS.where({ openid: openid })
    .limit(1)
    .get()

  if (exist.data && exist.data.length) {
    const old = exist.data[0]
    await USERS.doc(old._id).update({ data: patch })
    return {
      ok: true,
      openid: openid,
      token: token,
      profile: publicProfile(Object.assign({}, old, patch)),
      isNew: false
    }
  }

  const doc = Object.assign(
    {
      openid: openid,
      unionid: unionid,
      nickName: '',
      avatarUrl: '',
      exam: '',
      createdAt: now
    },
    patch
  )
  const add = await USERS.add({ data: doc })
  return {
    ok: true,
    openid: openid,
    token: token,
    profile: publicProfile(doc),
    isNew: true
  }
}
