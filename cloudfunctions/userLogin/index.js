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

/** code 换 openid/unionid（可选，需配置 APP_SECRET 环境变量） */
function jscode2session(code, appid, secret) {
  return new Promise((resolve) => {
    const url =
      'https://api.weixin.qq.com/sns/jscode2session' +
      `?appid=${appid}&secret=${secret}&js_code=${code}&grant_type=authorization_code`
    https
      .get(url, (res) => {
        let body = ''
        res.on('data', (d) => {
          body += d
        })
        res.on('end', () => {
          try {
            resolve(JSON.parse(body))
          } catch (e) {
            resolve(null)
          }
        })
      })
      .on('error', () => resolve(null))
  })
}

function makeToken(openid) {
  return crypto
    .createHash('sha256')
    .update(`${openid}:${Date.now()}:${Math.random()}`)
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
  if (event.nickName !== undefined) patch.nickName = event.nickName
  if (event.avatarUrl !== undefined) patch.avatarUrl = event.avatarUrl
  if (event.exam !== undefined) patch.exam = event.exam

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
      profile: Object.assign({}, old, patch),
      isNew: false
    }
  }

  const doc = Object.assign(
    {
      openid: openid,
      unionid: unionid,
      nickName: event.nickName || '',
      avatarUrl: event.avatarUrl || '',
      exam: event.exam || '',
      createdAt: now
    },
    patch
  )
  const add = await USERS.add({ data: doc })
  return {
    ok: true,
    openid: openid,
    token: token,
    profile: Object.assign({ _id: add._id }, doc),
    isNew: true
  }
}
