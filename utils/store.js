/**
 * utils/store.js
 * 本地数据仓储：答题记录 / 每日统计 / 学习设置 / AI 对话历史
 * 说明：不依赖任何后端，全部通过 wx.setStorageSync 持久化。
 */

const bank = require('./questions.js')

const STORAGE_KEY = 'exam_quiz_data_v1'

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
  }
  userScope = next
  state = null
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
    fail: (e) => console.error('[store] 持久化失败', e)
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
  persist()
  flush() // 清空是不可逆操作，立即落盘
}

function clearAll() {
  state = getDefaultState()
  persist()
  flush() // 清空当前作用域（不可逆）
}

/** 清空指定（或当前）作用域的全部本地数据；用于「安全删除/切换账号」场景 */
function clearScope(openid) {
  const prev = userScope
  if (openid) userScope = String(openid)
  state = null
  try {
    wx.removeStorageSync(scopeKey())
  } catch (e) {
    /* ignore */
  }
  if (openid) userScope = prev
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

  // 幂等：同一会话内相同 clientOpId 已提交过，直接返回已有结果，不重复落库/计数
  if (session && session.submitted && session.submitted[question.id] && session.submitted[question.id].clientOpId === opId) {
    return { record: getRecord(question.id), attempt: null, dup: true }
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
  submitAttempt
}
