/** Durable content-free pending operations, partitioned by account. No network operations. */
const { canonical, sha256 } = require('../shared/question-domain.js')
const fail = code => { throw Object.assign(new Error(code), { code }) }
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(value)
const copy = value => JSON.parse(JSON.stringify(value))
const same = (a, b) => canonical(a) === canonical(b)
const prefix = 'exam_quiz_protected_outbox_v1__'
const storageKey = owner => prefix + sha256(JSON.stringify(owner))
const operationFields = ['dataEpoch', 'operationId', 'examId', 'releaseId', 'publicationRevision', 'questionId', 'questionVersionId', 'selected', 'costMs'].sort()
function validOperation(op) {
  return op && same(Object.keys(op).sort(), operationFields) && Number.isSafeInteger(op.dataEpoch) && op.dataEpoch >= 0 && id(op.operationId) && id(op.examId) &&
    /^qb_[a-f0-9]{64}$/.test(op.releaseId || '') && Number.isSafeInteger(op.publicationRevision) && op.publicationRevision > 0 && id(op.questionId) &&
    /^qv_[a-f0-9]{64}$/.test(op.questionVersionId || '') && Array.isArray(op.selected) && op.selected.length > 0 && op.selected.length <= 30 &&
    op.selected.every(value => typeof value === 'string' && value.length <= 10000) && Number.isSafeInteger(op.costMs) && op.costMs >= 0 && op.costMs <= 86400000
}
function createProtectedOutbox(storage) {
  function read(owner) {
    if (!id(owner)) fail('BAD_OWNER')
    let data
    try { data = storage.getStorageSync(storageKey(owner)) } catch (e) { fail('OUTBOX_READ_FAILED') }
    if (data === '' || data === null || data === undefined) return { version: 1, owner, pending: [] }
    if (!data || !same(Object.keys(data).sort(), ['owner', 'pending', 'version']) || data.version !== 1 || data.owner !== owner ||
        !Array.isArray(data.pending) || data.pending.length > 50 || data.pending.some(op => !validOperation(op)) ||
        new Set(data.pending.map(op => op.operationId)).size !== data.pending.length) fail('INVALID_PROTECTED_OUTBOX')
    return copy(data)
  }
  function write(owner, value) {
    let error
    try { storage.setStorageSync(storageKey(owner), value) } catch (e) { error = e }
    let actual
    try { actual = read(owner) } catch (e) { fail('OUTBOX_WRITE_UNCERTAIN') }
    if (!same(actual, value)) fail(error ? 'OUTBOX_WRITE_FAILED' : 'OUTBOX_WRITE_UNCERTAIN')
  }
  function enqueue(owner, operation) {
    if (!validOperation(operation)) fail('BAD_PROTECTED_ATTEMPT')
    const state = read(owner), previous = state.pending.find(op => op.operationId === operation.operationId)
    if (previous) { if (!same(previous, operation)) fail('OPERATION_CONFLICT'); return copy(previous) }
    if (state.pending.length >= 50) fail('OUTBOX_CAPACITY')
    state.pending.push(copy(operation)); write(owner, state); return copy(operation)
  }
  function acknowledge(owner, operation, receipt) {
    if (!validOperation(operation)) fail('BAD_PROTECTED_ATTEMPT')
    const a = receipt && receipt.attempt
    const expectedId = 'pa_' + sha256(JSON.stringify([owner, operation.dataEpoch, operation.operationId]))
    if (!a || a.id !== expectedId || a.examId !== operation.examId || a.releaseId !== operation.releaseId || a.questionId !== operation.questionId ||
        a.questionVersionId !== operation.questionVersionId || a.costMs !== operation.costMs || ![0, 1].includes(a.score) || !same(a.selected, operation.selected)) fail('INVALID_RECEIPT')
    const state = read(owner), previous = state.pending.find(op => op.operationId === operation.operationId)
    if (!previous) return false
    if (!same(previous, operation)) fail('OPERATION_CONFLICT')
    state.pending = state.pending.filter(op => op.operationId !== operation.operationId)
    write(owner, state); return true
  }
  // Call only after the server confirms a learning-data clear and its new data epoch.
  function retireAfterConfirmedClear(owner, newEpoch) {
    if (!Number.isSafeInteger(newEpoch) || newEpoch < 1) fail('BAD_EPOCH')
    const state = read(owner), previous = state.pending.length
    state.pending = state.pending.filter(op => op.dataEpoch >= newEpoch)
    if (state.pending.length !== previous) write(owner, state)
    return previous - state.pending.length
  }
  return { read, enqueue, acknowledge, retireAfterConfirmedClear }
}
module.exports = { createProtectedOutbox }
