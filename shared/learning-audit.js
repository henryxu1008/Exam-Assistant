/** 只读学习对账：事实贡献精确核对，旧聚合只给下界和未知项，不执行修复。 */
const { PREFIX, SERVER_KEY, businessKey, sameOperation, validProjection, canonical } = require('./attempt-domain.js')
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key)
const pathKey = parts => JSON.stringify(parts)
function auditLearning(snapshot) {
  const issues = [], unknown = [], facts = new Map(), operations = new Map(), expected = new Map(), nodes = new Map()
  const issue = (code, path, detail = {}) => issues.push({ code, path, ...detail })
  if (!object(snapshot) || (snapshot.attempts !== undefined && !Array.isArray(snapshot.attempts)) || !object(snapshot.records) || !object(snapshot.daily)) {
    return { version: 1, status: 'issues', issues: [{ code: 'INVALID_SNAPSHOT', path: [] }], unknown: [] }
  }
  if (snapshot.attempts === undefined) unknown.push({ code: 'NO_ATTEMPT_LEDGER' })
  const expectedAt = (path, contribution, values) => {
    const key = pathKey(path)
    if (!expected.has(key)) expected.set(key, { path, values: new Map() })
    const previous = expected.get(key).values.get(contribution)
    const total = contribution === SERVER_KEY && previous
      ? Object.fromEntries(Object.keys(values).map(field => [field, previous[field] + values[field]])) : values
    expected.get(key).values.set(contribution, total)
  }
  for (const fact of snapshot.attempts || []) {
    if (!object(fact) || typeof fact.id !== 'string' || !fact.id || typeof fact.questionId !== 'string' || !fact.questionId) {
      issue('INVALID_FACT', ['attempts']); continue
    }
    if (facts.has(fact.id)) {
      issue(canonical(facts.get(fact.id)) === canonical(fact) ? 'DUPLICATE_FACT_ID' : 'FACT_ID_CONFLICT', ['attempts'], { factId: fact.id })
      continue
    }
    facts.set(fact.id, fact)
    const identity = businessKey(fact)
    const groupKey = identity ? 'operation:' + identity : 'fact:' + fact.id
    if (!operations.has(groupKey)) operations.set(groupKey, [])
    operations.get(groupKey).push(fact)
    if (!identity) unknown.push({ code: 'MISSING_OPERATION_IDENTITY', factId: fact.id })
    if (!validProjection(fact)) {
      if (fact.projection !== undefined) issue('INVALID_FACT_METADATA', ['attempts'], { factId: fact.id })
      else unknown.push({ code: 'UNATTRIBUTED_LEGACY_FACT', factId: fact.id })
      continue
    }
    const p = fact.projection
    const contribution = p.confirmed === true ? SERVER_KEY : PREFIX + fact.id
    expectedAt(['records', fact.questionId], contribution, { attempts: 1, right: fact.score, wrong: 1 - fact.score })
    expectedAt(['daily', p.date], contribution, { total: 1, correct: fact.score, timeMs: fact.costMs })
    expectedAt(['daily', p.date, 'subjects', p.subject], contribution, { total: 1, correct: fact.score, timeMs: fact.costMs })
    expectedAt(['daily', p.date, 'chapters', p.chapter], contribution, { total: 1, correct: fact.score, timeMs: 0 })
  }
  const minimum = new Map()
  for (const group of operations.values()) {
    const first = group[0]
    if (group.length > 1) issue(group.every(f => sameOperation(f, first)) ? 'DUPLICATE_OPERATION' : 'OPERATION_CONFLICT', ['attempts'], { factIds: group.map(f => f.id) })
    if (!group.every(f => sameOperation(f, first)) || ![0, 1].includes(first.score)) continue
    const counts = minimum.get(first.questionId) || { attempts: 0, right: 0, wrong: 0 }
    counts.attempts += 1; counts.right += first.score; counts.wrong += 1 - first.score
    minimum.set(first.questionId, counts)
  }
  const metrics = (value, fields, path, strict = false) => {
    if (!object(value)) { issue('INVALID_COUNTER', path); return null }
    let valid = true
    const result = {}
    for (const field of fields) {
      const n = value && value[field] === undefined && !strict ? 0 : value && value[field]
      if (!Number.isSafeInteger(n) || n < 0) { issue('INVALID_COUNTER', path.concat(field)); valid = false }
      result[field] = n
    }
    return valid ? result : null
  }
  const inspect = (node, path, record) => {
    const key = pathKey(path)
    nodes.set(key, node)
    if (!object(node)) { issue('INVALID_AGGREGATE', path); return }
    const fields = record ? ['attempts', 'right', 'wrong'] : ['total', 'correct', 'timeMs']
    const partitions = record ? node.answerBy : node.by
    const actual = metrics(node, fields, path)
    const wanted = expected.get(key)?.values || new Map()
    if (partitions !== undefined && !object(partitions)) { issue('INVALID_PARTITIONS', path); return }
    const sum = Object.fromEntries(fields.map(f => [f, 0])), legacy = { ...sum }
    const seen = new Set()
    const hasPartitions = partitions && Object.keys(partitions).length > 0
    if (hasPartitions) {
      for (const id of Object.keys(partitions)) {
        const factPartition = id.startsWith(PREFIX) || id === SERVER_KEY
        const values = metrics(partitions[id], fields, path.concat(record ? 'answerBy' : 'by', id), factPartition)
        if (!values) continue
        for (const field of fields) sum[field] += record && field === 'attempts' ? Math.max(values.attempts, values.right + values.wrong) : values[field]
        if (factPartition) {
          seen.add(id)
          const target = wanted.get(id)
          if (!target) issue('ORPHAN_FACT_CONTRIBUTION', path, id === SERVER_KEY ? { contributionId: id } : { factId: id.slice(PREFIX.length) })
          else for (const field of fields) if (target[field] !== values[field]) issue('FACT_CONTRIBUTION_MISMATCH', path.concat(field), { ...(id === SERVER_KEY ? { contributionId: id } : { factId: id.slice(PREFIX.length) }), expected: target[field], actual: values[field] })
        } else for (const field of fields) legacy[field] += values[field]
      }
      if (actual) for (const field of fields) if (sum[field] !== actual[field]) issue('AGGREGATE_CACHE_MISMATCH', path.concat(field), { expected: sum[field], actual: actual[field] })
    } else if (actual) Object.assign(legacy, actual)
    if (Object.values(legacy).some(n => n > 0)) unknown.push({ code: 'LEGACY_AGGREGATE_UNKNOWN', path, counts: legacy })
    for (const [id, target] of wanted) if (!seen.has(id)) issue('MISSING_FACT_CONTRIBUTION', path, { ...(id === SERVER_KEY ? { contributionId: id } : { factId: id.slice(PREFIX.length) }), expected: target })
  }
  for (const id of Object.keys(snapshot.records)) inspect(snapshot.records[id], ['records', id], true)
  for (const date of Object.keys(snapshot.daily)) {
    const day = snapshot.daily[date]
    inspect(day, ['daily', date], false)
    if (!object(day)) continue
    for (const group of ['subjects', 'chapters']) {
      if (day[group] !== undefined && !object(day[group])) { issue('INVALID_AGGREGATE', ['daily', date, group]); continue }
      for (const name of Object.keys(day[group] || {})) inspect(day[group][name], ['daily', date, group, name], false)
    }
  }
  for (const [key, target] of expected) if (!nodes.has(key)) issue('MISSING_AGGREGATE', target.path)
  for (const [qid, lower] of minimum) {
    const record = own(snapshot.records, qid) ? snapshot.records[qid] : {}
    const actual = metrics(record, ['attempts', 'right', 'wrong'], ['records', qid])
    if (actual) for (const field of Object.keys(lower)) if (actual[field] < lower[field]) issue('FACT_COUNT_EXCEEDS_RECORD', ['records', qid, field], { expectedAtLeast: lower[field], actual: actual[field] })
  }
  const session = snapshot.practiceSession
  if (session !== undefined && session !== null) {
    if (!object(session) || !object(session.submitted)) issue('INVALID_SESSION', ['practiceSession'])
    else {
      let correct = 0
      const entries = Object.entries(session.submitted)
      for (const [qid, marker] of entries) {
        const fact = marker && facts.get(marker.attemptId)
        if (!fact) issue('MISSING_SUBMITTED_FACT', ['practiceSession', 'submitted', qid])
        else if (fact.sessionId !== session.id || fact.questionId !== qid || (marker.clientOpId !== undefined && marker.clientOpId !== fact.clientOpId)) issue('SUBMITTED_FACT_MISMATCH', ['practiceSession', 'submitted', qid])
        else if (fact.score === 1) correct += 1
      }
      for (const [field, value] of [['sessionTotal', entries.length], ['sessionCorrect', correct]]) if (session[field] !== undefined && session[field] !== value) issue('SESSION_CACHE_MISMATCH', ['practiceSession', field], { expected: value, actual: session[field] })
    }
  }
  return { version: 1, scope: 'answer_counters_v1', status: issues.length ? 'issues' : unknown.length ? 'incomplete' : 'consistent',
    summary: { factCount: facts.size, operationCount: operations.size,
      pendingAttemptCount: Array.isArray(snapshot.attemptOutbox?.pending) ? snapshot.attemptOutbox.pending.length : null,
      issueCount: issues.length, unknownCount: unknown.length }, issues, unknown }
}
module.exports = { auditLearning }
