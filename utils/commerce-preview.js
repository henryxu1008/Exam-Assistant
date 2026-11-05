/** Isolated in-memory demo: no cloud, storage, account or real learning records. */
const terms = require('../shared/subscription-domain.js')
function createPreview(now = Date.now()) {
  let clock = now, timeline = terms.empty('demo_user', 'demo_exam'), counter = 0, last = ''
  function active() { return terms.activeUntil(timeline, 'demo_user', 'demo_exam', clock) }
  return {
    state: () => ({ active: active() !== null, endAt: active() }),
    buy(days) {
      if (!terms.TERM_DAYS.includes(days)) throw new Error('BAD_TERM')
      last = 'demo_' + (++counter)
      timeline = terms.extend(terms.reserve(timeline, last, clock), last, days, clock)
      return this.state()
    },
    expire() { const end = active(); if (end !== null) clock = end; return this.state() },
    refund() { if (last) { const period = timeline.periods.find(p => p.orderId === last); if (period && !period.revoked) timeline = terms.revoke(timeline, last, clock) } return this.state() },
    answer(choice) { if (active() === null) throw new Error('ENTITLEMENT_REQUIRED'); return { correct: choice === 'B' } }
  }
}
module.exports = { createPreview }
