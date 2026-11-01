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
 *   - 可编辑字段的冲突按版本决胜，作答贡献独立合并，
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
    settingsVersions: {}, // 每个设置项独立的修改版本，默认值不代表一次编辑
    aiMessages: [],
    aiEpoch: 0, // 对话代次由服务端 clearAI 事务递增；客户端不能独立生成
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

/** 同一字段按修改版本决胜；不同字段独立合并，时间相同时确定性决胜。 */
function mergeVersionedFields(left, leftVersions, right, rightVersions, defaults) {
  const l = left || {}
  const r = right || {}
  const values = {}
  const versions = {}
  const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key)
  Object.keys(Object.assign({}, defaults, l, r)).forEach((key) => {
    const lv = Number((leftVersions || {})[key]) || 0
    const rv = Number((rightVersions || {})[key]) || 0
    if (!has(l, key) && !has(r, key)) values[key] = defaults[key]
    else if (!has(l, key)) values[key] = r[key]
    else if (!has(r, key)) values[key] = l[key]
    else values[key] = lv === rv
      ? (canonical(l[key]) >= canonical(r[key]) ? l[key] : r[key])
      : (lv > rv ? l[key] : r[key])
    versions[key] = Math.max(lv, rv)
  })
  return { values, versions }
}

/** 已观察到的修改之后继续递增，设备时钟回退也不会回退版本。 */
function nextFieldVersion(versions, fallback) {
  const observed = Object.keys(versions || {}).reduce((max, key) => Math.max(max, Number(versions[key]) || 0), Number(fallback) || 0)
  return Math.max(Date.now(), observed + 1)
}

/** 旧快照的已有配置视为历史编辑；新默认值版本为 0，不能覆盖历史配置。 */
function settingsFieldVersions(state) {
  if (state.settingsVersions) return Object.assign({}, state.settingsVersions)
  const versions = {}
  Object.keys(state.settings || {}).forEach((field) => { versions[field] = 1 })
  return versions
}

const RECORD_AGGREGATES = ['answerBy', 'attempts', 'right', 'wrong', 'fieldVersions', 'updatedAt']

function recordMetadata(record) {
  if (!record) return {}
  const metadata = {}
  Object.keys(record).forEach((key) => {
    if (RECORD_AGGREGATES.indexOf(key) === -1) metadata[key] = record[key]
  })
  return metadata
}

/** 旧记录首次编辑前固定历史版本，不能让本次收藏的 updatedAt 冒充旧作答版本。 */
function recordFieldVersions(record) {
  if (record && record.fieldVersions) return Object.assign({}, record.fieldVersions)
  const versions = {}
  const legacyVersion = versionOf(record, ['lastAt'])
  Object.keys(recordMetadata(record)).forEach((field) => { versions[field] = legacyVersion })
  return versions
}

function advanceRecordFields(record, fields) {
  const versions = recordFieldVersions(record)
  const next = nextFieldVersion(versions, record.updatedAt)
  fields.forEach((field) => { versions[field] = next })
  record.fieldVersions = versions
  record.updatedAt = next
}

/**
 * 按 time 升序排序；没有 time 的条目保持原有相对次序，排在末尾。
 *
 * 合并后的对话顺序不能依赖「哪一侧在前」：上传侧受保留上限约束，
 * 往往只带最近一段窗口，直接拼接会把新消息排到旧消息之前（评审 P2 4425408887）。
 */
function sortByTime(list) {
  const withTime = []
  const without = []
  ;(list || []).forEach((m, i) => {
    if (m && typeof m.time === 'number') withTime.push({ m: m, i: i })
    else without.push({ m: m, i: i })
  })
  withTime.sort((x, y) => x.m.time - y.m.time || x.i - y.i)
  return withTime.concat(without).map((x) => x.m)
}

/**
 * 合并两份学习档案。
 *
 * 语义（除 settings 外均为对称的「并集 / 取较新或较大」）：
 *  - records        ：作答贡献按写入者合并；可编辑字段按 updatedAt 决胜；
 *  - daily          ：按日期 key 取并集，同日各指标取较大值，
 *                     chapters / subjects 取键并集、同键指标取较大；
 *  - practiceSession：先合并同 id 会话的进度，再取较新的一方；
 *  - aiMessages     ：先按 aiEpoch 判定清空（高纪元的空列表胜出），同纪元内按 time 并集去重；
 *  - attempts       ：按 id 去重取并集（不可变流水，按 id 并集即可）；
 *  - settings       ：各设置项按 settingsVersions 独立合并；
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

  // records：仅可编辑元数据按版本决胜，累计贡献独立合并。
  // 不能用 lastAt 单独判定：收藏 / 移出错题本不改变 lastAt，
  // 仅按 lastAt 比较会让这类修改在合并后被丢弃（评审 P2 4423125081）。
  const records = {}
  Object.keys(Object.assign({}, L.records, R.records)).forEach((id) => {
    records[id] = mergeRecord((L.records || {})[id], (R.records || {})[id])
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
    // 必须排序后再交给下游：AI 页取「最后 6 条」作模型上下文、
    // pushAiMessage 保留「最后 60 条」——顺序错了会拿旧对话当上下文并截掉最新记录
    out.aiMessages = sortByTime(ai)
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
  // 先合并事实，再重算会话派生值；不能把单台设备缓存的成绩随元数据一起选中。
  out.practiceSession = mergeSession(L.practiceSession, R.practiceSession, attempts)

  const settings = mergeVersionedFields(L.settings, settingsFieldVersions(L), R.settings, settingsFieldVersions(R), def.settings)
  out.settings = settings.values
  out.settingsVersions = settings.versions

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
function mergeSession(a, b, attempts) {
  if (!a && !b) return null
  const newer = pickNewer(a, b, ['createdAt'])
  const same = a && b && a.id === b.id
  const left = same ? a : newer
  const right = same ? b : newer
  const questionIds = Array.from(new Set((newer.questionIds || []).concat(
    same ? (newer === a ? b.questionIds : a.questionIds) || [] : []
  )))
  const facts = attemptIndex(attempts)
  const submitted = {}
  ;[left, right].forEach((session) => {
    Object.keys(session.submitted || {}).forEach((qid) => {
      if (session.questionIds && session.questionIds.length && session.questionIds.indexOf(qid) === -1) return
      const marker = Object.assign({}, session.submitted[qid])
      const attempt = facts[marker.attemptId]
      if (attempt && attempt.sessionId === session.id && attempt.questionId === qid) {
        marker.score = attempt.score
        marker.createdAt = attempt.createdAt
      }
      submitted[qid] = pickNewer(submitted[qid], marker, ['createdAt'])
    })
  })
  const questionSnapshots = {}
  for (const qid of questionIds) {
    const l = left.questionSnapshots ? left.questionSnapshots[qid] : undefined
    const r = right.questionSnapshots ? right.questionSnapshots[qid] : undefined
    if (l === null || r === null || (l && r && l.versionId !== r.versionId)) questionSnapshots[qid] = null
    else if (l || r) questionSnapshots[qid] = pickNewer(l, r)
  }
  const merged = Object.assign({}, newer, {
    submitted,
    ...(Object.keys(questionSnapshots).length ? { questionSnapshots } : {}),
    // 进度只前进不回退
    currentIndex: Math.max(Number(left.currentIndex || 0), Number(right.currentIndex || 0)),
    completedAt: Math.max(Number(left.completedAt || 0), Number(right.completedAt || 0)),
    status: left.status === 'completed' || right.status === 'completed' ? 'completed' : newer.status
  })
  if (Array.isArray(newer.questionIds)) merged.questionIds = questionIds
  return Object.assign(merged, recomputeSessionStats(merged, attempts))
}

function attemptIndex(attempts) {
  const index = Object.create(null)
  ;(attempts || []).forEach((a) => { if (a && a.id) index[a.id] = a })
  return index
}

/** 成绩只由已选定的作答派生；分支数组顺序不能重新决定答案。 */
function recomputeSessionStats(session, attempts) {
  const facts = attemptIndex(attempts)
  const submitted = (session && session.submitted) || {}
  const ids = Object.keys(submitted).sort()
  const errorIds = []
  let correct = 0
  let complete = true
  ids.forEach((qid) => {
    const marker = submitted[qid] || {}
    const fact = facts[marker.attemptId]
    const score = fact && fact.sessionId === session.id && fact.questionId === qid ? fact.score : marker.score
    if (score === 1) correct += 1
    else if (score === 0) errorIds.push(qid)
    else complete = false
  })
  return { sessionTotal: ids.length, sessionCorrect: correct, errorIds, statsComplete: complete }
}

/**
 * 老快照无分区时保留共同历史基线；以后每台设备只推进自己的贡献。
 * 旧版的独立分支若没有贡献归属，无法仅凭累计值恢复精确增量，不能直接相加。
 */
function recordCountsBy(record) {
  const r = record || {}
  return r.answerBy || { __legacy__: { attempts: Number(r.attempts) || 0, right: Number(r.right) || 0, wrong: Number(r.wrong) || 0 } }
}

function sumRecordCounts(record) {
  record.attempts = 0
  record.right = 0
  record.wrong = 0
  Object.keys(record.answerBy).forEach((writer) => {
    const c = record.answerBy[writer] || {}
    record.attempts += Math.max(Number(c.attempts) || 0, (Number(c.right) || 0) + (Number(c.wrong) || 0))
    record.right += Number(c.right) || 0
    record.wrong += Number(c.wrong) || 0
  })
  return record
}

function mergeRecord(a, b) {
  const fields = mergeVersionedFields(recordMetadata(a), recordFieldVersions(a), recordMetadata(b), recordFieldVersions(b))
  const out = Object.assign({}, fields.values, {
    fieldVersions: fields.versions,
    updatedAt: Math.max(Number(a && a.updatedAt) || 0, Number(b && b.updatedAt) || 0)
  })
  if ((a && a.lastWrongAt !== undefined) || (b && b.lastWrongAt !== undefined)) {
    out.lastWrongAt = Math.max(Number(a && a.lastWrongAt) || 0, Number(b && b.lastWrongAt) || 0)
  }
  if (![a, b].some((r) => r && (r.answerBy || ['attempts', 'right', 'wrong'].some((field) => r[field] !== undefined)))) return out
  const left = recordCountsBy(a)
  const right = recordCountsBy(b)
  out.answerBy = {}
  Object.keys(Object.assign({}, left, right)).forEach((writer) => {
    const l = left[writer] || {}
    const r = right[writer] || {}
    out.answerBy[writer] = {
      attempts: Math.max(Number(l.attempts) || 0, Number(r.attempts) || 0),
      right: Math.max(Number(l.right) || 0, Number(r.right) || 0),
      wrong: Math.max(Number(l.wrong) || 0, Number(r.wrong) || 0)
    }
  })
  return sumRecordCounts(out)
}

/**
 * 计数器节点：{ total, correct, timeMs, by: { [写入者]: {total, correct, timeMs} } }
 *
 * 为什么必须按写入者分区（评审 P2 4429855405）：
 *  daily 是「账户级单调聚合计数器」。两台设备从同一基线各自作答后，
 *  各自把 total 从 5 加到 6；此时取 max 得 6，而正确答案是 7——
 *  较小那一支的增量被吞掉了。根因是 max 对「同一写入者的单调序列」正确，
 *  对「两个分支的独立贡献」错误。
 *
 *  分区之后：写入者内取 max（其序列单调，max 正确），
 *  写入者间求和（各自独立贡献，求和正确）。聚合值由分区明细求和得出，
 *  不再是独立事实。
 */

/** 取出分区明细；老数据没有 by 时，把已有聚合值归入一个 legacy 写入者，保证历史不丢 */
function counterBy(node) {
  const n = node || {}
  if (n.by && Object.keys(n.by).length) return n.by
  return {
    __legacy__: {
      total: Number(n.total) || 0,
      correct: Number(n.correct) || 0,
      timeMs: Number(n.timeMs) || 0
    }
  }
}

/** 由分区明细重算聚合值（分区是唯一事实来源） */
function sumCounter(node) {
  let total = 0
  let correct = 0
  let timeMs = 0
  Object.keys(node.by || {}).forEach((w) => {
    const c = node.by[w] || {}
    total += Number(c.total) || 0
    correct += Number(c.correct) || 0
    timeMs += Number(c.timeMs) || 0
  })
  node.total = total
  node.correct = correct
  node.timeMs = timeMs
  return node
}

/**
 * 合并计数器：写入者内取 max（单调），写入者间求和（独立贡献）。
 * 对参数顺序对称——端上用 mergeStats(本地, 云端)，云端用 mergeStats(服务端, 上传方)，
 * 两侧 incoming 含义不同，合并必须对顺序无关。
 */
function mergeCounter(a, b) {
  const out = { by: Object.assign({}, counterBy(b)) }
  const la = counterBy(a)
  Object.keys(la).forEach((w) => {
    const av = la[w] || {}
    const bv = out.by[w]
    out.by[w] = bv
      ? {
        total: Math.max(Number(av.total) || 0, Number(bv.total) || 0),
        correct: Math.max(Number(av.correct) || 0, Number(bv.correct) || 0),
        timeMs: Math.max(Number(av.timeMs) || 0, Number(bv.timeMs) || 0)
      }
      : {
        total: Number(av.total) || 0,
        correct: Number(av.correct) || 0,
        timeMs: Number(av.timeMs) || 0
      }
  })
  return sumCounter(out)
}

/** 合并单日统计：chapters/subjects 取键并集，同键按「分区求和」合并 */
function mergeDaily(ld, rd) {
  const chapters = Object.assign({}, rd.chapters || {})
  Object.keys(ld.chapters || {}).forEach((c) => {
    const rc = chapters[c]
    chapters[c] = rc ? mergeCounter(ld.chapters[c], rc) : sumCounter({ by: counterBy(ld.chapters[c]) })
  })
  const subjects = Object.assign({}, rd.subjects || {})
  Object.keys(ld.subjects || {}).forEach((s) => {
    const rs = subjects[s]
    subjects[s] = rs ? mergeCounter(ld.subjects[s], rs) : sumCounter({ by: counterBy(ld.subjects[s]) })
  })
  const out = mergeCounter(ld, rd)
  out.date = ld.date || rd.date
  out.chapters = chapters
  out.subjects = subjects
  return out
}

module.exports = {
  CURRENT_VERSION,
  getDefaultState,
  mergeDaily,
  mergeCounter,
  counterBy,
  sumCounter,
  mergeStats,
  mergeSession,
  recomputeSessionStats,
  mergeVersionedFields,
  nextFieldVersion,
  settingsFieldVersions,
  recordFieldVersions,
  advanceRecordFields,
  recordCountsBy,
  sumRecordCounts,
  sortByTime,
  versionOf,
  bumpVersion,
  canonical,
  pickNewer
}
