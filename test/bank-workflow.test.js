const { test } = require('node:test')
const assert = require('node:assert/strict')
const { harness, ADMIN_TOKEN, USER_TOKEN } = require('./support/bank-harness.js')
const clone = v => JSON.parse(JSON.stringify(v))
const bank = () => ({ manifest: { subjects: [{ key: 'it', name: '专业', chapters: [{ key: 'net', name: '网络' }] }] },
  questions: { it: [{ id: 'Q1', subject: '专业', chapter: '网络', type: 'single', stem: '合成测试题',
    options: [{ key: 'A', text: '甲' }, { key: 'B', text: '乙' }], answer: ['A'], explain: '合成解析' }] } })
const sources = () => ({ Q1: { kind: 'original', title: '测试原创题', reference: 'synthetic:author-record-1',
  permission: '测试作者确认拥有发布权', attribution: '测试作者' } })
function setup() {
  const h = harness({ env: { ADMIN_SECRET: 'secret', ADMIN_OPENIDS: 'admin-openid' } })
  for (const id of ['editor', 'reviewer', 'publisher', 'reviewer2']) h.users.set(id,
    { _id: id, openid: id, token: id, tokenAt: Date.parse('2026-10-30T06:00:00Z') })
  h.config.set('bankRoles', { editors: ['editor'], reviewers: ['reviewer', 'reviewer2'], publishers: ['publisher'] })
  return h
}
const create = (h, extra = {}) => h.main({ action: 'createDraft', token: 'editor', submissionId: 'submission-1', rightsConfirmed: true, bank: bank(), sources: sources(), ...extra })
const review = (h, draftId, extra = {}) => h.main({ action: 'reviewDraft', token: 'reviewer', draftId, decision: 'approve', note: '已核对题目及来源证据', sourceVerified: true, ...extra })
const publish = (h, draftId, extra = {}) => h.main({ action: 'publishDraft', token: 'publisher', draftId, expectedRevision: 0, ...extra })
const legacyPublish = h => h.main({ action: 'publish', token: ADMIN_TOKEN, bank: bank(), reviewed: true, expectedRevision: 0 })
async function approved(h, extra = {}) { const draft = await create(h, extra); assert.equal(draft.ok, true); assert.equal((await review(h, draft.draftId)).ok, true); return draft.draftId }

test('独立编辑、审核与发布闭环，来源及真实身份绑定到不可变审核和发布审计', async () => {
  const h = setup(), draft = await create(h)
  assert.equal(draft.ok, true); assert.equal(draft.state, 'draft')
  assert.equal((await h.main({ action: 'getPublished' })).bank, null)
  assert.equal((await h.main({ action: 'get' })).bank, null, '草稿不进入兼容读入口')
  assert.equal((await h.main({ action: 'getDraft', token: USER_TOKEN, draftId: draft.draftId })).error, 'NOT_CATALOG_ROLE')
  assert.equal((await h.main({ action: 'getDraft', token: 'reviewer', draftId: draft.draftId })).draft.sources.Q1.kind, 'original')
  assert.equal((await review(h, draft.draftId, { reviewedBy: 'spoof', createdBy: 'spoof' })).ok, true)
  const result = await publish(h, draft.draftId, { sources: {}, bank: {} })
  assert.equal(result.ok, true)
  assert.equal(h.bank().workflowVersion, 1)
  assert.equal(h.documents.get(draft.draftId).state, 'published')
  const audit = h.documents.get('bank_publication_1')
  assert.equal(audit.by, 'publisher'); assert.equal(audit.approval.reviewedBy, 'reviewer')
  assert.equal(audit.approval.payloadDigest, h.documents.get(draft.draftId).payloadDigest)
  assert.deepEqual(h.documents.get(draft.draftId).sources, sources())
  assert.equal((await h.main({ action: 'getPublished' })).bank.questions.it[0].stem, '合成测试题')
  assert.equal(h.transactions.every(trace => trace.length <= 12), true)
})

test('启用审核后旧发布与 set 不能绕过流程，管理员密钥也不能降级', async () => {
  const h = setup()
  h.documents.set('bank_workflow', { version: 1, required: true })
  assert.equal((await legacyPublish(h)).error, 'REVIEW_WORKFLOW_REQUIRED')
  assert.equal((await h.main({ action: 'set', adminSecret: 'secret', force: true, bank: bank() })).error, 'REVIEW_WORKFLOW_REQUIRED')
  assert.equal(h.bank(), null)
})

test('最小角色不继承全局管理员或共享密钥权限，不允许错误凭据回退', async () => {
  for (const extra of [{ token: USER_TOKEN }, { token: ADMIN_TOKEN }, { token: 'publisher' },
    { adminSecret: 'secret' }, { adminSecret: 'wrong' }, { token: '' }, { token: 'stale-token' }]) {
    const h = setup()
    assert.equal((await create(h, extra)).ok, false)
    assert.equal(h.documents.size, 0)
  }
  const h = setup(); h.config.delete('bankRoles')
  assert.equal((await create(h)).error, 'ROLE_CONFIG_REQUIRED')
  h.config.set('bankRoles', { editors: 'editor', reviewers: [], publishers: [] })
  assert.equal((await create(h)).error, 'ROLE_CONFIG_REQUIRED')
})

test('逐题来源、授权确认、AI 生成声明缺失均拒绝，非法内容不会启用半个流程', async () => {
  for (const extra of [{ submissionId: 123 }, { sources: {} }, { sources: { Q1: sources().Q1, extra: sources().Q1 } }, { rightsConfirmed: false },
    { sources: { Q1: { ...sources().Q1, kind: 'ai_generated' } } }, { sources: { Q1: { ...sources().Q1, permission: '' } } }]) {
    const h = setup(); assert.equal((await create(h, extra)).ok, false); assert.equal(h.documents.size, 0)
  }
  const h = setup()
  assert.equal((await create(h, { sources: { Q1: { ...sources().Q1, kind: 'ai_generated', generator: 'synthetic-model' } } })).ok, true)
})

test('提交 ID 幂等，修改题目或来源必须创建新提交，不能替换待审内容', async () => {
  const h = setup(), first = await create(h), before = clone([...h.documents])
  assert.equal((await create(h)).replayed, true)
  assert.deepEqual([...h.documents], before)
  const changed = sources(); changed.Q1.reference = 'synthetic:different-evidence'
  assert.equal((await create(h, { sources: changed })).error, 'DRAFT_OPERATION_CONFLICT')
  const next = await create(h, { submissionId: 'submission-2', sources: changed })
  assert.notEqual(next.draftId, first.draftId)
})

test('提交人即使兼有审核角色也不能自审，未经来源核验和拒绝的草稿不能发布', async () => {
  const h = setup(), draft = await create(h)
  h.config.get('bankRoles').reviewers.push('editor')
  assert.equal((await review(h, draft.draftId, { token: 'editor' })).error, 'SELF_REVIEW_FORBIDDEN')
  assert.equal((await publish(h, draft.draftId)).error, 'DRAFT_NOT_APPROVED')
  assert.equal((await review(h, draft.draftId, { sourceVerified: false })).error, 'SOURCE_REVIEW_REQUIRED')
  assert.equal((await review(h, draft.draftId, { decision: 'reject', note: '来源证明不足' })).ok, true)
  assert.equal((await publish(h, draft.draftId)).error, 'DRAFT_NOT_APPROVED')
  assert.equal((await review(h, draft.draftId)).error, 'REVIEW_ALREADY_DECIDED')
  assert.equal((await h.main({ action: 'getPublished' })).bank, null)
})

test('并发审核只记录一次决定，同一人同决定重试幂等，另一人不得覆盖', async () => {
  const h = setup(), draft = await create(h)
  const results = await Promise.all([review(h, draft.draftId), review(h, draft.draftId, { token: 'reviewer2', decision: 'reject', note: '不同结论' })])
  assert.equal(results.filter(r => r.ok).length, 1)
  assert.equal(results.filter(r => r.error === 'REVIEW_ALREADY_DECIDED').length, 1)
  const before = clone([...h.documents])
  assert.equal((await review(h, draft.draftId)).replayed, true)
  assert.deepEqual([...h.documents], before)
})

test('审批后变造内容、来源或审核收据均拒绝，不将摘要当作可信审批', async () => {
  for (const alter of [(h, id) => { h.documents.get(id).bank.questions.it[0].stem = '被改题面' },
    (h, id) => { h.documents.get(id).sources.Q1.permission = '被改授权' },
    (h, id) => { h.documents.get(id + '_review').payloadDigest = 'spoof' }]) {
    const h = setup(), id = await approved(h); alter(h, id)
    assert.equal((await publish(h, id)).ok, false); assert.equal(h.bank(), null)
  }
})

test('事务内重新校验角色与 token，查询后撤权/换令牌不会沿用旧权限', async () => {
  for (const revoke of [h => { h.config.get('bankRoles').editors = [] }, h => { h.users.get('editor').token = 'new-token' }]) {
    const h = setup(); h.fail.beforeTransaction = () => revoke(h)
    assert.equal((await create(h)).ok, false); assert.equal(h.documents.size, 0)
  }
  const h = setup(), id = await approved(h)
  h.config.get('bankRoles').reviewers = []
  assert.equal((await publish(h, id)).error, 'REVIEWER_NOT_AUTHORIZED')
  assert.equal(h.documents.get(id).state, 'approved')
})

test('权限/工作流读取失败不得放宽旧写入口或启用流程，无事务时拒绝', async () => {
  const h = setup(); h.fail.query = true
  assert.equal((await create(h)).error, 'READ_AUTH_FAILED'); assert.equal(h.documents.size, 0)
  h.fail.query = null; h.fail.get = (name, id) => id === 'bankRoles'
  assert.equal((await create(h)).error, 'WORKFLOW_FAILED'); assert.equal(h.documents.size, 0)
  h.fail.get = null; await create(h)
  const before = clone([...h.documents]); h.fail.get = (name, id) => id === 'bank_workflow'
  assert.equal((await legacyPublish(h)).ok, false)
  assert.deepEqual([...h.documents], before)
  const other = setup(); delete other.db.runTransaction
  assert.equal((await create(other)).error, 'TRANSACTION_REQUIRED'); assert.equal(other.documents.size, 0)
})

test('创建/审核/发布各步写入中途失败整体回滚，不能留下批准或发布的半状态', async () => {
  const creating = setup(); creating.fail.write = (name, id) => id.startsWith('qd_')
  assert.equal((await create(creating)).error, 'WORKFLOW_FAILED'); assert.equal(creating.documents.size, 0)
  const reviewing = setup(), draft = await create(reviewing), before = clone([...reviewing.documents])
  reviewing.fail.write = (name, id) => id === draft.draftId
  assert.equal((await review(reviewing, draft.draftId)).error, 'WORKFLOW_FAILED')
  assert.deepEqual([...reviewing.documents], before)
  const publishing = setup(), id = await approved(publishing), approvedState = clone([...publishing.documents])
  publishing.fail.write = (name, key) => key === id
  assert.equal((await publish(publishing, id)).error, 'WORKFLOW_FAILED')
  assert.deepEqual([...publishing.documents], approvedState)
  publishing.fail.write = null
  assert.equal((await publish(publishing, id)).ok, true)
})

test('过时修订不消耗已批准草稿，并发或丢 ACK 重试不会重复激活', async () => {
  const h = setup(); assert.equal((await legacyPublish(h)).ok, true)
  const id = await approved(h)
  assert.equal((await publish(h, id)).error, 'STALE_PUBLICATION')
  assert.equal(h.documents.get(id).state, 'approved')
  const results = await Promise.all([publish(h, id, { expectedRevision: 1 }), publish(h, id, { expectedRevision: 1 })])
  assert.equal(results.every(r => r.ok), true)
  assert.equal(results.filter(r => r.alreadyPublished).length, 1)
  assert.equal(h.bank().publicationRevision, 2)
})

test('流程开关不能被角色配置降级，损坏或丢失标记时已有严格发布仍阻断旧入口', async () => {
  const h = setup(), id = await approved(h)
  assert.equal((await publish(h, id)).ok, true)
  h.config.delete('bankRoles')
  assert.equal((await legacyPublish(h)).error, 'REVIEW_WORKFLOW_REQUIRED')
  h.documents.delete('bank_workflow')
  assert.equal((await legacyPublish(h)).error, 'REVIEW_WORKFLOW_REQUIRED')
  h.documents.set('bank_workflow', { required: false })
  assert.equal((await legacyPublish(h)).error, 'PUBLISH_FAILED')
  assert.equal(h.bank().publicationRevision, 1)
})

test('启用与旧发布并发时按事务顺序生效，启用之后旧写入不能插入', async () => {
  const h = setup()
  const [draft, legacy] = await Promise.all([create(h), legacyPublish(h)])
  assert.equal(draft.ok, true); assert.equal(legacy.error, 'REVIEW_WORKFLOW_REQUIRED')
  assert.equal(h.bank(), null)
})

test('回滚也重新提交、独立审核和按当前修订发布，原始版本及审核证据保留', async () => {
  const h = setup(), first = await approved(h), result = await publish(h, first)
  const archive = clone(h.documents.get(result.releaseId))
  const changed = bank(); changed.questions.it[0].stem = '修订题'
  const next = await approved(h, { submissionId: 'next', bank: changed })
  assert.equal((await publish(h, next, { expectedRevision: 1 })).ok, true)
  assert.equal((await publish(h, first, { expectedRevision: 2 })).alreadyPublished, true, '已发布草稿重放不会回滚当前源')
  assert.equal(h.bank().questions.it[0].stem, '修订题')
  const rollback = await approved(h, { submissionId: 'rollback' })
  assert.equal((await publish(h, rollback, { expectedRevision: 2 })).ok, true)
  assert.equal(h.bank().questions.it[0].stem, '合成测试题')
  assert.deepEqual(h.documents.get(result.releaseId), archive)
  assert.equal(h.documents.get('bank_publication_3').approval.draftId, rollback)
})
