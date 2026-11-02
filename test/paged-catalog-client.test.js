const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const paged = require('../shared/paged-catalog-domain.js')
const { harness } = require('./support/bank-harness.js')
const { makeHarness } = require('./support/study-sync-harness.js')
const { device } = require('./support/study-sync-device.js')
const domain = require('../shared/question-domain.js')
const sample = require('../docs/examples/catalog-import.json')
const copy = x => JSON.parse(JSON.stringify(x))
function catalog(stem = '') {
  const bank = copy(sample.bank), q = bank.questions.it[0], source = sample.sources[q.id]
  bank.schemaVersion = 4; bank.manifest.exams = [{ id: 'exam', name: '考试' }]; bank.manifest.subjects[0].examId = 'exam'
  bank.questions.it = Array.from({ length: 205 }, (_, i) => ({ ...q, id: 'q' + String(i).padStart(4, '0'), stem: q.stem + stem }))
  return paged.buildPagedCatalog({ ...bank, sources: Object.fromEntries(bank.questions.it.map(x => [x.id, source])) })
}
function seed(h, v, revision) {
  h.documents.set('bank', { schemaVersion: 4, root: copy(v.root), publicationRevision: revision })
  h.documents.set(v.root.releaseId, { kind: 'pagedQuestionBankRelease', root: copy(v.root), publishedAt: 1 })
  for (const page of v.publicPages) h.documents.set(paged.pageDocumentId(page.releaseId, page.index), { kind: 'pagedQuestionBankPage', page: copy(page) })
}
function loadBank(wx) {
  const file = path.join(__dirname, '../utils/bank/index.js'), module = { exports: {} }
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, wx, require: name => require(path.resolve(path.dirname(file), name)) })
  return module.exports
}

test('分片全量验证并落盘后才切换；缺页、并发发布和本机写失败保留旧题库', async () => {
  const h = harness(), a = catalog('旧'), b = catalog('新'), storage = new Map()
  const controls = { failPage: false, failWrite: false, changeAfterPage: false }
  const wx = { __cloudReady: true, getStorageSync: k => copy(storage.has(k) ? storage.get(k) : ''), setStorageSync: (k, v) => {
    if (controls.failWrite) throw new Error('disk full'); storage.set(k, copy(v))
  }, cloud: { async callFunction({ data }) {
    if (controls.failPage && data.action === 'getPagedPage' && data.index === 1) return { result: { ok: false, error: 'READ_PAGED_RELEASE_FAILED' } }
    const result = await h.main(data)
    if (controls.changeAfterPage && data.action === 'getPagedPage') { controls.changeAfterPage = false; seed(h, b, 2) }
    return { result }
  } } }
  seed(h, a, 1); const bank = loadBank(wx)
  assert.equal(await bank.loadCloudBank(), true); assert.equal(bank.getAllQuestions().length, 205)
  assert.equal(bank.findQuestion('q0000').catalogProtocol, 4)
  seed(h, b, 2); controls.failPage = true
  assert.equal(await bank.loadCloudBank(), false); assert.equal(bank.findQuestion('q0000').stem, a.publicPages[0].questions[0].stem)
  controls.failPage = false; controls.failWrite = true
  assert.equal(await bank.loadCloudBank(), false); controls.failWrite = false
  assert.equal(loadBank(wx).findQuestion('q0000').stem, a.publicPages[0].questions[0].stem)
  seed(h, a, 1); controls.changeAfterPage = true
  assert.equal(await bank.loadCloudBank(), false, '下载过程中发布变化不得激活旧页面')
  assert.equal(await bank.loadCloudBank(), true); assert.equal(bank.findQuestion('q0000').stem, b.publicPages[0].questions[0].stem)
})

test('分片题目离线重启后仍固定协议和原发布，按 19 条分批判分并确认', async () => {
  const bh = harness(), v = catalog(), proxy = { getSubjects: () => [] }; seed(bh, v, 1)
  const learning = makeHarness({ questionDocuments: bh.documents }), d = device(learning, undefined, true, proxy)
  try {
    const callStudy = d.wx.cloud.callFunction
    d.wx.cloud.callFunction = opts => opts.name === 'bankSync' ? bh.main(opts.data).then(result => ({ result })) : callStudy(opts)
    Object.assign(proxy, loadBank(d.wx)); assert.equal(await proxy.loadCloudBank(), true)
    d.wx.__cloudReady = false
    const qs = proxy.getAllQuestions().slice(0, 42)
    d.store.createPracticeSession({ subject: qs[0].subject, questionIds: qs.map(q => q.id), questions: qs })
    for (const q of qs) assert.equal(d.store.submitAttempt(q, ['A'], true, 10, q.id).ok, true)
    assert.equal(d.store.load().attemptOutbox.pending.length, 42)
    const saved = new Map(d.storage), next = device(learning, saved, false, {})
    try {
      const restoredBank = loadBank(next.wx); assert.equal(restoredBank.findQuestion(qs[0].id).catalogProtocol, 4)
      next.wx.__cloudReady = true
      const result = await next.store.syncNow(); await next.settle()
      assert.equal(result.ok, true)
      assert.deepEqual(next.controls.requests.filter(r => r.action === 'commitPagedAttempts').map(r => r.attempts.length), [19, 19, 4])
      assert.equal(learning.attempts.size, 42); assert.equal(next.store.load().attemptOutbox.pending.length, 0)
    } finally { next.store.__clearFlushTimer() }
  } finally { d.store.__clearFlushTimer() }
})

test('根指针损坏后重启可从云端完整修复并恢复题库', async () => {
  const h = harness(), first = catalog('首版'), second = catalog('恢复'), storage = new Map()
  const wx = { __cloudReady: true, getStorageSync: k => copy(storage.has(k) ? storage.get(k) : ''), setStorageSync: (k, v) => storage.set(k, copy(v)),
    cloud: { callFunction: ({ data }) => h.main(data).then(result => ({ result })) } }
  seed(h, first, 1); assert.equal(await loadBank(wx).loadCloudBank(), true)
  storage.get('exam_quiz_bank_paged_root_v1').root.releaseId = 'broken'
  const restarted = loadBank(wx); assert.equal(restarted.getAllQuestions().length, 0)
  seed(h, second, 2); assert.equal(await restarted.loadCloudBank(), true)
  assert.equal(restarted.getAllQuestions().length, 205)
  assert.equal(loadBank(wx).findQuestion('q0000').bankReleaseId, second.root.releaseId)
})

test('旧后端拒绝分页协议或错误确认回包时保留待传事实，修复后可补传', async () => {
  const bh = harness(), v = catalog(), learning = makeHarness({ questionDocuments: bh.documents }); seed(bh, v, 1)
  let rejectPaged = true
  const server = { main: event => rejectPaged && event.action === 'commitPagedAttempts' ? Promise.resolve({ ok: false, error: 'BAD_ACTION' }) : learning.main(event) }
  const d = device(server, undefined, false, { getSubjects: () => [], snapshotQuestion: domain.snapshotQuestion })
  try {
    const q = { ...v.publicPages[0].questions[0], bankReleaseId: v.root.releaseId, catalogProtocol: 4 }
    d.store.createPracticeSession({ subject: q.subject, questionIds: [q.id], questions: [q] })
    assert.equal(d.store.submitAttempt(q, ['A'], true, 10, 'pending').ok, true)
    d.wx.__cloudReady = true
    assert.equal((await d.store.syncNow()).error, 'BAD_ACTION'); await d.settle()
    assert.equal(d.store.load().attemptOutbox.pending.length, 1); assert.equal(learning.attempts.size, 0)
    rejectPaged = false; d.controls.changeUpdateResult = result => ({ ...result, questionProtocol: 2 })
    await d.store.syncNow(); await d.settle()
    assert.equal(learning.attempts.size, 1); assert.equal(d.store.load().attemptOutbox.pending.length, 1)
    d.controls.changeUpdateResult = null
    assert.equal((await d.store.syncNow()).ok, true); await d.settle()
    assert.equal(learning.attempts.size, 1); assert.equal(d.store.load().attemptOutbox.pending.length, 0)
  } finally { d.store.__clearFlushTimer() }
})
