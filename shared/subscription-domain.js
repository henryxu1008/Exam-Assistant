/** Bounded, account/exam-scoped prepaid periods. No payment verification or storage access. */
const { canonical, sha256 } = require('./question-domain.js')
const MAX_PERIODS = 50
const DAY_MS = 86400000
const TERM_DAYS = [30, 90, 365]
const fail = code => { throw Object.assign(new Error(code), { code }) }
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(value)
const time = value => Number.isSafeInteger(value) && value >= 0
const sameKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  canonical(Object.keys(value).sort()) === canonical(keys.slice().sort())
const timelineId = (ownerId, examId) => 'sub_' + sha256(JSON.stringify([ownerId, examId]))
function productId(examId, durationDays) {
  if (!id(examId) || !TERM_DAYS.includes(durationDays)) fail('BAD_PRODUCT')
  return 'term_' + sha256(JSON.stringify([examId, durationDays])).slice(0, 24)
}
function seal(value) { return { ...value, digest: sha256(canonical(value)) } }
function empty(ownerId, examId) {
  if (!id(ownerId) || !id(examId)) fail('BAD_SUBSCRIPTION')
  return seal({ kind: 'examSubscription', version: 1, ownerId, examId, revision: 0, updatedAt: 0, periods: [], reservations: [] })
}
function valid(timeline, ownerId, examId) {
  try {
    if (!timeline || (timeline._id !== undefined && timeline._id !== timelineId(ownerId, examId))) return false
    const { _id, digest, ...value } = timeline
    if (!sameKeys(value, ['kind', 'version', 'ownerId', 'examId', 'revision', 'updatedAt', 'periods', 'reservations']) ||
        value.kind !== 'examSubscription' || value.version !== 1 || value.ownerId !== ownerId || value.examId !== examId ||
        !id(ownerId) || !id(examId) || !Number.isSafeInteger(value.revision) || value.revision < 0 || !time(value.updatedAt) ||
        !Array.isArray(value.periods) || !Array.isArray(value.reservations) || value.periods.length + value.reservations.length > MAX_PERIODS || digest !== sha256(canonical(value))) return false
    let lastEnd = 0
    const seen = new Set()
    for (const period of value.periods) {
      if (!sameKeys(period, ['orderId', 'startAt', 'endAt', 'revoked']) || !id(period.orderId) || seen.has(period.orderId) ||
          !time(period.startAt) || !time(period.endAt) || period.endAt <= period.startAt || typeof period.revoked !== 'boolean') return false
      seen.add(period.orderId)
      if (!period.revoked) { if (period.startAt < lastEnd) return false; lastEnd = period.endAt }
    }
    for (const orderId of value.reservations) { if (!id(orderId) || seen.has(orderId)) return false; seen.add(orderId) }
    return true
  } catch (e) { /* swallow: pure validation rejects corrupted timelines and performs no I/O. */ return false }
}
function reserve(timeline, orderId, at) {
  if (!timeline || !valid(timeline, timeline.ownerId, timeline.examId)) fail('INVALID_SUBSCRIPTION')
  if (!id(orderId) || !time(at)) fail('BAD_SUBSCRIPTION')
  if (at < timeline.updatedAt) fail('SUBSCRIPTION_CLOCK_ROLLBACK')
  if (timeline.periods.some(period => period.orderId === orderId) || timeline.reservations.includes(orderId)) fail('SUBSCRIPTION_ORDER_CONFLICT')
  if (timeline.periods.length + timeline.reservations.length >= MAX_PERIODS) fail('SUBSCRIPTION_CAPACITY')
  return seal({ kind: timeline.kind, version: timeline.version, ownerId: timeline.ownerId, examId: timeline.examId,
    revision: timeline.revision + 1, updatedAt: at, periods: timeline.periods, reservations: [...timeline.reservations, orderId] })
}
function extend(timeline, orderId, days, at) {
  if (!timeline || !valid(timeline, timeline.ownerId, timeline.examId)) fail('INVALID_SUBSCRIPTION')
  if (!id(orderId) || !time(at) || !Number.isSafeInteger(days) || days < 1 || days > 3650) fail('BAD_SUBSCRIPTION')
  if (at < timeline.updatedAt) fail('SUBSCRIPTION_CLOCK_ROLLBACK')
  if (timeline.periods.some(period => period.orderId === orderId)) fail('SUBSCRIPTION_ORDER_CONFLICT')
  if (!timeline.reservations.includes(orderId)) fail('SUBSCRIPTION_RESERVATION_REQUIRED')
  const active = timeline.periods.filter(period => !period.revoked)
  const startAt = Math.max(at, active.length ? active[active.length - 1].endAt : 0), endAt = startAt + days * DAY_MS
  if (!time(endAt) || !Number.isSafeInteger(timeline.revision + 1)) fail('BAD_SUBSCRIPTION')
  return seal({ kind: timeline.kind, version: timeline.version, ownerId: timeline.ownerId, examId: timeline.examId,
    revision: timeline.revision + 1, updatedAt: at, periods: [...timeline.periods, { orderId, startAt, endAt, revoked: false }],
    reservations: timeline.reservations.filter(value => value !== orderId) })
}
function revoke(timeline, orderId, at) {
  if (!timeline || !valid(timeline, timeline.ownerId, timeline.examId)) fail('INVALID_SUBSCRIPTION')
  if (!id(orderId) || !time(at)) fail('BAD_SUBSCRIPTION')
  if (at < timeline.updatedAt) fail('SUBSCRIPTION_CLOCK_ROLLBACK')
  const index = timeline.periods.findIndex(period => period.orderId === orderId)
  if (index < 0 || timeline.periods[index].revoked) fail('SUBSCRIPTION_ORDER_NOT_ACTIVE')
  const target = timeline.periods[index], shift = Math.max(0, target.endAt - Math.max(target.startAt, at))
  const periods = timeline.periods.map((period, i) => {
    if (i === index) return { ...period, revoked: true }
    if (i < index || period.revoked || !shift || period.endAt <= at) return { ...period }
    const move = Math.min(shift, Math.max(0, period.startAt - at))
    return { ...period, startAt: period.startAt - move, endAt: period.endAt - move }
  })
  const next = seal({ kind: timeline.kind, version: timeline.version, ownerId: timeline.ownerId, examId: timeline.examId,
    revision: timeline.revision + 1, updatedAt: at, periods, reservations: timeline.reservations })
  if (!valid(next, timeline.ownerId, timeline.examId)) fail('INVALID_SUBSCRIPTION')
  return next
}
function activeUntil(timeline, ownerId, examId, at) {
  if (!time(at) || !valid(timeline, ownerId, examId) || at < timeline.updatedAt) return null
  const periods = timeline.periods.filter(period => !period.revoked)
  const index = periods.findIndex(period => period.startAt <= at && at < period.endAt)
  if (index < 0) return null
  let endAt = periods[index].endAt
  for (let i = index + 1; i < periods.length && periods[i].startAt === endAt; i++) endAt = periods[i].endAt
  return endAt
}
module.exports = { MAX_PERIODS, DAY_MS, TERM_DAYS, productId, timelineId, empty, valid, reserve, extend, revoke, activeUntil }
