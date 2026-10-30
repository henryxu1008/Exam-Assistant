/**
 * shared/stats-merge.js
 * 学习档案合并（纯函数：不依赖 wx、不依赖任何运行时全局）
 *
 * 为什么单独成文件：
 * 「合并」这件事同时发生在端上和云端——
 *   - 端上启动拉取：mergeStats(本地快照, 云端快照)；
 *   - 云端收到上传：mergeStats(服务端已有快照, 本次上传快照)。
 * 若两边各写一份，语义漂移就会导致「一端进度被另一端整doc覆盖」
 * （评审 P1 4422245834 的根因）。因此只留一份实现，两边共用。
 *
 * ── 合并契约（本轮收敛的根因）────────────────────────────────
 * 早期实现是「纯单调」的：只会取并集与取较大。它无法表达两类操作：
 *
 *   1) 删除。清空 AI 对话后上传的是 aiMessages: []，但并集不会删东西，
 *      旧消息被完整保留，下次启动又被拉回本地——用户明确执行的删除被静默撤销
 *      （评审 P1 4423125072）。
 *
 *   2) 不推进时间字段的修改。收藏 / 移出错题本都不改 lastAt；
 *      会话在另一台设备恢复后继续作答，也不改 createdAt。
 *      而当时正是靠这两个时间字段判定新旧，于是这类修改永远被判为「旧」而丢弃
 *      （评审 P2 4423125081 / 4422339103）。
 *
 * 统一机制（一处实现，三个字段共用）：
 *   - 每个可修改实体携带 updatedAt，任何修改都必须推进它；
 *   - 删除用「纪元 epoch」墓碑表达，纪元高的一方其空值胜出；
 *   - 冲突一律 last-write-wins，且决胜规则对参数顺序对称，
 *     保证 mergeStats(a, b) 与 mergeStats(b, a) 结果一致——
 *     端上 incoming 是云端、云端 incoming 是上传方，顺序必须无关。
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
 * 说明：aiEpoch 是新增字段，缺省视为 0，因此不需要数据迁移。
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
    aiEpoch: 0, // 对话纪元：每次清空 +1，用于让删除在合并中生效
    createdAt: Date.now()
  }
}

/**
 * 取实体的合并版本号。
 * 优先 updatedAt；缺失时回退到给定字段（兼容迁移前写入、没有 updatedAt 的旧数据）。
 */
function versionOf(entity, fallbackKeys) {
  if (!entity || typeof entity !== 'object') return 0
  const u = Number(entity.updatedAt || 0)
  if (u > 0) return u
  const keys = fallbackKeys || []
  for (let i = 0; i < keys.length; i++) {
    const v = Number(entity[keys[i]] || 0)
    if (v > 0) return v
  }
  return 0
}

/**
 * 单调推进版本号。
 * 约定：任何修改实体的操作都必须调用它，否则该修改在合并时会被判为旧数据而丢弃
 * （收藏 / 移出错题本 / 会话进度推进都属于这类，见文件头契约）。
 */
function bumpVersion(entity) {
  return Math.max(Date.now(), versionOf(entity) + 1)
}

/** 规范化序列化：键序无关，用于版本相同时的确定性决胜 */
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') {
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canonical(value[k]))
        .join(',') +
      '}'
    )
  }
  return JSON.stringify(value === undefined ? null : value)
}

/**
 * 取「较新」的一版：先比版本，版本相同时按规范化序列化决胜。
 * 决胜必须对称（pickNewer(a,b) 与 pickNewer(b,a) 返回同一个对象），
 * 否则端上拉取与云端收到上传会算出不同结果。
 */
function pickNewer(a, b, fallbackKeys) {
  if (!a) return b
  if (!b) return a
  const av = versionOf(a, fallbackKeys)
  const bv = versionOf(b, fallbackKeys)
  if (av !== bv) return av > bv ? a : b
  return canonical(a) >= canonical(b) ? a : b
}

/**
 * 合并两份学习档案。
 *
 * 语义（除 settings 外均为对称的「并集 / 取较新或较大」）：
 *  - records        ：按 qid 逐个 last-write-wins，比较 updatedAt（旧数据回退 lastAt）；
 *  - daily          ：按日期 key 取并集，同日各指标取较大值，
 *                     chapters / subjects 取键并集、同键指标取较大；
 *  - practiceSession：先合并同 id 会话的进度，再取较新的一方；
 *  - aiMessages     ：先按 aiEpoch 判定清空（高纪元的空列表胜出），同纪元内按 time 并集去重；
 *  - attempts       ：按 id 去重取并集（不可变流水，按 id 并集即可）；
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

  // records：按 qid 逐个 last-write-wins。
  // 不能用 lastAt 单独判定：收藏 / 移出错题本不改变 lastAt，
  // 仅按 lastAt 比较会让这类修改在合并后被丢弃（评审 P2 4423125081）。
  const records = Object.assign({}, R.records || {})
  Object.keys(L.records || {}).forEach((id) => {
    records[id] = pickNewer(L.records[id], records[id], ['lastAt'])
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

  // practiceSession：恢复的会话在另一台设备继续作答时 createdAt 不变，
  // 只按 createdAt 二选一会丢掉远端进度（评审 P2 4422339103）。
  out.practiceSession = mergeSession(L.practiceSession, R.practiceSession)

  // aiMessages：先用纪元判定「清空」，再并集。
  // 只并集的话，用户清空对话后上传 []，服务端会把旧消息并回去，
  // 下次启动又被拉回本地，删除被静默撤销（评审 P1 4423125072）。
  const le = Number(L.aiEpoch || 0)
  const re = Number(R.aiEpoch || 0)
  out.aiEpoch = Math.max(le, re)
  if (le !== re) {
    // 纪元更高的一侧代表更近一次清空，它当时的列表胜出（通常是空列表）
    out.aiMessages = le > re ? (L.aiMessages || []) : (R.aiMessages || [])
  } else {
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
  }

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

/**
 * 合并练习会话：
 *  - 不同会话：取较新的一方；
 *  - 同一会话（在另一台设备恢复后继续作答）：进度取并集，
 *    否则本地缓存会把远端已作答的题目渲染成未作答。
 */
function mergeSession(a, b) {
  if (!a) return b || null
  if (!b) return a || null
  if (a.id && b.id && a.id !== b.id) return pickNewer(a, b, ['createdAt'])
  const newer = pickNewer(a, b, ['updatedAt', 'createdAt'])
  const baseMap = newer === a ? (b.submitted || {}) : (a.submitted || {})
  return Object.assign({}, newer, {
    // submitted 按 qid 取并集：任一侧已提交即视为已作答
    submitted: Object.assign({}, baseMap, newer.submitted || {}),
    // 进度只前进不回退
    currentIndex: Math.max(Number(a.currentIndex || 0), Number(b.currentIndex || 0)),
    completedAt: Math.max(Number(a.completedAt || 0), Number(b.completedAt || 0)),
    status: a.status === 'completed' || b.status === 'completed' ? 'completed' : newer.status
  })
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

module.exports = {
  CURRENT_VERSION,
  getDefaultState,
  mergeDaily,
  mergeStats,
  mergeSession,
  versionOf,
  bumpVersion,
  canonical,
  pickNewer
}
