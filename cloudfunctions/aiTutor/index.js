/**
 * 云函数 aiTutor —— AI 学习助教（大模型接入骨架）
 *
 * 入参：{ messages, subject }
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

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
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
 * 预算护栏：按日在云数据库集合 aiTutorUsage 累计上游调用次数，
 * 超过当日上限（CONFIG.dailyCallCap，可由环境变量 AI_TUTOR_DAILY_CAP 覆盖）时返回 false，
 * 让端上回落本地引擎，避免产生不可控费用。计数异常（如集合未建）时放行，不阻断正常答疑。
 */
async function withinBudget() {
  const cap = Number(CONFIG.dailyCallCap) || 0
  if (!cap || cap <= 0) return true
  try {
    const res = await USAGE.where({ date: todayKey() }).limit(1).get()
    const doc = res.data && res.data[0]
    return (doc ? doc.count : 0) < cap
  } catch (e) {
    return true
  }
}

/** 成功调用上游大模型后累计当日用量；失败静默忽略，不影响主流程 */
async function addUsage() {
  const key = todayKey()
  try {
    const res = await USAGE.where({ date: key }).limit(1).get()
    const doc = res.data && res.data[0]
    if (doc) {
      await USAGE.doc(doc._id).update({ data: { count: db.command.inc(1), updatedAt: Date.now() } })
    } else {
      await USAGE.add({ data: { date: key, count: 1, createdAt: Date.now(), updatedAt: Date.now() } })
    }
  } catch (e) {
    // 计数失败不影响主流程
  }
}

exports.main = async (event) => {
  if (!CONFIG.enabled) return { content: null, disabled: true }
  if (!(await withinBudget())) return { content: null, disabled: true, reason: 'BUDGET' }

  const { clean, subj } = sanitize(event.messages, event.subject)
  if (!clean.length) return { content: null, disabled: true }

  const content = await callLLM(clean, subj)
  // 仅在有真实上游响应后累计用量，用于预算护栏
  if (content) addUsage().catch(() => {})
  // 只回传 content，其余内部字段一律不下发到端上
  return { content: content || null }
}
