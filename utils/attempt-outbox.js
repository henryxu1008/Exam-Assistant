/** 设备本地的作答待传队列；attempt.id 同时是稳定的同步操作 ID。 */
const VERSION = 1
const copy = value => JSON.parse(JSON.stringify(value))

function validateAttempt(attempt) {
  if (!attempt || typeof attempt.id !== 'string' || !attempt.id) throw new Error('INVALID_ATTEMPT_OUTBOX')
}

function ensure(snapshot) {
  if (snapshot.attemptOutbox === undefined) {
    const seen = new Set()
    const pending = []
    for (const attempt of snapshot.attempts || []) {
      validateAttempt(attempt)
      if (!seen.has(attempt.id)) { pending.push(copy(attempt)); seen.add(attempt.id) }
    }
    snapshot.attemptOutbox = { version: VERSION, pending }
    return true
  }
  const queue = snapshot.attemptOutbox
  if (!queue || queue.version !== VERSION || !Array.isArray(queue.pending)) throw new Error('INVALID_ATTEMPT_OUTBOX')
  const ids = new Set()
  for (const attempt of queue.pending) {
    validateAttempt(attempt)
    if (ids.has(attempt.id)) throw new Error('INVALID_ATTEMPT_OUTBOX')
    ids.add(attempt.id)
  }
  return false
}

function add(snapshot, attempt) {
  ensure(snapshot)
  validateAttempt(attempt)
  if (!snapshot.attemptOutbox.pending.some(a => a.id === attempt.id)) snapshot.attemptOutbox.pending.push(copy(attempt))
}

function pending(snapshot) { ensure(snapshot); return snapshot.attemptOutbox.pending }

function acknowledged(result, sent, dataEpoch) {
  if (!result || !result.ok || result.dataEpoch !== dataEpoch || !Array.isArray(result.acceptedAttemptIds)) return null
  const expected = new Set(sent.map(a => a.id))
  const received = result.acceptedAttemptIds
  if (new Set(received).size !== received.length || received.some(id => typeof id !== 'string' || !expected.has(id))) return null
  return received
}

function remove(snapshot, ids) {
  ensure(snapshot)
  const accepted = new Set(ids)
  snapshot.attemptOutbox.pending = snapshot.attemptOutbox.pending.filter(a => !accepted.has(a.id))
}

module.exports = { ensure, add, pending, acknowledged, remove }
