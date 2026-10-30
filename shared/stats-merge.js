/**
 * shared/stats-merge.js
 * 学习档案合并（纯函数：不依赖 wx、不依赖任何运行时全局）
 *
 * 为什么单独成文件：
 * 「合并」这件事同时发生在端上和云端——
 *   - 端上启动拉取：mergeStats(本地快照, 云端快照)；
 *   - 云端收到上传：mergeStats(服务端已有快照, 本次上传快照)。
 * 若两边各写一份，语义漂移就会导致「一端进度被另一端整doc覆盖」
 * （本次评审 P1 4422245834 的根因）。因此只留一份实现，两边共用。
 *
 * 部署约定：云函数按目录独立上传，无法 require 父级代码，
 * 所以 cloudfunctions/<fn>/stats-merge.js 是本文件的部署副本，
 * 由 scripts/check-shared-sync.js 校验必须与本文件逐字节一致。
 */

/** 当前数据结构版本 */
const CURRENT_VERSION = 3

/**
 * 默认（空）学习档案。
 * 约定：提升 CURRENT_VERSION 前必须先补对应的迁移函数，否则等于清空用户数据。
 */
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

/**
 * 合并两份学习档案。
 *
 * 语义（除 settings 外均为对称的「并集 / 取较新或较大」）：
 *  - records        ：按 qid 取 lastAt 较新的一方（incoming 在相等时优先）；
 *  - daily          ：按日期 key 取并集，同日各指标取较大值，
 *                     chapters / subjects 取键并集、同键指标取较大；
 *  - practiceSession：取 createdAt 较新的一方，均无则保留非 null 的；
 *  - aiMessages     ：按 time 去重取并集（incoming 在前、base 在后）；
 *  - attempts       ：按 id 去重取并集（incoming 在前、base 在后）；
 *  - settings       ：取 incoming（后到达的一方为准，即最后一次写入胜出）；
 *  - version        ：取较大值。
 *
 * @param {Object} base     已有快照
 * @param {Object} incoming 新到达的快照
 * @returns {Object} 合并后的完整 state（缺失字段用默认值补齐）
 */
function mergeStats(base, incoming) {
  const def = getDefaultState()
  const L = base || {}
  const R = incoming || {}
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

  // attempts：按 id 去重取并集（不可变流水，按 id 并集即可）
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

  // settings：后到达的一方为准
  out.settings = Object.assign({}, def.settings, L.settings || {}, R.settings || {})

  // version：取较大值
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

module.exports = { CURRENT_VERSION, getDefaultState, mergeDaily, mergeStats }
