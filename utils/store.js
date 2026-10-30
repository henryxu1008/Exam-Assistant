/**
 * utils/store.js
 * 本地数据仓储：答题记录 / 每日统计 / 学习设置 / AI 对话历史
 * 说明：不依赖任何后端，全部通过 wx.setStorageSync 持久化。
 */

const bank = require('./questions.js')
const config = require('./config.js')

const STORAGE_KEY = 'exam_quiz_data_v1'

/** 登录会话存储键，与 utils/user.js 保持一致（避免 require user 造成循环依赖） */
const SESSION_KEY = 'exam_quiz_session_v1'

/** attempts 流水已上传到云端的光标（按作用域隔离），值 = 已同步的本地 attempts 下标 */
const ATTEMPT_CURSOR_KEY = 'exam_quiz_attempt_cursor_v1'

/** 当前数据结构版本 */
const CURRENT_VERSION = 3

/**
 * 迁移函数表：MIGRATIONS[n] 负责把版本 n 的数据升级到 n + 1
 * 约定：提升 CURRENT_VERSION 前必须先补对应的迁移函数，否则等于清空用户数据
 */
const MIGRATIONS = {
  // v1 -> v2：日统计增加科目维度。历史作答无从反推当天各科目分布，
  // 迁移后各科目当天的统计为 0，此后正常累计
  1: (data) => {
    const daily = {}
    Object.keys(data.daily || {}).forEach((key) => {
      const d = data.daily[key]
      daily[key] = d ? Object.assign({}, d, { subjects: {} }) : d
    })
    return Object.assign({}, data, { daily: daily, version: 2 })
  },
  // v2 -> v3：引入 AnswerAttempt 不可变作答日志与练习 Session 状态机（Issue 2/3）。
  // 旧聚合记录（records）保留为派生来源；不可变流水无法由聚合反推，不伪造历史。
  2: (data) => {
    const next = Object.assign({}, data)
    if (!Array.isArray(next.attempts)) next.attempts = []
    if (!next.practiceSession) next.practiceSession = null
    next.version = 3
    return next
  }
}

/** 生成带前缀的唯一 ID（会话 / 作答 / 客户端操作） */
function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/** 掌握等级对应的复习间隔（天），艾宾浩斯式简化版 */
const REVIEW_INTERVALS = [0, 1, 2, 4, 7, 15]

/** 连续答对该天数后，自动移出错题本 */
const MASTER_DAYS = 3

const DAY = 24 * 60 * 60 * 1000

function getDefaultState() {
  return {
    version: CURRENT_VERSION,
    records: {}, // { qid: Record } 由 attempts 派生维护的聚合
    attempts: [], // 不可变作答流水（AnswerAttempt），只追加不覆盖
    practiceSession: null, // 当前练习 Session 状态机实例
    daily: {}, // { '2026-10-29': DailyStat }
    settings: {
      dailyGoal: 30,
      autoNext: true,
      aiExplain: true,
      currentSubject: ''
    },
    aiMessages: [],
    createdAt: Date.now()
  }
}

let state = null

/**
 * 用户隔离作用域：本地数据按 openid 命名空间存储，避免账号 A 登出、账号 B 登录后
 * 读取到 A 的答题记录 / AI 对话（Issue 1）。未登录或无法获取 openid 时回落 'anon'。
 * 切换账号必须调用 setUserScope 重置内存态并切到对应 key。
 */
let userScope = 'anon'

/**
 * 云端同步代次：切换作用域或清空数据即递增（A→B→A 也算新代次，不能只比较 openid）。
 * 云端请求发起后代次 / 作用域 / 令牌任一变化，回包一律丢弃，
 * 避免把账号 A 的档案并入账号 B 的内存态并随之上传（评审 P1）。
 */
let cloudSyncGeneration = 0

// 当前进程内的对话代次：账号切换或删除历史即递增，阻止缓存页面和旧异步回复复用。
// 不随普通消息追加变化；A→B→A 也必须产生新代次，不能只比较 openid。
let aiConversationVersion = 0

function getAiConversationVersion() {
  return aiConversationVersion
}

function scopeKey() {
  return `${STORAGE_KEY}__${userScope}`
}

/** 读取当前隔离作用域（openid 或 'anon'） */
function getUserScope() {
  return userScope
}

/**
 * 切换数据存储作用域（通常在登录成功后用 openid、登出时用 null/'anon' 调用）。
 * 会重置内存态并从新 key 重新加载；首次从旧版全局 key 迁移数据（仅一次，避免丢数据）。
 */
function setUserScope(openid) {
  const next = openid && String(openid).length ? String(openid) : 'anon'
  if (next === userScope) return userScope // 同作用域不重置内存态、不重复迁移
  // 切换前先把当前作用域的待落盘数据同步写入，避免节流定时器在 state 置空后丢失
  // （评审 P2：Flush pending changes before switching user scopes）
  if (state) {
    try {
      wx.setStorageSync(scopeKey(), state)
    } catch (e) {
      /* 忽略写入失败 */
    }
    pushToCloud() // 切换账号前把旧账号的学习档案上传云端
  }
  userScope = next
  state = null
  aiConversationVersion += 1
  // 作用域已变，作废所有在途云端请求（其回包属于旧账号）
  cloudSyncGeneration += 1
  // 切换到真实账号后，允许下次 load 再次从云端拉取该账号的档案
  if (next !== 'anon') bootPulled = false
  // 一次性迁移：旧版用全局单一 key，升级后首次进入该作用域时把全局数据搬过来，
  // 再删除旧 key；多账号同设备时首个登录用户承接历史数据（与升级前单租户行为一致）。
  const legacy = STORAGE_KEY
  if (userScope !== 'anon') {
    try {
      const rawLegacy = wx.getStorageSync(legacy)
      const rawScoped = wx.getStorageSync(scopeKey())
      if (rawLegacy && typeof rawLegacy === 'object' && (!rawScoped || rawScoped === '')) {
        wx.setStorageSync(scopeKey(), rawLegacy)
        wx.removeStorageSync(legacy)
      } else if (rawLegacy && typeof rawLegacy === 'object') {
        wx.removeStorageSync(legacy)
      }
    } catch (e) {
      /* 迁移失败不影响新会话 */
    }
  }
  return userScope
}

/** 获取今日日期 key */
function todayKey(date) {
  const d = date || new Date()
  const y = d.getFullYear()
  const m = `${d.getMonth() + 1}`.padStart(2, '0')
  const day = `${d.getDate()}`.padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 取 yyyy-mm-dd 的月日形式 */
function shortDate(key) {
  if (!key) return ''
  const parts = String(key).split('-')
  return parts.length === 3 ? `${parts[1]}-${parts[2]}` : key
}

/** 日期 key 转时间戳（按本地时区解析，避免 UTC 偏移） */
function toTime(key) {
  const p = String(key || '').split('-')
  if (p.length !== 3) return NaN
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])).getTime()
}

/** 两个日期 key 相差天数（b - a） */
function dayDiff(a, b) {
  const ta = toTime(a)
  const tb = toTime(b)
  if (isNaN(ta) || isNaN(tb)) return NaN
  return Math.round((tb - ta) / DAY)
}

/** 把今日并入「连续答对天」序列：同日不变、相邻日累加、中断则重置 */
function nextRightDays(days, key) {
  const list = (Array.isArray(days) ? days : []).slice(-MASTER_DAYS)
  const last = list[list.length - 1]
  if (last === key) return list
  if (last && dayDiff(last, key) === 1) return list.concat([key]).slice(-MASTER_DAYS)
  return [key]
}

/**
 * 按版本链升级本地数据，无法升级到当前版本时返回 null（由调用方回落默认状态）
 * 约定：提升 CURRENT_VERSION 前必须先补上对应的迁移函数，否则等于清空用户数据
 */
function migrate(raw) {
  let data = raw
  let v = Number(data && data.version) || 0
  while (v < CURRENT_VERSION && MIGRATIONS[v]) {
    data = MIGRATIONS[v](data)
    v += 1
  }
  return v === CURRENT_VERSION ? data : null
}

function load() {
  if (state) return state
  try {
    const raw = wx.getStorageSync(scopeKey())
    state = migrate(raw) || getDefaultState()
  } catch (e) {
    state = getDefaultState()
  }
  if (!state.records) state.records = {}
  if (!state.daily) state.daily = {}
  if (!state.settings) state.settings = getDefaultState().settings
  if (!Array.isArray(state.aiMessages)) state.aiMessages = []
  if (!Array.isArray(state.attempts)) state.attempts = []
  // 启动后首次（且已登录）尝试从云端拉取一次学习档案
  if (!bootPulled && isLogged()) pullFromCloud()
  return state
}

/** 写盘节流窗口（毫秒）：连续作答时合并为至多每窗口一次 */
const FLUSH_INTERVAL = 800

let flushTimer = null
let lastFlushAt = 0
let dirty = false

/** 立即落盘：异步 API，避免全量序列化阻塞渲染 */
function flush() {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  if (!dirty || !state) return
  dirty = false
  lastFlushAt = Date.now()
  wx.setStorage({
    key: scopeKey(),
    data: state,
    success: () => pushToCloud(), // 本地落盘成功后增量同步到云端
    fail: (e) => console.error('[store] 持久化失败', e)
  })
}

/* ============================================================
 * 云端同步（MVP）：本地为主、云端备份，换设备可延续学习进度。
 * - 同步派生/聚合数据（records/daily/settings/practiceSession/aiMessages）到 studyStats 单文档。
 * - 同步原始作答流水 attempts 到独立集合 attempts（每条一个文档，_id = attempt.id），
 *   增量 upsert（按本地光标只传新增），避免单文档过大与并发覆盖。
 * - 双向合并：pull 时与云端按时间戳 / 日期 / id 并集合并（见 mergeStats），多端作答不互丢；
 *   合并结果回写本地并上传云端，最终两端收敛一致。
 * - 测试沙箱无 wx.cloud，hasCloud() 为 false，以下逻辑全部安全跳过。
 * ============================================================ */

function hasCloud() {
  // 仅在 wx.cloud 存在、callFunction 可用且已完成 wx.cloud.init() 时才视为可调用，
  // 避免在小程序端 init 之前误触发云端调用而报 "Cloud API isn't enabled"。
  return !!wx.__cloudReady && !!wx.cloud && typeof wx.cloud.callFunction === 'function'
}

/**
 * 调用云函数并以回调方式处理结果。
 * wx.cloud.callFunction 在支持回调的同时还会返回一个 Promise；我们只用回调消费结果，
 * 若不处理该 Promise 的拒绝，会产生「未处理的 Promise 拒绝」——真实运行可能崩溃，
 * 测试中会被判定为用例失败。这里统一吞掉拒绝（失败已由 fail 回调处理）。
 */
function callCloud(opts) {
  const p = wx.cloud.callFunction(opts)
  if (p && typeof p.then === 'function') p.then(null, () => {})
  return p
}

function getToken() {
  try {
    const s = wx.getStorageSync(SESSION_KEY)
    return (s && s.token) || ''
  } catch (e) {
    return ''
  }
}

/** 当前会话绑定的 openid；未登录或会话已清空时返回 '' */
function getSessionOpenid() {
  try {
    const s = wx.getStorageSync(SESSION_KEY)
    return (s && s.openid) || ''
  } catch (e) {
    return ''
  }
}

function isLogged() {
  try {
    const s = wx.getStorageSync(SESSION_KEY)
    return !!(s && s.logged && s.token)
  } catch (e) {
    return false
  }
}

/** 启动后只尝试一次云端拉取 */
let bootPulled = false

/**
 * 双向合并本地与云端学习档案（纯函数，便于单测）。
 * 策略：
 *  - records：按 qid 取 lastAt 较新的一方（无 lastAt 的一方被另一方覆盖）；
 *  - daily：按日期 key 取并集，同日各指标取较大值（total/correct/timeMs），
 *           chapters/subjects 取键并集、同键指标取较大；
 *  - practiceSession：取 createdAt 较新的一方，均无则保留非 null 的；
 *  - aiMessages：按 time 去重取并集（云端在前、本地在后）；
 *  - settings：云端优先（多端冲突极少，且保证换设备后设置一致）；
 *  - version：取较大值。
 * @returns {Object} 合并后的完整 state（缺失字段用默认值补齐）
 */
function mergeStats(local, remote) {
  const def = getDefaultState()
  const L = local || {}
  const R = remote || {}
  const out = Object.assign({}, def, L)

  // records：按 qid 取 lastAt 较新方
  const records = Object.assign({}, R.records || {})
  Object.keys(L.records || {}).forEach((id) => {
    const lr = L.records[id]
    const rr = records[id]
    if (!rr) { records[id] = lr; return }
    if ((lr.lastAt || 0) >= (rr.lastAt || 0)) records[id] = lr
  })
  out.records = records

  // daily：按日期并集，同日指标取较大
  const daily = Object.assign({}, R.daily || {})
  Object.keys(L.daily || {}).forEach((key) => {
    const ld = L.daily[key]
    const rd = daily[key]
    if (!rd) { daily[key] = ld; return }
    daily[key] = mergeDaily(ld, rd)
  })
  out.daily = daily

  // practiceSession：取较新方
  const ls = L.practiceSession
  const rs = R.practiceSession
  if (ls && rs) out.practiceSession = (ls.createdAt || 0) >= (rs.createdAt || 0) ? ls : rs
  else out.practiceSession = ls || rs || null

  // aiMessages：按 time 去重取并集
  const seen = {}
  const ai = []
  ;(R.aiMessages || []).concat(L.aiMessages || []).forEach((m) => {
    const t = m && m.time
    if (t == null) { ai.push(m); return }
    if (seen[t]) return
    seen[t] = true
    ai.push(m)
  })
  out.aiMessages = ai

  // attempts：按 id 去重取并集（云端在前、本地在后）；不可变流水，按 id 并集即可
  const seenA = {}
  const attempts = []
  ;(R.attempts || []).concat(L.attempts || []).forEach((a) => {
    const id = a && a.id
    if (id == null) { attempts.push(a); return }
    if (seenA[id]) return
    seenA[id] = true
    attempts.push(a)
  })
  out.attempts = attempts

  // settings：云端优先
  out.settings = Object.assign({}, def.settings, L.settings || {}, R.settings || {})

  // version：取较大
  out.version = Math.max(L.version || 0, R.version || 0, def.version)
  return out
}

/** 合并单日统计：同日各指标取较大值，chapters/subjects 取键并集、同键指标取较大 */
function mergeDaily(ld, rd) {
  const chapters = Object.assign({}, rd.chapters || {})
  Object.keys(ld.chapters || {}).forEach((c) => {
    const lc = ld.chapters[c]
    const rc = chapters[c]
    if (!rc) { chapters[c] = lc; return }
    chapters[c] = {
      total: Math.max(lc.total || 0, rc.total || 0),
      correct: Math.max(lc.correct || 0, rc.correct || 0)
    }
  })
  const subjects = Object.assign({}, rd.subjects || {})
  Object.keys(ld.subjects || {}).forEach((s) => {
    const ls = ld.subjects[s]
    const rs = subjects[s]
    if (!rs) { subjects[s] = ls; return }
    subjects[s] = {
      total: Math.max(ls.total || 0, rs.total || 0),
      correct: Math.max(ls.correct || 0, rs.correct || 0),
      timeMs: Math.max(ls.timeMs || 0, rs.timeMs || 0)
    }
  })
  return {
    date: ld.date || rd.date,
    total: Math.max(ld.total || 0, rd.total || 0),
    correct: Math.max(ld.correct || 0, rd.correct || 0),
    timeMs: Math.max(ld.timeMs || 0, rd.timeMs || 0),
    chapters: chapters,
    subjects: subjects
  }
}

/**
 * 从云端拉取学习档案，与本地双向合并后写回本地并上传云端，实现多端最终一致。
 * 作答流水可能很多（单查上限 100 条），采用顺序分页拉取：每页带 skip，
 * 服务端返回 hasMore / nextSkip，直到取完所有页再一次性合并。
 *
 * 一致性防护（评审 P1）：发起时快照「同步代次 + 作用域 + 令牌」，
 * 每次回包（含每个分页）先校验三者未变，否则丢弃。
 * 否则账号 A 的拉取在登出 / 切到 B 之后回来，会把 A 的答题记录与 AI 对话
 * 并入当前（属于 B 的）内存态，并随后续落盘以 B 的令牌上传。
 * 分页复用同一个 token 快照，避免一次拉取横跨两个账号。
 *
 * @param {Function} [onDone] 拉取（含所有分页）结束后回调，便于测试；生产调用通常省略
 */
function pullFromCloud(onDone) {
  if (!hasCloud() || !isLogged()) return
  if (bootPulled) return
  const gen = cloudSyncGeneration
  const scope = userScope
  const token = getToken()
  bootPulled = true
  let skip = 0
  let stats = null
  const allAttempts = []
  /** 发起后账号环境已变化：回包属于旧账号，一律丢弃 */
  const stale = () => (gen !== cloudSyncGeneration || scope !== userScope || getToken() !== token)
  const abort = () => {
    if (typeof onDone === 'function') onDone(false)
  }
  const finish = (ok) => {
    if (stale()) { abort(); return }
    if (!ok) {
      // 拉取失败：允许下次（重新登录/重启）再试
      bootPulled = false
      if (typeof onDone === 'function') onDone(false)
      return
    }
    if (stats || allAttempts.length) {
      state = mergeStats(state, Object.assign({}, stats || {}, { attempts: allAttempts }))
      // flush 仅在 dirty 时落盘；合并结果必须显式标记脏，否则只存在于内存，
      // 关闭后离线重开即丢失，本地独有数据也不会按承诺上传（评审 P2）
      dirty = true
      flush() // 合并结果回写本地，并由 flush 自动 pushToCloud，保证两端收敛
    }
    if (typeof onDone === 'function') onDone(true)
  }
  const fetchPage = () => {
    callCloud({
      name: config.functions.studySync,
      data: { token: token, action: 'get', skip: skip },
      success: (res) => {
        if (stale()) { abort(); return }
        const r = res && res.result
        if (!r || !r.ok) { finish(false); return }
        if (r.stats) stats = r.stats
        if (Array.isArray(r.attempts)) {
          for (let i = 0; i < r.attempts.length; i++) allAttempts.push(r.attempts[i])
        }
        if (r.hasMore) {
          skip = (typeof r.nextSkip === 'number')
            ? r.nextSkip
            : skip + (Array.isArray(r.attempts) ? r.attempts.length : 0)
          fetchPage()
          return
        }
        finish(true)
      },
      fail: () => { finish(false) }
    })
  }
  fetchPage()
}

/** attempts 上传光标：返回已同步到云端的本地 attempts 下标（按当前作用域隔离） */
function getAttemptCursor() {
  try {
    const v = wx.getStorageSync(`${ATTEMPT_CURSOR_KEY}__${userScope}`)
    return typeof v === 'number' && v >= 0 ? v : 0
  } catch (e) {
    return 0
  }
}

function setAttemptCursor(n) {
  try {
    wx.setStorageSync(`${ATTEMPT_CURSOR_KEY}__${userScope}`, n)
  } catch (e) {}
}

/** 把当前学习档案增量上传到云端（白名单字段由云函数再次校验） */
function pushToCloud() {
  if (!hasCloud() || !isLogged() || !state) return
  // 作用域必须与会话身份一致才允许上传（评审 P1）：
  // 冷启动时若仍停留在 anon 作用域，这里上传的会是匿名态的空档案，
  // 而 studySync 按 openid 整doc覆盖，等于用空数据毁掉该账号的云端备份。
  const openid = getSessionOpenid()
  if (!openid || userScope !== openid) return
  const payload = {
    records: state.records,
    daily: state.daily,
    settings: state.settings,
    practiceSession: state.practiceSession,
    aiMessages: state.aiMessages,
    version: state.version
  }
  // 增量上传作答流水：只传本地尚未同步的新增部分（按光标切片），云端按 _id 幂等 upsert
  const attemptsAll = state.attempts || []
  const cursor = getAttemptCursor()
  const newAttempts = attemptsAll.slice(cursor)
  // 本次上传覆盖到的流水终点：请求在途期间 attempts 可能继续追加，
  // 必须按发起时的长度推进光标，否则会跳过这段新增作答。
  const syncedUpTo = attemptsAll.length
  callCloud({
    name: config.functions.studySync,
    // attempts 必须作为顶层字段：云函数只从 event.attempts 读取，
    // 而 stats 会过白名单过滤掉 attempts——放进 payload 会导致
    // 「流水一条都没上传，光标却已推进」（评审 P1）。
    data: { token: getToken(), action: 'update', stats: payload, attempts: newAttempts },
    // 云函数返回 { ok:false } 时仍然走 success 回调：只有应用层确认成功才推进光标
    success: (res) => {
      const r = res && res.result
      if (r && r.ok) setAttemptCursor(syncedUpTo)
    },
    fail: () => {} // 上传失败静默：下次 flush 会再次尝试
  })
}

/** 删除云端学习档案与全部作答流水（对应「清空学习数据」）；本地已清空，无需回写 */
function deleteCloud() {
  if (!hasCloud() || !isLogged()) return
  callCloud({
    name: config.functions.studySync,
    data: { token: getToken(), action: 'delete' },
    fail: () => {} // 删除失败静默：下次清空时再试
  })
}

/**
 * 标记数据已变更并安排落盘，节流到至多每 FLUSH_INTERVAL 一次。
 * 页面进入后台时应调用 flush() 强制落盘，避免丢掉窗口内最后一次作答。
 */
function persist() {
  if (!state) return
  dirty = true
  if (flushTimer) return
  flushTimer = setTimeout(flush, Math.max(0, FLUSH_INTERVAL - (Date.now() - lastFlushAt)))
}

function getSettings() {
  return load().settings
}

function saveSettings(patch) {
  const s = load()
  s.settings = Object.assign({}, s.settings, patch || {})
  persist()
  return s.settings
}

/**
 * 当前科目：全应用统一口径（刷题 / 错题 / 学情 / AI 都只统计该科目）。
 * 未设置或值不在题库中时，回落到题库首个科目，保证「始终处于某个具体科目下」。
 */
function getCurrentSubject() {
  const saved = load().settings.currentSubject
  const subjects = bank.getSubjects()
  if (subjects.some((s) => s.name === saved)) return saved
  return subjects.length ? subjects[0].name : ''
}

/** 切换当前科目；传入题库中不存在的科目时忽略，返回实际生效的科目 */
function setCurrentSubject(name) {
  const subjects = bank.getSubjects()
  if (!subjects.some((s) => s.name === name)) return getCurrentSubject()
  saveSettings({ currentSubject: name })
  flush() // 切换是显式操作，立即落盘
  return name
}

function getRecords() {
  return load().records
}

function getRecord(id) {
  if (!id) return null
  return load().records[id] || null
}

/**
 * 记录一次作答
 * @param {Object} question 题目对象（至少含 id / subject / chapter）
 * @param {Boolean} isCorrect 是否正确
 * @param {Number} costMs 本题耗时（毫秒）
 * @returns {{record: Object, today: Object}}
 */
function recordAnswer(question, isCorrect, costMs) {
  if (!question || !question.id) {
    throw new TypeError('recordAnswer: question 非法')
  }
  const s = load()
  const now = Date.now()
  const key = todayKey()

  const prev = s.records[question.id]
  const r = prev || {
    id: question.id,
    subject: question.subject,
    chapter: question.chapter,
    attempts: 0,
    wrong: 0,
    right: 0,
    streak: 0,
    bestStreak: 0,
    level: 0, // 掌握等级 0-5
    starred: false,
    firstAt: now,
    lastAt: 0,
    lastWrongAt: 0,
    nextReviewAt: 0,
    rightDays: [],
    wrongLogs: []
  }

  r.attempts += 1
  r.lastAt = now
  if (isCorrect) {
    r.right += 1
    r.streak += 1
    r.bestStreak = Math.max(r.bestStreak || 0, r.streak)
    r.level = Math.min(5, (r.level || 0) + 1)
    // 连续 MASTER_DAYS 天答对的错题，自动移出错题本
    r.rightDays = nextRightDays(r.rightDays || [], key)
    if (r.wrong > 0 && r.rightDays.length >= MASTER_DAYS) r.mastered = true
  } else {
    r.wrong += 1
    r.streak = 0
    r.level = Math.max(0, (r.level || 0) - 2)
    r.lastWrongAt = now
    r.mastered = false // 再次答错则重新回到错题本
    r.rightDays = []
    r.wrongLogs = (r.wrongLogs || []).concat([now]).slice(-20)
  }
  r.nextReviewAt = now + REVIEW_INTERVALS[r.level] * DAY
  s.records[question.id] = r

  const d = s.daily[key] || {
    date: key,
    total: 0,
    correct: 0,
    timeMs: 0,
    chapters: {},
    subjects: {}
  }
  d.total += 1
  if (isCorrect) d.correct += 1
  d.timeMs += costMs || 0
  const c = d.chapters[question.chapter] || { total: 0, correct: 0 }
  c.total += 1
  if (isCorrect) c.correct += 1
  d.chapters[question.chapter] = c
  // 科目维度：供「当前科目」口径统计（今日进度 / 趋势）
  const sj = d.subjects[question.subject] || { total: 0, correct: 0, timeMs: 0 }
  sj.total += 1
  if (isCorrect) sj.correct += 1
  sj.timeMs += costMs || 0
  d.subjects[question.subject] = sj
  s.daily[key] = d

  persist()
  return { record: r, today: d }
}

/** 确保某题存在记录（不计入作答统计，仅用于收藏等场景） */
function ensureRecord(question) {
  if (!question || !question.id) {
    throw new TypeError('ensureRecord: question 非法')
  }
  const s = load()
  const now = Date.now()
  if (!s.records[question.id]) {
    s.records[question.id] = {
      id: question.id,
      subject: question.subject,
      chapter: question.chapter,
      attempts: 0,
      wrong: 0,
      right: 0,
      streak: 0,
      bestStreak: 0,
      level: 0,
      starred: false,
      firstAt: now,
      lastAt: 0,
      lastWrongAt: 0,
      nextReviewAt: 0,
      rightDays: [],
      wrongLogs: []
    }
    persist()
  }
  return s.records[question.id]
}

/** 收藏 / 取消收藏 */
function toggleStar(id) {
  const s = load()
  const r = s.records[id]
  if (!r) return false
  r.starred = !r.starred
  persist()
  return r.starred
}

/** 掌握某道错题后可手动「移出错题本」（重置为已掌握） */
function resetWrong(id) {
  const s = load()
  const r = s.records[id]
  if (!r) return null
  r.level = 5
  r.streak = Math.max(r.streak || 0, 1)
  r.mastered = true
  r.nextReviewAt = Date.now() + REVIEW_INTERVALS[5] * DAY
  persist()
  return r
}

/** 按当前科目口径取某天统计；该科目当天无记录时返回 0 值 */
function _subjectDaily(key) {
  const d = load().daily[key]
  const sub = d ? (d.subjects || {})[getCurrentSubject()] : null
  return {
    date: key,
    total: sub ? sub.total : 0,
    correct: sub ? sub.correct : 0,
    timeMs: sub ? sub.timeMs : 0
  }
}

function getToday() {
  return _subjectDaily(todayKey())
}

/** 最近 n 天的日统计（按日期升序，无数据的天补 0），按当前科目口径 */
function getDailyRange(days) {
  const list = []
  const now = new Date()
  for (let i = days - 1; i >= 0; i--) {
    list.push(_subjectDaily(todayKey(new Date(now.getTime() - i * DAY))))
  }
  return list
}

/** 连续打卡天数 */
/** 累计学习天数与总时长：只遍历有记录的日期，无需构造整年占位对象 */
function getStudySummary() {
  const s = load()
  let days = 0
  let timeMs = 0
  Object.keys(s.daily).forEach((key) => {
    const d = s.daily[key]
    if (!d) return
    if (d.total > 0) days += 1
    timeMs += d.timeMs || 0
  })
  return { days: days, timeMs: timeMs }
}

function getStreakDays() {
  const s = load()
  let streak = 0
  const now = new Date()
  for (let i = 0; i < 365; i++) {
    const d = new Date(now.getTime() - i * DAY)
    const key = todayKey(d)
    const item = s.daily[key]
    if (item && item.total > 0) {
      streak += 1
    } else if (i > 0) {
      break
    }
  }
  return streak
}

/**
 * 到期待复习记录（按当前科目口径）。
 * 与错题本「待复习」页共用同一套筛选口径，避免两处定义不一致：
 * 排除 已掌握 / 从未作答 / 高掌握且无错记录 / 未到期且错<2。
 * 排序：错得多的优先，其次掌握等级低的，最后到期早的。
 */
function getDueRecords(limit) {
  const s = load()
  const now = Date.now()
  const subject = getCurrentSubject()
  const list = []
  Object.keys(s.records).forEach((id) => {
    const r = s.records[id]
    if (!r || r.subject !== subject) return
    if (r.mastered || !(r.attempts > 0)) return
    if (r.level >= 5 && !r.lastWrongAt) return
    if ((r.nextReviewAt || 0) > now && r.wrong < 2) return
    list.push(r)
  })
  list.sort((a, b) => {
    if (b.wrong !== a.wrong) return b.wrong - a.wrong
    if (a.level !== b.level) return a.level - b.level
    return (a.nextReviewAt || 0) - (b.nextReviewAt || 0)
  })
  return typeof limit === 'number' ? list.slice(0, limit) : list
}

/** 今日待复习 id 列表（与 getDueRecords 同一口径） */
function getDueIds(limit) {
  return getDueRecords(limit).map((r) => r.id)
}

function getWrongRecords() {
  const s = load()
  const subject = getCurrentSubject()
  return Object.keys(s.records)
    .map((id) => s.records[id])
    .filter((r) => r && r.subject === subject && r.wrong > 0 && !r.mastered)
    .sort((a, b) => {
      if (b.wrong !== a.wrong) return b.wrong - a.wrong
      return (b.lastWrongAt || 0) - (a.lastWrongAt || 0)
    })
}

function getAiMessages() {
  return load().aiMessages
}

function pushAiMessage(msg) {
  const s = load()
  s.aiMessages = s.aiMessages.concat([Object.assign({ time: Date.now() }, msg)]).slice(-60)
  persist()
  return s.aiMessages
}

function clearAiMessages() {
  load().aiMessages = []
  aiConversationVersion += 1
  persist()
  flush() // 清空是不可逆操作，立即落盘
}

function clearAll() {
  state = getDefaultState()
  aiConversationVersion += 1
  // 在途的云端拉取若回来，会把刚清空的档案再并回来
  cloudSyncGeneration += 1
  setAttemptCursor(0) // 重置作答上传光标，避免清空后新作答因光标错位而不上传
  deleteCloud() // 同步删除云端学习档案与作答流水，保证本地与云端一并清空
  persist()
  flush() // 清空当前作用域（不可逆）
}

/** 清空指定（或当前）作用域的全部本地数据；用于「安全删除/切换账号」场景 */
function clearScope(openid) {
  const target = openid ? String(openid) : userScope
  if (target === userScope) {
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = null
    dirty = false
    state = null
    aiConversationVersion += 1
    cloudSyncGeneration += 1
  }
  try {
    wx.removeStorageSync(`${STORAGE_KEY}__${target}`)
    wx.removeStorageSync(`${ATTEMPT_CURSOR_KEY}__${target}`)
  } catch (e) {
    /* ignore */
  }
}

/* ============================================================
 * 练习 Session 状态机 + AnswerAttempt 不可变流水（Issue 2 / Issue 3）
 * ============================================================
 * Session 状态：created -> in_progress -> completed
 *   - 每道题有独立 attemptId；同一 clientOpId 重复提交只会落库一次（幂等）
 *   - 已提交的题在会话内回看为只读，不允许再次提交
 *   - 主动重练会创建新 Session（新 attemptId 序列）
 */

/** 当前/最新一次练习 Session；无则返回 null */
function getPracticeSession() {
  return load().practiceSession || null
}

/**
 * 创建一次练习 Session（created/in_progress）。
 * @param {Object} opt { mode, subject, questionIds }
 */
function createPracticeSession(opt) {
  const s = load()
  const session = {
    id: newId('ps'),
    mode: (opt && opt.mode) || 'all',
    subject: (opt && opt.subject) || '',
    questionIds: (opt && opt.questionIds) || [],
    params: (opt && opt.params) || null, // 用于「重进页面恢复未完成会话」时比对参数
    status: 'in_progress',
    createdAt: Date.now(),
    completedAt: 0,
    currentIndex: 0,
    submitted: {} // qid -> { attemptId, clientOpId }
  }
  s.practiceSession = session
  persist()
  return session
}

/** 更新会话当前进度（前后翻页/自动下一题/暂停恢复） */
function updatePracticeSession(patch) {
  const s = load()
  if (!s.practiceSession) return null
  s.practiceSession = Object.assign({}, s.practiceSession, patch || {})
  persist()
  return s.practiceSession
}

/** 将会话标记为 completed */
function completePracticeSession() {
  return updatePracticeSession({ status: 'completed', completedAt: Date.now() })
}

/** 主动重练：作废当前会话并新建（生成新 attemptId 序列） */
function restartPracticeSession(opt) {
  return createPracticeSession(opt)
}

/** 读取不可变作答流水（AnswerAttempt 列表） */
function getAttempts() {
  return (load().attempts || []).slice()
}

/**
 * 根据不可变作答流水，按「每题最近一次作答」派生会话聚合统计。
 * 用于 submitAttempt 后同步 sessionCorrect/sessionTotal/errorIds，
 * 使得会话被持久化、重进页面恢复时进度与实时一致（评审 P2）。
 */
function recomputeSessionStats(session, attempts) {
  const byQ = {}
  ;(attempts || []).forEach((a) => {
    if (session && a.sessionId !== session.id) return
    byQ[a.questionId] = a // 顺序追加 -> 后写覆盖，保留最后一次作答
  })
  const ids = Object.keys(byQ)
  const errorIds = ids.filter((id) => byQ[id].score === 0)
  const correct = ids.filter((id) => byQ[id].score === 1).length
  return { sessionTotal: ids.length, sessionCorrect: correct, errorIds: errorIds }
}

/**
 * 幂等提交一次作答。
 * @param {Object} question 题目对象
 * @param {Array} selected 用户作答
 * @param {Boolean} isCorrect 判分结果
 * @param {Number} costMs 用时
 * @param {String} clientOpId 客户端操作 ID（同一操作的重复提交用同一 ID 实现幂等）
 * @returns {{record: Object, attempt: Object|null, dup: Boolean}}
 */
function submitAttempt(question, selected, isCorrect, costMs, clientOpId) {
  if (!question || !question.id) {
    throw new TypeError('submitAttempt: question 非法')
  }
  const s = load()
  const session = s.practiceSession
  const opId = clientOpId || newId('op')

  // submitted 只保留本题最后一次答案，不能作为历史操作的去重索引。
  // 以持久化流水查找业务幂等键，one→two→重试 one 也不会再落库或覆盖最新答案。
  const existing = session && (s.attempts || []).find((a) =>
    a.sessionId === session.id && a.questionId === question.id && a.clientOpId === opId
  )
  const latest = session && session.submitted && session.submitted[question.id]
  if (existing || (latest && latest.clientOpId === opId)) {
    return { record: getRecord(question.id), attempt: existing || null, dup: true }
  }

  const attemptId = newId('at')
  const attempt = {
    id: attemptId,
    sessionId: session ? session.id : '',
    questionId: question.id,
    questionVersionId: question.version || 'v1', // Issue 5 接入题目版本后填充
    selected: Array.isArray(selected) ? selected.slice() : selected,
    answer: question.answer,
    score: isCorrect ? 1 : 0,
    costMs: costMs || 0,
    clientOpId: opId,
    createdAt: Date.now()
  }
  // 不可变流水：仅追加
  if (!s.attempts) s.attempts = []
  s.attempts.push(attempt)

  // 派生聚合统计（保持与旧 recordAnswer 一致的口径）
  const agg = recordAnswer(question, isCorrect, costMs)

  // 标记本题本会话已提交
  if (!s.practiceSession) s.practiceSession = null
  if (s.practiceSession) {
    if (!s.practiceSession.submitted) s.practiceSession.submitted = {}
    s.practiceSession.submitted[question.id] = { attemptId: attemptId, clientOpId: opId }
    // 同步派生聚合统计，保证「重进页面恢复会话」时进度/正确率/错题与实时一致（评审 P2）
    const stats = recomputeSessionStats(s.practiceSession, s.attempts)
    s.practiceSession.sessionTotal = stats.sessionTotal
    s.practiceSession.sessionCorrect = stats.sessionCorrect
    s.practiceSession.errorIds = stats.errorIds
  }
  persist()
  return { record: agg.record, attempt: attempt, dup: false }
}

module.exports = {
  REVIEW_INTERVALS,
  todayKey,
  shortDate,
  getUserScope,
  setUserScope,
  clearScope,
  load,
  flush,
  mergeStats,
  getSettings,
  saveSettings,
  getCurrentSubject,
  setCurrentSubject,
  getRecords,
  getRecord,
  ensureRecord,
  recordAnswer,
  toggleStar,
  resetWrong,
  getToday,
  getDailyRange,
  getStudySummary,
  getStreakDays,
  getDueRecords,
  getDueIds,
  getWrongRecords,
  getAiMessages,
  getAiConversationVersion,
  pushAiMessage,
  clearAiMessages,
  clearAll,
  // Issue 2/3：练习 Session 状态机 + AnswerAttempt 不可变流水
  getPracticeSession,
  createPracticeSession,
  updatePracticeSession,
  completePracticeSession,
  restartPracticeSession,
  getAttempts,
  submitAttempt,
  pullFromCloud
}
