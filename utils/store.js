/**
 * utils/store.js
 * 本地数据仓储：答题记录 / 每日统计 / 学习设置 / AI 对话历史
 * 说明：不依赖任何后端，全部通过 wx.setStorageSync 持久化。
 */

const STORAGE_KEY = 'exam_quiz_data_v1'

/** 掌握等级对应的复习间隔（天），艾宾浩斯式简化版 */
const REVIEW_INTERVALS = [0, 1, 2, 4, 7, 15]

const DAY = 24 * 60 * 60 * 1000

function getDefaultState() {
  return {
    version: 1,
    records: {}, // { qid: Record }
    daily: {}, // { '2026-10-29': DailyStat }
    settings: {
      dailyGoal: 30,
      autoNext: true,
      aiExplain: true
    },
    aiMessages: [],
    createdAt: Date.now()
  }
}

let state = null

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

function load() {
  if (state) return state
  try {
    const raw = wx.getStorageSync(STORAGE_KEY)
    state = raw && raw.version === 1 ? raw : getDefaultState()
  } catch (e) {
    state = getDefaultState()
  }
  if (!state.records) state.records = {}
  if (!state.daily) state.daily = {}
  if (!state.settings) state.settings = getDefaultState().settings
  if (!Array.isArray(state.aiMessages)) state.aiMessages = []
  return state
}

function persist() {
  try {
    wx.setStorageSync(STORAGE_KEY, state)
  } catch (e) {
    console.error('[store] 持久化失败', e)
  }
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
    wrongLogs: []
  }

  r.attempts += 1
  r.lastAt = now
  if (isCorrect) {
    r.right += 1
    r.streak += 1
    r.bestStreak = Math.max(r.bestStreak || 0, r.streak)
    r.level = Math.min(5, (r.level || 0) + 1)
  } else {
    r.wrong += 1
    r.streak = 0
    r.level = Math.max(0, (r.level || 0) - 2)
    r.lastWrongAt = now
    r.mastered = false // 再次答错则重新回到错题本
    r.wrongLogs = (r.wrongLogs || []).concat([now]).slice(-20)
  }
  r.nextReviewAt = now + REVIEW_INTERVALS[r.level] * DAY
  s.records[question.id] = r

  const d = s.daily[key] || {
    date: key,
    total: 0,
    correct: 0,
    timeMs: 0,
    chapters: {}
  }
  d.total += 1
  if (isCorrect) d.correct += 1
  d.timeMs += costMs || 0
  const c = d.chapters[question.chapter] || { total: 0, correct: 0 }
  c.total += 1
  if (isCorrect) c.correct += 1
  d.chapters[question.chapter] = c
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

function getToday() {
  const s = load()
  return s.daily[todayKey()] || { date: todayKey(), total: 0, correct: 0, timeMs: 0, chapters: {} }
}

/** 最近 n 天的日统计（按日期升序，无数据的天补 0） */
function getDailyRange(days) {
  const s = load()
  const list = []
  const now = new Date()
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * DAY)
    const key = todayKey(d)
    const item = s.daily[key] || { date: key, total: 0, correct: 0, timeMs: 0, chapters: {} }
    list.push(item)
  }
  return list
}

/** 连续打卡天数 */
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

/** 今日待复习（到期的错题 / 低掌握度题） */
function getDueIds(limit) {
  const s = load()
  const now = Date.now()
  const ids = Object.keys(s.records)
    .filter((id) => {
      const r = s.records[id]
      return r && !r.mastered && r.attempts > 0 && (r.level < 5 || r.lastWrongAt > 0)
    })
    .sort((a, b) => {
      const ra = s.records[a]
      const rb = s.records[b]
      const scoreA = (ra.lastWrongAt ? 1 : 0) * 1e13 + (5 - ra.level) * 1e12 - (ra.nextReviewAt || 0)
      const scoreB = (rb.lastWrongAt ? 1 : 0) * 1e13 + (5 - rb.level) * 1e12 - (rb.nextReviewAt || 0)
      if (scoreB !== scoreA) return scoreB - scoreA
      return (ra.nextReviewAt || 0) - (rb.nextReviewAt || 0)
    })
    .filter((id) => (s.records[id].nextReviewAt || 0) <= now || s.records[id].wrong >= 2)
  return typeof limit === 'number' ? ids.slice(0, limit) : ids
}

function getWrongRecords() {
  const s = load()
  return Object.keys(s.records)
    .map((id) => s.records[id])
    .filter((r) => r && r.wrong > 0 && !r.mastered)
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
}

function clearAll() {
  state = getDefaultState()
  persist()
}

module.exports = {
  REVIEW_INTERVALS,
  todayKey,
  shortDate,
  load,
  getSettings,
  saveSettings,
  getRecords,
  getRecord,
  ensureRecord,
  recordAnswer,
  toggleStar,
  resetWrong,
  getToday,
  getDailyRange,
  getStreakDays,
  getDueIds,
  getWrongRecords,
  getAiMessages,
  pushAiMessage,
  clearAiMessages,
  clearAll
}
