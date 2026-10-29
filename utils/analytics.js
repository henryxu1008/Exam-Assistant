/**
 * utils/analytics.js
 * 学情分析：答题统计、知识点掌握度、薄弱项识别、趋势数据
 */

const store = require('./store.js')
const bank = require('./questions.js')

const WEAK_RATE = 0.6 // 正确率低于该值视为薄弱
const WEAK_MIN_ATTEMPTS = 2 // 至少答过 2 题才纳入统计

function chapterKey(subject, chapter) {
  return `${subject}||${chapter}`
}

/**
 * 全部知识点维度的掌握情况
 * @returns {Array} [{subject, chapter, attempts, correct, wrong, rate, starred, level}]
 */
function chapterStats() {
  const records = store.getRecords()
  const map = {}

  Object.keys(records).forEach((id) => {
    const r = records[id]
    if (!r || !r.chapter) return
    const key = chapterKey(r.subject, r.chapter)
    const item = map[key] || {
      subject: r.subject,
      chapter: r.chapter,
      attempts: 0,
      correct: 0,
      wrong: 0,
      levelSum: 0,
      count: 0,
      starred: 0,
      lastWrongAt: 0
    }
    item.attempts += r.attempts || 0
    item.correct += r.right || 0
    item.wrong += r.wrong || 0
    item.levelSum += r.level || 0
    item.count += 1
    if (r.starred) item.starred += 1
    if (r.lastWrongAt) item.lastWrongAt = Math.max(item.lastWrongAt, r.lastWrongAt)
    map[key] = item
  })

  return Object.keys(map)
    .map((key) => {
      const it = map[key]
      it.rate = it.attempts ? Math.round((it.correct / it.attempts) * 100) : 0
      it.mastery = it.count ? Math.round((it.levelSum / it.count / 5) * 100) : 0
      return it
    })
    .sort((a, b) => b.attempts - a.attempts)
}

/** 总体概览 */
function overview() {
  const stats = chapterStats()
  const total = stats.reduce((s, i) => s + i.attempts, 0)
  const correct = stats.reduce((s, i) => s + i.correct, 0)
  const today = store.getToday()
  const wrongRecords = store.getWrongRecords()
  const dueIds = store.getDueIds()
  return {
    total: total,
    correct: correct,
    rate: total ? Math.round((correct / total) * 100) : 0,
    todayTotal: today.total || 0,
    todayCorrect: today.correct || 0,
    todayRate: today.total ? Math.round((today.correct / today.total) * 100) : 0,
    wrongCount: wrongRecords.length,
    stubbornCount: wrongRecords.filter((r) => r.wrong >= 2).length,
    dueCount: dueIds.length,
    streakDays: store.getStreakDays(),
    chapterCount: stats.length
  }
}

/**
 * 薄弱知识点（正确率低 + 近期错过的优先）
 * @param {Number} limit
 */
function weakPoints(limit) {
  const list = chapterStats().filter((i) => i.attempts >= WEAK_MIN_ATTEMPTS && i.rate < WEAK_RATE * 100)
  list.sort((a, b) => {
    const sa = (100 - a.rate) * 100 + a.wrong * 10 + (a.lastWrongAt ? 5 : 0)
    const sb = (100 - b.rate) * 100 + b.wrong * 10 + (b.lastWrongAt ? 5 : 0)
    return sb - sa
  })
  return typeof limit === 'number' ? list.slice(0, limit) : list
}

/** 已掌握较好的知识点 */
function strongPoints(limit) {
  const list = chapterStats().filter((i) => i.attempts >= 3 && i.rate >= 85)
  list.sort((a, b) => b.rate - a.rate)
  return typeof limit === 'number' ? list.slice(0, limit) : list
}

/** 雷达图数据：取练习量最多的 N 个知识点 */
function radarData(topN) {
  const n = topN || 6
  const list = chapterStats()
    .slice()
    .sort((a, b) => b.attempts - a.attempts)
    .slice(0, n)
  return list.map((i) => ({
    name: i.chapter.length > 4 ? i.chapter.slice(0, 4) : i.chapter,
    fullName: i.chapter,
    /** 掌握度按正确率与等级各占一半 */
    value: Math.round((i.rate * 0.5 + i.mastery * 0.5) * 10) / 10
  }))
}

/** 近 n 天正确率趋势 */
function trendData(days) {
  const list = store.getDailyRange(days || 7)
  return list.map((d) => ({
    date: store.shortDate(d.date),
    total: d.total,
    correct: d.correct,
    rate: d.total ? Math.round((d.correct / d.total) * 100) : 0
  }))
}

/** 顽固错题列表（错误次数 >= 2） */
function stubbornQuestions(limit) {
  const list = store
    .getWrongRecords()
    .filter((r) => r.wrong >= 2)
    .sort((a, b) => b.wrong - a.wrong || (b.lastWrongAt || 0) - (a.lastWrongAt || 0))
  const items = list.map((r) => {
    const q = bank.findQuestion(r.id)
    return {
      record: r,
      question: q,
      days: r.lastWrongAt ? Math.floor((Date.now() - r.lastWrongAt) / 86400000) : 0
    }
  }).filter((i) => i.question)
  return typeof limit === 'number' ? items.slice(0, limit) : items
}

/** 薄弱知识点对应的可练题 id（用于「薄弱突破」练习） */
function weakQuestionIds(limit) {
  const points = weakPoints()
  const idSet = {}
  const ids = []
  const records = store.getRecords()
  const all = bank.getAllQuestions()

  all.forEach((q) => {
    const hit = points.some((p) => p.subject === q.subject && p.chapter === q.chapter)
    if (!hit) return
    const r = records[q.id]
    const wrongCount = r ? r.wrong : 0
    if (wrongCount > 0 || hit) {
      if (!idSet[q.id]) {
        idSet[q.id] = true
        ids.push({ id: q.id, wrong: wrongCount, level: r ? r.level : 0 })
      }
    }
  })
  ids.sort((a, b) => b.wrong - a.wrong || a.level - b.level)
  const result = ids.map((i) => i.id)
  if (!result.length) return []
  return typeof limit === 'number' ? result.slice(0, limit) : result
}

module.exports = {
  WEAK_RATE,
  WEAK_MIN_ATTEMPTS,
  chapterKey,
  chapterStats,
  overview,
  weakPoints,
  strongPoints,
  radarData,
  trendData,
  stubbornQuestions,
  weakQuestionIds
}
