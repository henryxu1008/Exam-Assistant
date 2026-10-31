/**
 * 云函数 aiTutor —— AI 学习助教（大模型接入骨架）
 *
 * 入参：{ token, messages, subject }
 *   messages: [{ role: 'user'|'assistant'|'system', content: string }]
 *   subject:  当前科目（来自端上 store.getCurrentSubject()，使回答只讲该科目）
 * 出参：{ content }
 *   content 为 null 时，端上 utils/ai.js 的 requestLLM 会自动回落到本地规则引擎，
 *   页面逻辑无需关心是否启用大模型。
 *
 * 启用步骤（决策点：模型与预算——默认关闭，避免产生不可控费用）：
 *   1. 在云开发控制台为 aiTutor 配置环境变量：
 *        AI_TUTOR_ENABLED=true
 *        LLM_ENDPOINT=<OpenAI 兼容的 chat/completions 完整 URL>
 *        LLM_API_KEY=<上游密钥>
 *        LLM_MODEL=<模型名，可选>
 *   2. 把端上 utils/ai.js 的 REMOTE_LLM.enabled 改为 true。
 *
 * 安全约定（与 userLogin / userProfile 一致）：入参先清洗再使用，
 * 只回传 content，不泄露任何内部状态。
 */

const cloud = require('wx-server-sdk')
const https = require('https')
const { findByToken } = require('./auth.js')
const { readOptionalDoc } = require('./db-error.js')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const USERS = db.collection('users')
const USAGE = db.collection('aiTutorUsage') // 按日累计上游调用次数，供预算护栏使用

const CONFIG = {
  // 默认关闭：未显式开启或缺失密钥时，端上回落本地引擎
  enabled: (process.env.AI_TUTOR_ENABLED || 'false') === 'true',
  // 上游大模型：OpenAI 兼容的 chat/completions 接口（可换成任意兼容实现）
  endpoint: process.env.LLM_ENDPOINT || '',
  model: process.env.LLM_MODEL || 'gpt-4o-mini',
  apiKey: process.env.LLM_API_KEY || '',
  // 安全上限
  maxTokens: 800,
  temperature: 0.5,
  maxHistory: 12, // 最多携带的历史轮次
  maxCharsPerMsg: 2000, // 单条消息最长字符数
  userDailyCallCap: Number(process.env.AI_TUTOR_USER_DAILY_CAP || 20),
  dailyCallCap: Number(process.env.AI_TUTOR_DAILY_CAP || 200) // 每日上游调用次数上限，可由环境变量 AI_TUTOR_DAILY_CAP 覆盖
}

/** 上游请求超时（毫秒）：不设超时会一直挂起，耗尽云函数执行时间 */
const UPSTREAM_TIMEOUT = 8000

/**
 * 入参清洗：只保留白名单角色，截断超长，控制条数，
 * 避免任意字段直接透传到上游（角色伪造 / 超长注入 / 历史爆炸）。
 */
function sanitize(messages, subject) {
  const list = Array.isArray(messages) ? messages : []
  const clean = list
    .filter(
      (m) => m && typeof m.content === 'string' && ['user', 'assistant', 'system'].indexOf(m.role) > -1
    )
    .slice(-CONFIG.maxHistory)
    .map((m) => ({ role: m.role, content: m.content.slice(0, CONFIG.maxCharsPerMsg) }))
  const subj = typeof subject === 'string' && subject ? subject.slice(0, 40) : ''
  return { clean, subj }
}

/** 系统提示：约束模型身份与「只讲当前科目」的口径 */
function systemPrompt(subject) {
  const scope = subject
    ? `用户当前正在学习「${subject}」。所有讲解、举例、学习计划都只围绕该科目，不要泛泛而谈或混入其它科目内容。`
    : ''
  return [
    '你是公务员考试（行测）的 AI 学习助教，基于用户的真实答题记录给出建议。',
    '回答要简洁、可执行，多用分点；涉及具体题目时说明考点与解题思路。',
    scope,
    '不要编造题目、考点或数据；拿不准就如实说明，并引导用户回到应用内对应模块。'
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * 调用上游大模型（OpenAI 兼容）。任何异常都回落为 null，不向外抛错。
 * 替换模型/厂商时只改 CONFIG.endpoint / model，以及本函数内的协议细节即可。
 */
function callLLM(messages, subject) {
  return new Promise((resolve) => {
    if (!CONFIG.endpoint || !CONFIG.apiKey) {
      resolve(null) // 未配置：回落本地
      return
    }
    let url
    try {
      url = new URL(CONFIG.endpoint)
    } catch (e) {
      // swallow: endpoint 不是合法 URL，按「未配置上游」处理并回落本地作答
      resolve(null)
      return
    }
    const payload = JSON.stringify({
      model: CONFIG.model,
      temperature: CONFIG.temperature,
      max_tokens: CONFIG.maxTokens,
      messages: [{ role: 'system', content: systemPrompt(subject) }].concat(messages)
    })

    const req = https.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${CONFIG.apiKey}`,
          'Content-Length': Buffer.byteLength(payload)
        }
      },
      (res) => {
        let body = ''
        res.on('data', (d) => {
          body += d
        })
        res.on('end', () => {
          if (res.statusCode !== 200) {
            resolve(null)
            return
          }
          let data = null
          try {
            data = JSON.parse(body)
          } catch (e) {
            // swallow: 流里夹杂非 JSON 的保活行/脏数据时跳过该行继续解析，
            // 最终拿不到 choices 就回落本地作答
            data = null
          }
          const choice = data && data.choices && data.choices[0]
          const content = choice && choice.message && choice.message.content
          resolve(typeof content === 'string' ? content.trim() : null)
        })
      }
    )
    req.on('error', () => resolve(null))
    req.setTimeout(UPSTREAM_TIMEOUT, () => {
      req.destroy()
      resolve(null)
    })
    req.write(payload)
    req.end()
  })
}

/** 当天日期 key（本地时区，格式 yyyy-mm-dd） */
function todayKey() {
  const d = new Date()
  const y = d.getFullYear()
  const m = `${d.getMonth() + 1}`.padStart(2, '0')
  const day = `${d.getDate()}`.padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * 每日固定 _id + 用户分区，在事务中共同预约全局/个人配额。
 * 旧版随机 ID 计数在首次创建时汇总；失败不放行付费上游，端上仍可本地答疑。
 */
async function reserveDailyQuota(openid) {
  const cap = CONFIG.dailyCallCap
  const userCap = CONFIG.userDailyCallCap
  if (!Number.isSafeInteger(cap) || cap < 0 || !Number.isSafeInteger(userCap) || userCap <= 0) return false
  if (typeof db.runTransaction !== 'function') return false
  const key = todayKey()
  try {
    const existing = await readOptionalDoc(() => USAGE.doc(key).get())
    if (!existing) {
      // 旧随机 ID 文档只在创建每日总计数前汇总，不把新用户分区重复计入。
      let count = 0
      let offset = 0
      let page
      do {
        const legacy = await USAGE.where({ date: key }).orderBy('_id', 'asc').skip(offset).limit(100).get()
        if (!legacy || !Array.isArray(legacy.data)) throw new Error('INVALID_USAGE_RESPONSE')
        page = legacy.data
        page.forEach((row) => { if (row._id !== key && row.scope !== 'user') count += Math.max(0, Number(row.count) || 0) })
        offset += page.length
      } while (page.length === 100)
      try { await USAGE.add({ data: { _id: key, date: key, count, updatedAt: Date.now() } }) } catch (e) {
        // swallow: 并发创建由唯一 ID 约束裁决；仍须事务内确认文档存在和配额充足。
      }
    }
    return await db.runTransaction(async (tx) => {
      const usage = tx.collection('aiTutorUsage')
      const globalRef = usage.doc(key)
      const userRef = usage.doc(`user:${key}:${openid}`)
      const global = await readOptionalDoc(() => globalRef.get())
      const mine = await readOptionalDoc(() => userRef.get())
      if (!global || !Number.isSafeInteger(global.count) || global.count < 0) return false
      const used = mine ? mine.count : 0
      if (!Number.isSafeInteger(used) || used < 0 || used >= userCap || (cap > 0 && global.count >= cap)) return false
      // 用户和全局名额共同预约，任一限制失败均不消耗另一份名额。
      await userRef.set({ data: { scope: 'user', day: key, count: used + 1, updatedAt: Date.now() } })
      await globalRef.set({ data: { date: key, count: global.count + 1, updatedAt: Date.now() } })
      return true
    })
  } catch (e) {
    // swallow: 鉴权后的配额存储故障一律拒绝付费调用，客户端仍可使用本地答疑。
    return false
  }
}

exports.main = async (event = {}) => {
  if (!CONFIG.enabled) return { content: null, disabled: true }
  let user
  try { user = await findByToken(USERS, event.token) } catch (e) {
    // swallow: 身份存储不可用时拒绝远端调用，由客户端回落本地引擎。
    return { content: null, disabled: true, reason: 'AUTH_UNAVAILABLE' }
  }
  if (!user) return { content: null, disabled: true, reason: 'AUTH' }
  const { clean, subj } = sanitize(event.messages, event.subject)
  if (!clean.length) return { content: null, disabled: true }
  // 原子预约配额：成功才调用上游，避免并发绕过每日上限（评审 P2：Reserve daily AI quota atomically before calling upstream）
  if (!(await reserveDailyQuota(user.openid))) return { content: null, disabled: true, reason: 'BUDGET' }

  const content = await callLLM(clean, subj)
  // 只回传 content，其余内部字段一律不下发到端上
  return { content: content || null }
}
