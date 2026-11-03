/** Coordinates durable operations with account, reset generation and full-history snapshots. */
const { runtimeProtectedStudyClient } = require('./protected-study-client.js')
const { createProtectedOutbox } = require('./protected-study-outbox.js')
const store = require('./store.js')
const fail = code => { throw Object.assign(new Error(code), { code }) }
function createProtectedStudySession({ client, outbox, captureSync, syncCurrent }) {
  function capture() {
    const identity = client.capture(), sync = captureSync()
    if (!sync || identity.openid !== sync.scope || identity.token !== sync.token) fail('STALE_CONTEXT')
    return { identity, sync, owner: identity.openid, dataEpoch: sync.dataEpoch }
  }
  function current(ctx) { return !!ctx && client.current(ctx.identity) && syncCurrent(ctx.sync) }
  function check(ctx) { if (!current(ctx)) fail('STALE_CONTEXT') }
  async function prepare(examId, ctx) {
    check(ctx)
    // Confirm epoch at the server before retiring requests from an earlier clear.
    await client.restore(examId, ctx.dataEpoch, ctx.identity)
    check(ctx)
    if (ctx.dataEpoch > 0) outbox.retireAfterConfirmedClear(ctx.owner, ctx.dataEpoch)
    const pending = outbox.read(ctx.owner).pending
    if (pending.some(op => op.dataEpoch !== ctx.dataEpoch)) fail('STALE_EPOCH')
    for (const op of pending) {
      check(ctx)
      const receipt = await client.commit(op, ctx.identity)
      check(ctx)
      outbox.acknowledge(ctx.owner, op, receipt)
    }
    check(ctx)
    const history = await client.restore(examId, ctx.dataEpoch, ctx.identity)
    check(ctx)
    return history
  }
  async function submit(ctx, operation) {
    check(ctx)
    if (!operation || operation.dataEpoch !== ctx.dataEpoch) fail('STALE_EPOCH')
    outbox.enqueue(ctx.owner, operation)
    check(ctx)
    const receipt = await client.commit(operation, ctx.identity)
    check(ctx)
    outbox.acknowledge(ctx.owner, operation, receipt)
    return receipt
  }
  return { capture, current, prepare, submit }
}
function runtimeProtectedStudySession() {
  return createProtectedStudySession({ client: runtimeProtectedStudyClient(), outbox: createProtectedOutbox(wx),
    captureSync: () => store.captureProtectedSyncContext(), syncCurrent: ctx => store.isProtectedSyncContextCurrent(ctx) })
}
module.exports = { createProtectedStudySession, runtimeProtectedStudySession }
