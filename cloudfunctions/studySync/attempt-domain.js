/** 作答业务身份、事实计数与确认收敛；纯函数/草稿操作，不访问存储或网络。 */
const { recordCountsBy, sumRecordCounts, sumCounter, counterBy, recomputeSessionStats } = require('./stats-merge.js')
const questionDomain = require('./question-domain.js')
const grading = require('./grading-domain.js')
const PREFIX = '__fact__'
const SERVER_KEY = '__server_facts_v1__'
const copy = value => JSON.parse(JSON.stringify(value))
const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key)
const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
  : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}'
    : JSON.stringify(value === undefined ? null : value)
const keyName = value => typeof value === 'string' && value.length > 0 && value.length <= 160 && !['__proto__', 'constructor', 'prototype'].includes(value)
function businessKey(attempt) {
  return attempt && typeof attempt.sessionId === 'string' && attempt.sessionId.length > 0 && keyName(attempt.questionId) &&
    typeof attempt.clientOpId === 'string' && attempt.clientOpId.length > 0
    ? JSON.stringify([attempt.sessionId, attempt.questionId, attempt.clientOpId]) : null
}
function sameOperation(a, b) {
  const fields = ['sessionId', 'questionId', 'clientOpId', 'questionVersionId', 'selected', 'answer', 'score']
  return fields.every(field => canonical(a && a[field]) === canonical(b && b[field]))
}
function validProjection(attempt) {
  const p = attempt && attempt.projection
  if (!p || p.version !== 1 || !keyName(p.subject) || !keyName(p.chapter) || !keyName(attempt.questionId) ||
    !/^[A-Za-z0-9_-]{1,120}$/.test(attempt.id || '') || !businessKey(attempt) ||
    ![0, 1].includes(attempt.score) || !Number.isSafeInteger(attempt.createdAt) || attempt.createdAt < 0 || !Number.isSafeInteger(attempt.costMs) || attempt.costMs < 0 ||
    (p.confirmed !== undefined && p.confirmed !== true) || !/^\d{4}-\d{2}-\d{2}$/.test(p.date || '')) return false
  const date = new Date(p.date + 'T00:00:00Z')
  return !isNaN(date.getTime()) && date.toISOString().slice(0, 10) === p.date
}
function counterNodes(snapshot) {
  const nodes = []
  for (const date of Object.keys(snapshot.daily || {})) {
    const day = snapshot.daily[date]
    nodes.push(day)
    for (const group of ['subjects', 'chapters']) for (const name of Object.keys(day[group] || {})) nodes.push(day[group][name])
  }
  return nodes
}
function removeKeys(snapshot, predicate) {
  for (const record of Object.values(snapshot.records || {})) {
    if (!record || !record.answerBy) continue
    let changed = false
    for (const key of Object.keys(record.answerBy)) if (predicate(key)) { delete record.answerBy[key]; changed = true }
    if (changed) sumRecordCounts(record)
  }
  for (const node of counterNodes(snapshot)) {
    if (!node || !node.by) continue
    let changed = false
    for (const key of Object.keys(node.by)) if (predicate(key)) { delete node.by[key]; changed = true }
    if (changed) sumCounter(node)
  }
}
/** 新协议的事实贡献只由服务端事实生成；客户端快照中的同类分区不可成为写入依据。 */
function withoutFactCounts(snapshot) {
  const result = copy(snapshot || {})
  removeKeys(result, key => key.startsWith(PREFIX) || key === SERVER_KEY)
  return result
}
function projectCounts(snapshot, attempt) {
  if (!validProjection(attempt)) return
  const p = attempt.projection, key = PREFIX + attempt.id
  if (!snapshot.records) snapshot.records = {}
  if (!snapshot.daily) snapshot.daily = {}
  const record = own(snapshot.records, attempt.questionId) ? snapshot.records[attempt.questionId]
    : { id: attempt.questionId, subject: p.subject, chapter: p.chapter }
  record.answerBy = { ...recordCountsBy(record), [key]: { attempts: 1, right: attempt.score, wrong: 1 - attempt.score } }
  sumRecordCounts(record)
  snapshot.records[attempt.questionId] = record
  const day = own(snapshot.daily, p.date) ? snapshot.daily[p.date]
    : { date: p.date, by: {}, subjects: {}, chapters: {} }
  if (!day.subjects) day.subjects = {}
  if (!day.chapters) day.chapters = {}
  const bump = (node, cost) => {
    node.by = { ...counterBy(node) }
    node.by[key] = { total: 1, correct: attempt.score, timeMs: cost }
    sumCounter(node)
  }
  bump(day, attempt.costMs)
  for (const [group, name, cost] of [['subjects', p.subject, attempt.costMs], ['chapters', p.chapter, 0]]) {
    const node = own(day[group], name) ? day[group][name] : { by: {} }
    bump(node, cost)
    day[group][name] = node
  }
  snapshot.daily[p.date] = day
}
function checkedCounter(values) {
  if (!Object.values(values).every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error('COUNTER_RANGE_EXCEEDED')
  return values
}

/** 仅在事务首次创建业务事实时调用；服务端为此分区的唯一写入者。 */
function addServerCounts(snapshot, attempt) {
  if (!validProjection(attempt) || attempt.projection.confirmed !== true) return
  const p = attempt.projection
  if (!snapshot.records) snapshot.records = {}
  if (!snapshot.daily) snapshot.daily = {}
  const record = own(snapshot.records, attempt.questionId) ? snapshot.records[attempt.questionId]
    : { id: attempt.questionId, subject: p.subject, chapter: p.chapter }
  const by = recordCountsBy(record)
  const previous = by[SERVER_KEY] || { attempts: 0, right: 0, wrong: 0 }
  record.answerBy = { ...by, [SERVER_KEY]: checkedCounter({ attempts: previous.attempts + 1,
    right: previous.right + attempt.score, wrong: previous.wrong + 1 - attempt.score }) }
  sumRecordCounts(record)
  checkedCounter({ attempts: record.attempts, right: record.right, wrong: record.wrong })
  snapshot.records[attempt.questionId] = record
  const day = own(snapshot.daily, p.date) ? snapshot.daily[p.date] : { date: p.date, by: {}, subjects: {}, chapters: {} }
  if (!day.subjects) day.subjects = {}
  if (!day.chapters) day.chapters = {}
  const increment = (node, cost) => {
    const by = counterBy(node), previous = by[SERVER_KEY] || { total: 0, correct: 0, timeMs: 0 }
    node.by = { ...by, [SERVER_KEY]: checkedCounter({ total: previous.total + 1, correct: previous.correct + attempt.score, timeMs: previous.timeMs + cost }) }
    sumCounter(node)
    checkedCounter({ total: node.total, correct: node.correct, timeMs: node.timeMs })
  }
  increment(day, attempt.costMs)
  for (const [group, name, cost] of [['subjects', p.subject, attempt.costMs], ['chapters', p.chapter, 0]]) {
    const node = own(day[group], name) ? day[group][name] : { by: {} }
    increment(node, cost); day[group][name] = node
  }
  snapshot.daily[p.date] = day
}

function receiptCountsPresent(stats, facts) {
  const expected = { records: {}, daily: {} }
  for (const fact of facts.values()) addServerCounts(expected, fact)
  const check = (wanted, actual, fields) => fields.every(field => Number.isSafeInteger(actual && actual[field]) && actual[field] >= wanted[field])
  for (const [qid, record] of Object.entries(expected.records)) {
    const actual = stats.records[qid]?.answerBy?.[SERVER_KEY]
    if (!check(record.answerBy[SERVER_KEY], actual, ['attempts', 'right', 'wrong']) || actual.attempts !== actual.right + actual.wrong) return false
  }
  for (const [date, day] of Object.entries(expected.daily)) {
    const actual = stats.daily[date]
    if (!check(day.by[SERVER_KEY], actual?.by?.[SERVER_KEY], ['total', 'correct', 'timeMs'])) return false
    for (const group of ['subjects', 'chapters']) for (const [name, node] of Object.entries(day[group])) {
      if (!check(node.by[SERVER_KEY], actual?.[group]?.[name]?.by?.[SERVER_KEY], ['total', 'correct', 'timeMs'])) return false
    }
  }
  return true
}

/** 确认可改变尚未确认的本地 ID；已接受事实内容采用服务端首次提交版本。 */
function resolveAttempt(snapshot, submitted, accepted) {
  removeKeys(snapshot, key => key === PREFIX + submitted.id)
  const attempts = []
  let inserted = false
  for (const attempt of snapshot.attempts || []) {
    if (attempt.id === submitted.id || attempt.id === accepted.id) {
      if (!inserted) { attempts.push(copy(accepted)); inserted = true }
    } else attempts.push(attempt)
  }
  if (!inserted) attempts.push(copy(accepted))
  snapshot.attempts = attempts
  const session = snapshot.practiceSession
  if (session) {
    for (const qid of Object.keys(session.submitted || {})) {
      const marker = session.submitted[qid]
      if (marker.attemptId === submitted.id) session.submitted[qid] = { ...marker,
        attemptId: accepted.id, score: accepted.score, createdAt: accepted.createdAt }
    }
    Object.assign(session, recomputeSessionStats(session, snapshot.attempts))
  }
}
/** 服务端恢复也是事实证据，但不能替代提交确认来移除 outbox。 */
function resolveRestored(snapshot, remoteAttempts) {
  const facts = new Map()
  for (const fact of remoteAttempts) {
    const key = businessKey(fact)
    if (key) facts.set(key, facts.has(key) && canonical(facts.get(key)) !== canonical(fact) ? null : fact)
  }
  for (const local of (snapshot.attempts || []).slice()) {
    const remote = facts.get(businessKey(local))
    if (remote && local.id !== remote.id && validProjection(local) && sameOperation(local, remote)) resolveAttempt(snapshot, local, remote)
  }
}
function validateReceipts(result, sent, acceptedIds, snapshot = {}) {
  if (!result || result.attemptProtocol !== 2 || !Array.isArray(result.attemptReceipts) ||
    acceptedIds.length !== sent.length || result.attemptReceipts.length !== acceptedIds.length || !result.stats || !result.stats.records || typeof result.stats.records !== 'object' || Array.isArray(result.stats.records) || !result.stats.daily || typeof result.stats.daily !== 'object' || Array.isArray(result.stats.daily)) return null
  const known = new Map((snapshot.attempts || []).map(a => [a.id, a]))
  const waiting = snapshot.attemptOutbox && new Map(snapshot.attemptOutbox.pending.map(a => [a.id, a]))
  const expected = new Map(sent.map(a => [a.id, a])), ids = new Set(acceptedIds), seen = new Set(), facts = new Map()
  for (const receipt of result.attemptReceipts) {
    const fact = receipt && receipt.attempt, submitted = receipt && expected.get(receipt.submittedId)
    if (grading.isVersioned(submitted) && (result.questionProtocol !== grading.QUESTION_PROTOCOL || result.gradingProtocol !== 1 ||
        !(receipt.gradingStatus === 'graded' ? grading.validGrading(fact) : receipt.gradingStatus === 'legacy_unverified' && fact && fact.grading === undefined && fact.serverReceivedAt === undefined))) return null
    if (!submitted || (waiting && canonical(waiting.get(receipt.submittedId)) !== canonical(submitted)) || !ids.has(receipt.submittedId) || seen.has(receipt.submittedId) || !fact || typeof fact.id !== 'string' || !fact.id ||
      businessKey(fact) !== businessKey(submitted) || !sameOperation(fact, submitted) ||
      (submitted.questionSnapshot && !questionDomain.attemptQuestion(fact)) ||
      (fact.projection !== undefined && (!validProjection(fact) || fact.projection.confirmed !== true)) ||
      (known.has(fact.id) && !sameOperation(known.get(fact.id), fact)) ||
      (!businessKey(submitted) && fact.id !== submitted.id) ||
      (facts.has(fact.id) && canonical(facts.get(fact.id)) !== canonical(fact))) return null
    seen.add(receipt.submittedId); facts.set(fact.id, fact)
  }
  return receiptCountsPresent(result.stats, facts) ? result.attemptReceipts : null
}
module.exports = { PREFIX, SERVER_KEY, addServerCounts, businessKey, sameOperation, validProjection, withoutFactCounts, projectCounts,
  resolveAttempt, resolveRestored, validateReceipts, canonical }
