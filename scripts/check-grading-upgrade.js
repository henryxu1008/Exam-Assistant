/** Runs trusted previous/current source against synthetic devices and an in-memory DB only. */
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const { makeHarness } = require('../test/support/study-sync-harness.js')
const { device } = require('../test/support/study-sync-device.js')
const { release, question, seed } = require('../test/support/grading-fixture.js')
const questionDomain = require('../shared/question-domain.js')
const grading = require('../shared/grading-domain.js')
const { sameOperation } = require('../shared/attempt-domain.js')
const copy = value => JSON.parse(JSON.stringify(value))
const currentRoot = path.join(__dirname, '..')

async function runUpgradeChecks(previousRoot) {
  previousRoot = path.resolve(previousRoot)
  // Only load an explicitly supplied trusted checkout; never fetch, deploy or read user exports.
  if (!fs.existsSync(path.join(previousRoot, 'utils/config.js')) ||
      require(path.join(previousRoot, 'utils/config.js')).version !== '1.2.0') throw new Error('UPGRADE_BASELINE_REQUIRED')
  const bank = release(), q = question(bank)
  const proxy = { getSubjects: () => bank.manifest.subjects, snapshotQuestion: questionDomain.snapshotQuestion }
  const scenarios = []
  const devices = []
  function offline(server, root, saved) {
    const d = device(server, saved, false, proxy, { sourceRoot: root })
    devices.push(d)
    return d
  }
  function answer(d, correct = true) {
    d.store.createPracticeSession({ subject: q.subject, questions: [q], questionIds: [q.id] })
    assert.equal(d.store.submitAttempt(q, [correct ? 'A' : 'B'], true, 10, 'synthetic-upgrade').ok, true)
    return copy(d.store.load().attemptOutbox.pending)
  }
  async function connect(d) {
    d.wx.__cloudReady = true
    const result = await d.store.syncNow()
    await d.settle()
    return result
  }
  function transfer(from, to) {
    for (const name of ['users', 'studyStats', 'attempts', 'questions']) {
      to[name].clear()
      for (const [id, row] of from[name]) to[name].set(id, copy(row))
    }
  }
  function countedOnce(h, d) {
    assert.equal(h.attempts.size, 1)
    assert.equal(h.studyStats.get('alice').records[q.id].attempts, 1)
    assert.equal(d.store.getRecord(q.id).attempts, 1)
    assert.equal(d.store.load().attemptOutbox.pending.length, 0)
  }
  async function check(id, fn) {
    try { await fn(); scenarios.push({ id, status: 'passed' }) }
    catch (e) { throw Object.assign(new Error('UPGRADE_SCENARIO_FAILED'), { scenario: id }) }
  }
  try {
    await check('previous-client-previous-server', async () => {
      const h = makeHarness({ sourceRoot: previousRoot }), d = offline(h, previousRoot)
      answer(d)
      assert.equal((await connect(d)).ok, true)
      countedOnce(h, d)
      assert.equal([...h.attempts.values()][0].grading, undefined)
      assert.equal(d.controls.requests.find(r => r.attempts?.length).questionProtocol, 1)
    })
    for (const previousClient of [true, false]) {
      await check(previousClient ? 'previous-client-current-server-retains-queue' : 'current-client-previous-server-retains-queue', async () => {
        const h = makeHarness({ sourceRoot: previousClient ? currentRoot : previousRoot })
        seed(h, bank)
        const d = offline(h, previousClient ? previousRoot : currentRoot), pending = answer(d)
        const result = await connect(d)
        assert.equal(result.error, 'QUESTION_PROTOCOL_REQUIRED')
        assert.equal(result.attempts, 1)
        assert.equal(h.attempts.size, 0)
        assert.deepEqual(copy(d.store.load().attemptOutbox.pending), pending)
      })
    }
    await check('current-client-current-server', async () => {
      const h = makeHarness(); seed(h, bank)
      const d = offline(h, currentRoot)
      answer(d)
      assert.equal((await connect(d)).ok, true)
      countedOnce(h, d)
      assert.equal(grading.validGrading(d.store.getAttempts()[0]), true)
      assert.equal(d.controls.requests.find(r => r.attempts?.length).questionProtocol, 2)
    })
    await check('offline-previous-client-upgrades-and-sends-original-fact', async () => {
      const old = offline(makeHarness({ sourceRoot: previousRoot }), previousRoot), pending = answer(old)
      old.store.__clearFlushTimer()
      const h = makeHarness(); seed(h, bank)
      const d = offline(h, currentRoot, old.storage)
      assert.equal((await connect(d)).ok, true)
      const accepted = d.store.getAttempts()[0]
      assert.equal(sameOperation(accepted, pending[0]), true)
      assert.equal(accepted.createdAt, pending[0].createdAt)
      assert.equal(accepted.costMs, pending[0].costMs)
      assert.equal(grading.validGrading(accepted), true)
      countedOnce(h, d)
    })
    await check('previous-lost-ack-upgrade-preserves-unverified-accepted-fact', async () => {
      const before = makeHarness({ sourceRoot: previousRoot }), old = offline(before, previousRoot)
      answer(old, false) // Previous server accepted incorrect client scores; history must not be rewritten.
      old.wx.__cloudReady = true; old.controls.loseUpdateAck = true
      old.store.flush(); await old.settle(); old.store.__clearFlushTimer()
      assert.equal(old.store.load().attemptOutbox.pending.length, 1)
      assert.equal(before.attempts.size, 1)
      const original = copy([...before.attempts])
      const after = makeHarness(); transfer(before, after)
      const d = offline(after, currentRoot, old.storage)
      assert.equal((await connect(d)).ok, true)
      assert.deepEqual([...after.attempts], original)
      countedOnce(after, d)
      assert.equal(d.store.getAttempts()[0].grading, undefined)
      assert.equal(d.store.getAttempts()[0].serverReceivedAt, undefined)
    })
    await check('backend-rollback-retains-graded-fact-and-queue-forward-recovery', async () => {
      const before = makeHarness(); seed(before, bank)
      const first = offline(before, currentRoot)
      answer(first)
      first.wx.__cloudReady = true; first.controls.loseUpdateAck = true
      first.store.flush(); await first.settle(); first.store.__clearFlushTimer()
      assert.equal(first.store.load().attemptOutbox.pending.length, 1)
      const original = copy([...before.attempts])
      const rollback = makeHarness({ sourceRoot: previousRoot }); transfer(before, rollback)
      const d = offline(rollback, currentRoot, first.storage)
      assert.equal((await connect(d)).error, 'QUESTION_PROTOCOL_REQUIRED')
      assert.equal(d.store.load().attemptOutbox.pending.length, 1)
      assert.deepEqual([...rollback.attempts], original)
      d.store.__clearFlushTimer()
      const recovered = makeHarness(); transfer(rollback, recovered)
      const forward = offline(recovered, currentRoot, d.storage)
      assert.equal((await connect(forward)).ok, true)
      assert.deepEqual([...recovered.attempts], original)
      countedOnce(recovered, forward)
      assert.equal(grading.validGrading(forward.store.getAttempts()[0]), true)
    })
    await check('missing-archive-retains-queue-until-authorized-publication', async () => {
      const h = makeHarness(), d = offline(h, currentRoot), pending = answer(d)
      assert.equal((await connect(d)).error, 'PUBLISHED_RELEASE_NOT_FOUND')
      assert.deepEqual(copy(d.store.load().attemptOutbox.pending), pending)
      assert.equal(h.attempts.size, 0)
      seed(h, bank) // Explicit synthetic publication fixture; the client never seeds archives.
      assert.equal((await connect(d)).ok, true)
      countedOnce(h, d)
      assert.equal(sameOperation(d.store.getAttempts()[0], pending[0]), true)
    })
    return { status: 'passed', environment: 'synthetic-only', previousVersion: '1.2.0', currentVersion: require('../utils/config.js').version,
      scenarios, nativeCloudVerified: false, nativeWechatVerified: false }
  } finally { devices.forEach(d => d.store.__clearFlushTimer()) }
}

async function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write('Usage: npm run check:grading-upgrade -- --previous-dir <trusted-1.2.0-checkout>\n'); return 0
  }
  if (args.length !== 2 || args[0] !== '--previous-dir' || !args[1]) throw new Error('BAD_USAGE')
  process.stdout.write(JSON.stringify(await runUpgradeChecks(args[1]), null, 2) + '\n')
  return 0
}
if (require.main === module) main(process.argv.slice(2)).then(code => { process.exitCode = code }, e => {
  process.stderr.write(JSON.stringify({ error: ['BAD_USAGE', 'UPGRADE_BASELINE_REQUIRED', 'UPGRADE_SCENARIO_FAILED'].includes(e.message) ? e.message : 'UPGRADE_INPUT_FAILED',
    ...(e.scenario ? { scenario: e.scenario } : {}) }) + '\n')
  process.exitCode = 1
})
module.exports = { runUpgradeChecks }
