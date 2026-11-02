const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const { operators } = require('./support/catalog-operators.js')
const { createCatalogAdmin } = require('../utils/catalog-admin.js')
const { device } = require('./support/study-sync-device.js')
const { makeHarness } = require('./support/study-sync-harness.js')
const sample = fs.readFileSync(path.join(__dirname, '../docs/examples/catalog-import.json'), 'utf8')
const prepared = () => JSON.parse(sample)
const submit = (ops, id, input = prepared()) => ops.editor.submitDraft(input, { submissionId: id, rightsConfirmed: true })
async function publish(ops, id, revision) { await ops.approve(id); return ops.publisher.publish({ draftId: id, expectedRevision: revision }) }

test('管理客户端只取得当前人的角色，普通账号不能读取私有证据或提交', async () => {
  const ops = operators()
  assert.deepEqual((await ops.editor.access()).roles, ['editors'])
  const normal = createCatalogAdmin({ getSession: () => ({ logged: true, openid: 'normal-openid', token: 'user-token' }), call: data => ops.h.main(data) })
  assert.deepEqual(Array.from((await normal.access()).roles), [])
  await assert.rejects(normal.submitDraft(prepared(), { submissionId: 'normal', rightsConfirmed: true }), /NOT_CATALOG_ROLE/)
  assert.equal(ops.h.documents.size, 0)
})

test('CSV/JSON 导入、独立审核、发布、真实学习同步、纠错与撤回完整链路', async () => {
  const ops = operators(), first = await submit(ops, 'first')
  assert.equal((await ops.publisher.published()).bank, null)
  await assert.rejects(ops.publisher.publish({ draftId: first.draftId, expectedRevision: 0 }), /DRAFT_NOT_APPROVED/)
  await publish(ops, first.draftId, 0)
  const learning = makeHarness({ questionDocuments: ops.h.documents }), bankProxy = { getSubjects: () => [{ name: '专业知识' }] }
  const consumer = device(learning, undefined, true, bankProxy)
  try {
    const original = consumer.wx.cloud.callFunction
    consumer.wx.cloud.callFunction = opts => opts.name === 'bankSync' ? ops.h.main(opts.data).then(result => ({ result })) : original(opts)
    const file = path.join(__dirname, '../utils/bank/index.js'), module = { exports: {} }
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, wx: consumer.wx, require: name => require(path.resolve(path.dirname(file), name)) })
    Object.assign(bankProxy, module.exports)
    assert.equal(await bankProxy.loadCloudBank(), true)
    await consumer.settle()
    const questions = bankProxy.getAllQuestions(), q = questions[0]
    consumer.store.createPracticeSession({ subject: q.subject, questionIds: questions.map(q => q.id), questions })
    for (const current of questions) assert.equal(consumer.store.submitAttempt(current, current.type === 'fill' ? ['协议'] : current.answer, true, 10, 'op-' + current.id).ok, true)
    await consumer.settle()
    assert.equal((await learning.main({ action: 'get', token: 'tokA' })).attempts.length, 2)
    const facts = consumer.store.getAttempts()
    const fixed = prepared(); fixed.bank.questions.it[0].stem = '纠错后的题面'; fixed.bank.questions.it[0].answer = ['B']
    const correction = await submit(ops, 'correction', fixed); await publish(ops, correction.draftId, 1)
    assert.equal(await bankProxy.loadCloudBank(), true)
    assert.equal(bankProxy.findQuestion(q.id).stem, '纠错后的题面')
    assert.equal(bankProxy.resolveAttemptQuestion(facts.find(a => a.questionId === q.id)).stem, q.stem)
    assert.notEqual(bankProxy.findQuestion(q.id).versionId, q.versionId)
    const withdrawal = await ops.editor.withdraw({ draftId: correction.draftId, questionIds: ['DEMO-2'], submissionId: 'withdraw', rightsConfirmed: true })
    assert.equal((await ops.publisher.published()).bank.questions.it.length, 2, '撤回草稿未发布前不改当前库')
    await publish(ops, withdrawal.draftId, 2)
    assert.equal(await bankProxy.loadCloudBank(), true)
    assert.equal(bankProxy.findQuestion('DEMO-2'), null)
    assert.ok(bankProxy.resolveAttemptQuestion(facts.find(a => a.questionId === 'DEMO-2')))
    const old = await ops.h.main({ action: 'getVersion', releaseId: q.bankReleaseId, versionId: q.versionId })
    assert.equal(old.question.stem, q.stem)
    assert.equal(consumer.store.load().attemptOutbox.pending.length, 0)
  } finally { consumer.store.__clearFlushTimer() }
})

test('撤回绑定发布基线，创建后发生新发布也不能改成最新修订强行覆盖', async () => {
  const ops = operators(), base = await submit(ops, 'base'); await publish(ops, base.draftId, 0)
  const withdrawal = await ops.editor.withdraw({ draftId: base.draftId, questionIds: ['DEMO-1'], submissionId: 'withdraw', rightsConfirmed: true })
  const changed = prepared(); changed.bank.questions.it[0].stem = '另一份新发布'
  const newer = await submit(ops, 'newer', changed); await publish(ops, newer.draftId, 1)
  await ops.approve(withdrawal.draftId)
  await assert.rejects(ops.publisher.publish({ draftId: withdrawal.draftId, expectedRevision: 2 }), /STALE_BASE_RELEASE/)
  assert.equal((await ops.publisher.published()).bank.questions.it[0].stem, '另一份新发布')
  await assert.rejects(ops.editor.withdraw({ draftId: base.draftId, questionIds: ['DEMO-1'], submissionId: 'late', rightsConfirmed: true }), /STALE_BASE_RELEASE/)
  assert.equal(ops.h.documents.get(withdrawal.draftId).state, 'approved')
})

test('撤回未知题号、未发布基线或缺少权利确认不能写入，全部撤回仍需审核', async () => {
  const ops = operators(), base = await submit(ops, 'base')
  const options = { draftId: base.draftId, questionIds: ['DEMO-1'], submissionId: 'withdraw', rightsConfirmed: true }
  await assert.rejects(ops.editor.withdraw(options), /BASE_NOT_PUBLISHED/)
  await publish(ops, base.draftId, 0)
  const before = ops.h.documents.size
  await assert.rejects(ops.editor.withdraw({ ...options, questionIds: ['UNKNOWN'] }), /UNKNOWN_QUESTION_ID/)
  await assert.rejects(ops.editor.withdraw({ ...options, rightsConfirmed: false }), /RIGHTS_CONFIRMATION_REQUIRED/)
  assert.equal(ops.h.documents.size, before)
  const all = await ops.editor.withdraw({ ...options, questionIds: ['DEMO-1', 'DEMO-2'] })
  assert.equal((await ops.publisher.published()).bank.questions.it.length, 2)
  await publish(ops, all.draftId, 1)
  assert.equal((await ops.publisher.published()).bank.questions.it.length, 0)
})

test('切换账号或传输失败保留明确失败，旧操作不能接着在新账号提交撤回', async () => {
  const ops = operators(), base = await submit(ops, 'base'); await publish(ops, base.draftId, 0)
  let session = { logged: true, openid: 'editor', token: 'editor' }, writes = 0
  const client = createCatalogAdmin({ getSession: () => session, call: async data => {
    if (data.action === 'createDraft') writes++
    const result = await ops.h.main(data)
    if (data.action === 'getDraft') session = { logged: true, openid: 'reviewer', token: 'reviewer' }
    return result
  } })
  await assert.rejects(client.withdraw({ draftId: base.draftId, questionIds: ['DEMO-1'], submissionId: 'stale', rightsConfirmed: true }), /STALE_OPERATOR_CONTEXT/)
  assert.equal(writes, 0)
  const offline = createCatalogAdmin({ getSession: () => session, call: async () => { throw new Error('private transport details') } })
  await assert.rejects(offline.access(), /NETWORK_ERROR/)
  assert.throws(() => ops.publisher.publish({ draftId: base.draftId, expectedRevision: '0' }), /BAD_REVISION/)
})
