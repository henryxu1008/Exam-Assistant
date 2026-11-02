/** Production store, synthetic history, in-memory storage only. No cloud or real user files. */
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { spawnSync } = require('node:child_process')
const { performance } = require('node:perf_hooks')
const bank = require('../utils/questions.js')
const { getDefaultState } = require('../shared/stats-merge.js')
const { addServerCounts } = require('../shared/attempt-domain.js')
const key = 'exam_quiz_data_v1__anon'
const round = value => Math.round(value * 100) / 100
function fixture(count, includeAI) {
  const state = getDefaultState(), q = bank.getAllQuestions()[0], now = Date.now()
  state.settings.currentSubject = q.subject
  state.attemptOutbox = { version: 1, pending: [] }
  for (let i = 0; i < count; i++) {
    const fact = { id: 'synthetic_' + i, sessionId: 'session_' + i, clientOpId: 'op_' + i, questionId: q.id,
      questionVersionId: q.versionId, bankReleaseId: q.bankReleaseId, questionSnapshot: q,
      selected: q.answer, answer: q.answer, score: 1, costMs: 100, createdAt: now - count + i,
      projection: { version: 1, confirmed: true, date: '2026-11-02', subject: q.subject, chapter: q.chapter } }
    state.attempts.push(fact); addServerCounts(state, fact)
    if (includeAI) state.aiMessages.push({ id: 'synthetic_ai_' + i, role: i % 2 ? 'assistant' : 'user',
      content: '合成 AI 历史，仅测存储，不调用模型。'.repeat(8), createdAt: now - count + i })
  }
  return { state, q }
}
function sample(count, includeAI) {
  const { state, q } = fixture(count, includeAI), storage = new Map([[key, JSON.stringify(state)]])
  let writes = 0, writtenBytes = 0, stringifyMs = 0, lastBytes = 0, store
  const write = (name, value) => {
    const started = performance.now(), text = JSON.stringify(value), elapsed = performance.now() - started
    storage.set(name, text)
    if (name === key) { writes++; lastBytes = Buffer.byteLength(text); writtenBytes += lastBytes; stringifyMs += elapsed }
  }
  const wx = { __cloudReady: false,
    getStorageSync: name => storage.has(name) ? JSON.parse(storage.get(name)) : '',
    setStorageSync: write, setStorage: opts => { write(opts.key, opts.data); if (opts.success) opts.success() },
    removeStorageSync: name => storage.delete(name), cloud: { callFunction() { throw new Error('BENCHMARK_MUST_NOT_ACCESS_CLOUD') } } }
  const module = { exports: {} }, file = path.join(__dirname, '../utils/store.js')
  try {
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, wx, console, setTimeout, clearTimeout,
      require: name => require(path.resolve(path.dirname(file), name)) })
    store = module.exports; store.load()
    store.createPracticeSession({ subject: q.subject, questionIds: [q.id], questions: [q] }); store.flush()
    const beforeBytes = Buffer.byteLength(storage.get(key)), beforeHeap = process.memoryUsage().heapUsed
    writes = 0; writtenBytes = 0; stringifyMs = 0
    const started = performance.now()
    const result = store.submitAttempt(q, q.answer, true, 100, 'synthetic-new-answer', store.getPracticeContext())
    const submitMs = performance.now() - started, afterHeap = process.memoryUsage().heapUsed
    if (!result.ok) throw new Error('BENCHMARK_SUBMIT_FAILED')
    const saved = JSON.parse(storage.get(key))
    if (saved.attempts.length !== count + 1 || saved.attemptOutbox.pending.length !== 1 || saved.aiMessages.length !== (includeAI ? count : 0)) throw new Error('BENCHMARK_HISTORY_LOST')
    return { beforeBytes, afterBytes: lastBytes, dataWrites: writes, writtenBytes, stringifyMs: round(stringifyMs), submitMs: round(submitMs),
      heapAfterMiB: round(afterHeap / 1048576), heapDeltaMiB: round((afterHeap - beforeHeap) / 1048576) }
  } finally { if (store) store.__clearFlushTimer() }
}
function run({ sizes = [1000, 10000], runs = 5 } = {}) {
  if (!Array.isArray(sizes) || !sizes.length || sizes.length > 4 || sizes.some(n => !Number.isInteger(n) || n < 1 || n > 10000) || !Number.isInteger(runs) || runs < 1 || runs > 10) throw new Error('BAD_BENCHMARK_OPTIONS')
  const scenarios = []
  for (const count of sizes) for (const includeAI of [false, true]) {
    const samples = Array.from({ length: runs }, () => {
      const child = spawnSync(process.execPath, [__filename, '--one-sample', String(count), includeAI ? '1' : '0'], { encoding: 'utf8', maxBuffer: 1048576 })
      if (child.status !== 0) throw new Error('BENCHMARK_WORKER_FAILED')
      return JSON.parse(child.stdout)
    })
    const sorted = field => samples.map(s => s[field]).sort((a, b) => a - b)
    const p50 = field => sorted(field)[Math.floor(runs / 2)]
    scenarios.push({ attempts: count, aiMessages: includeAI ? count : 0, runs, beforeBytes: samples[0].beforeBytes,
      afterBytes: samples[0].afterBytes, dataWritesPerAnswer: samples[0].dataWrites, writtenBytesPerAnswer: samples[0].writtenBytes,
      submitP50Ms: p50('submitMs'), submitMaxMs: sorted('submitMs').at(-1), stringifyP50Ms: p50('stringifyMs'),
      observedHeapAfterMaxMiB: sorted('heapAfterMiB').at(-1), samples })
  }
  return { scope: 'synthetic_node_store_baseline', node: process.version, platform: process.platform, arch: process.arch,
    storage: 'memory_with_JSON_serialization', sampling: 'independent_node_process_per_sample', cloudCalls: 0, scenarios }
}
function main(args) {
  const options = {}
  if (args[0] === '--one-sample') {
    const count = Number(args[1])
    if (args.length !== 3 || !Number.isInteger(count) || count < 1 || count > 10000 || !['0', '1'].includes(args[2])) throw new Error('BAD_SAMPLE')
    process.stdout.write(JSON.stringify(sample(count, args[2] === '1')) + '\n')
    return
  }
  for (let i = 0; i < args.length; i += 2) {
    if (!['--sizes', '--runs'].includes(args[i]) || !args[i + 1] || options[args[i]] !== undefined) throw new Error('BAD_USAGE')
    options[args[i]] = args[i + 1]
  }
  process.stdout.write(JSON.stringify(run({ sizes: options['--sizes'] ? options['--sizes'].split(',').map(Number) : undefined,
    runs: options['--runs'] ? Number(options['--runs']) : undefined }), null, 2) + '\n')
}
if (require.main === module) {
  try { main(process.argv.slice(2)) } catch (e) { process.stderr.write('BENCHMARK_FAILED\n'); process.exitCode = 1 }
}
module.exports = { run }
