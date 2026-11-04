require('./wx-shim.js')
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { makeHarness } = require('./support/study-sync-harness.js')
const { createProtectedStudy } = require('../cloudfunctions/bankSync/protected-study.js')
const { createProtectedReader } = require('../cloudfunctions/bankSync/protected-reader.js')
const { createProtectedState } = require('../cloudfunctions/bankSync/protected-state.js')
const { createProtectedMarkerClient } = require('../utils/protected-marker-client.js')
const { createProtectedStudyClient } = require('../utils/protected-study-client.js')
const { createProtectedPracticeClient } = require('../utils/protected-practice-client.js')
const { createProtectedReportLoader } = require('../utils/protected-report-loader.js')
const { buildProtectedLearningReport } = require('../utils/protected-learning-report.js')
const { createProtectedStudySession } = require('../utils/protected-study-session.js')
const { createProtectedOutbox } = require('../utils/protected-study-outbox.js')
const store = require('../utils/store.js'), user = require('../utils/user.js'), bankApi = require('../utils/questions.js')
const analytics = require('../utils/analytics.js'), config = require('../utils/config.js')
const paged = require('../shared/paged-catalog-domain.js'), policy = require('../shared/exam-access-policy.js')
const subscriptions = require('../shared/subscription-domain.js'), sample = require('../docs/examples/catalog-import.json')
const clone = x => JSON.parse(JSON.stringify(x)), NOW = Date.parse('2026-10-30T06:00:00Z')
const settle = () => new Promise(setImmediate)
function setup(t) {
  __wxStorage.clearAll()
  const h = makeHarness(), bank = clone(sample.bank), template = bank.questions.it[0], source = sample.sources[template.id]
  bank.schemaVersion = 4; bank.manifest.exams = [{ id: 'exam_a', name: '考试甲' }, { id: 'exam_b', name: '考试乙' }]
  bank.manifest.subjects = [{ key: 'a', name: '甲科', examId: 'exam_a', chapters: [{ key: 'net', name: '网络' }] },
    { key: 'a2', name: '第二科', examId: 'exam_a', chapters: [{ key: 'data', name: '数据' }] },
    { key: 'b', name: '乙科', examId: 'exam_b', chapters: [{ key: 'net', name: '网络' }] }]
  bank.questions = { a: [{ ...clone(template), id: 'A', subject: 'a', chapter: 'net', stem: '受保护题目甲' }],
    a2: [{ ...clone(template), id: 'B', subject: 'a2', chapter: 'data', stem: '受保护题目乙' }],
    b: [{ ...clone(template), id: 'C', subject: 'b', chapter: 'net', stem: '另一考试秘密' }] }
  const built = paged.buildPagedCatalog({ ...bank, sources: { A: source, B: source, C: source } })
  h.questions.set('bank', { schemaVersion: 4, root: built.root, publicationRevision: 1 })
  h.questions.set(built.root.releaseId, { kind: 'pagedQuestionBankRelease', root: built.root, publishedAt: NOW })
  for (const page of built.publicPages) h.questions.set(paged.pageDocumentId(page.releaseId, page.index), { kind: 'pagedQuestionBankPage', page })
  h.appConfig.set('examAccessPolicy', policy.buildPolicy(built.root, 1, [{ examId: 'exam_a', access: 'paid' }, { examId: 'exam_b', access: 'free' }]))
  const timelineKey = subscriptions.timelineId('alice', 'exam_a')
  h.commerceTimelines.set(timelineKey, subscriptions.extend(subscriptions.reserve(subscriptions.empty('alice', 'exam_a'), 'one', NOW), 'one', 30, NOW))
  let clock = NOW, session = { logged: true, openid: 'alice', token: 'tokA' }, examId = 'exam_a', generation = 1
  const service = createProtectedStudy({ db: h.db, now: () => clock }), read = createProtectedReader({ db: h.db, now: () => clock })
  const client = createProtectedStudyClient({ getSession: () => session, call: data => service(data, { OPENID: session.openid }) })
  const reader = createProtectedPracticeClient({ getSession: () => session, call: data => read(data, { OPENID: session.openid }) })
  const recorder = createProtectedStudySession({ client, outbox: createProtectedOutbox(wx),
    captureSync: () => ({ scope: session.openid, token: session.token, dataEpoch: 0, generation }),
    syncCurrent: ctx => ctx.generation === generation && ctx.scope === session.openid && ctx.token === session.token })
  const markerService = createProtectedState({ db: h.db, now: () => clock })
  const markers = createProtectedMarkerClient({ call: data => markerService(data, { OPENID: session.openid }) })
  const loader = createProtectedReportLoader({ client, reader, session: recorder, getExam: () => examId, markers })
  const q = id => built.publicPages.flatMap(p => p.questions).find(q => q.id === id)
  const add = async (id, op, correct, target = 'exam_a') => {
    const question = q(id), choice = correct ? question.answer[0] : question.options.find(option => !question.answer.includes(option.key)).key
    return service({ action: 'commitProtectedAttempt', token: 'tokA', examId: target, dataEpoch: 0, operationId: op, releaseId: built.root.releaseId,
      publicationRevision: 1, questionId: id, questionVersionId: question.versionId, selected: [choice], costMs: 1000 }, { OPENID: 'alice' })
  }
  const old = { records: config.protectedRecordsPreview, practice: config.protectedPracticePreview }
  config.protectedRecordsPreview = true; config.protectedPracticePreview = true
  t.mock.method(user, 'whenReady', cb => cb()); t.mock.method(store, 'getCurrentExam', () => examId); t.mock.method(store, 'getCurrentSubject', () => 'a')
  t.mock.method(store, 'getRecords', () => ({})); t.mock.method(store, 'getDueRecords', () => []); t.mock.method(store, 'onSyncRestored', () => () => {})
  t.mock.method(bankApi, 'getSubjects', () => []); t.mock.method(bankApi, 'getSubjectLabel', id => ({ a: '甲科', a2: '第二科', b: '乙科' }[id] || id))
  t.mock.method(bankApi, 'getChapterLabel', (_subject, id) => id)
  t.after(() => { config.protectedRecordsPreview = old.records; config.protectedPracticePreview = old.practice; __wxStorage.clearAll() })
  return { h, bank, built, timelineKey, q, add, loader, reader, recorder, client, markers, clock: v => { clock = v },
    session: v => { session = v; generation++ }, exam: v => { examId = v; generation++ } }
}
function page(file, loader, reader) {
  let definition
  global.getApp = () => ({ globalData: {}, startPractice() {} })
  global.Page = value => { definition = value }
  const location = require.resolve(file); delete require.cache[location]; require(location)
  const p = Object.assign({}, definition, { data: clone(definition.data), setData(value, done) { Object.assign(this.data, value); if (done) done() } })
  p.onLoad(); p._protectedLoader = loader; if (reader) p._protectedReader = reader
  p.onShow(); return p
}

test('错题保留历史记录；到期隐藏题目，续费后重新授权查看并可启动重练', async t => {
  const { h, timelineKey, add, loader, reader, q, clock } = setup(t)
  assert.equal((await add('A', 'a1', false)).ok, true); assert.equal((await add('A', 'a2', true)).ok, true)
  assert.equal((await add('B', 'b1', false)).ok, true); assert.equal((await add('C', 'c1', false, 'exam_b')).ok, true)
  const p = page('../pages/mistakes/mistakes.js', loader, reader); await settle()
  assert.equal(p.data.protectedWrongCount, 2); assert.equal(JSON.stringify(p.data.protectedWrongs).includes('受保护题目'), false)
  const row = p.data.protectedWrongs.find(item => item.questionId === 'A'); assert.equal(row.wrong, 1); assert.equal(row.attempts, 2)
  const event = { currentTarget: { dataset: { key: row.key } } }
  await p.showProtectedQuestion(event); assert.equal(p.data.protectedQuestion.stem, '受保护题目甲'); assert.equal(JSON.stringify(p.data).includes('另一考试秘密'), false)
  p.closeProtectedQuestion(); let timeline = h.commerceTimelines.get(timelineKey)
  h.commerceTimelines.set(timelineKey, subscriptions.revoke(timeline, 'one', NOW)); await p.showProtectedQuestion(event)
  assert.equal(p.data.protectedQuestion, null); assert.match(p.data.protectedQuestionError, /错题记录仍保留/); assert.equal(p.data.protectedWrongCount, 2)
  clock(NOW + 1); timeline = h.commerceTimelines.get(timelineKey)
  h.commerceTimelines.set(timelineKey, subscriptions.extend(subscriptions.reserve(timeline, 'two', NOW + 1), 'two', 30, NOW + 1))
  await p.showProtectedQuestion(event); assert.equal(p.data.protectedQuestion.id, q('A').id)
  let url = ''; wx.navigateTo = value => { url = value.url }; t.after(() => { delete wx.navigateTo }); p.redoProtected(event)
  assert.match(url, /protected-practice\?questionId=A$/); p.onHide(); assert.equal(p.data.protectedQuestion, null)
})

test('完整记录按考试、科目及章节统计，切考试和跨设备读取不混算', async t => {
  const { add, loader, exam } = setup(t)
  await add('A', 'a1', false); await add('A', 'a2', true); await add('B', 'b1', false); await add('C', 'c1', true, 'exam_b')
  const ctx = loader.capture(), report = await loader.load(ctx)
  assert.deepEqual([report.total, report.correct, report.wrong, report.rate], [3, 1, 2, 33])
  assert.equal(report.subjects.length, 2); assert.equal(report.chapters.length, 2); assert.equal(report.wrongs.length, 2)
  assert.equal(report.examName, '考试甲'); assert.deepEqual(report.subjects.map(item => item.label).sort(), ['甲科', '第二科'].sort())
  assert.deepEqual(report.chapters.map(item => item.label).sort(), ['数据', '网络'].sort())
  assert.equal(JSON.stringify(report).includes('受保护题目'), false)
  const saved = clone(report); assert.deepEqual(await loader.load(loader.capture()), saved)
  exam('exam_b'); assert.equal(loader.current(ctx), false)
  assert.deepEqual([(await loader.load(loader.capture())).total, (await loader.load(loader.capture())).correct], [1, 1])
  const fact = { id: 'one', examId: 'exam_a', sequence: 1, score: 0, subject: 'a', chapter: 'ch', questionId: 'q', questionVersionId: 'v', createdAt: NOW }
  assert.throws(() => buildProtectedLearningReport('exam_a', { attempts: [fact, { ...fact, sequence: 2 }], snapshotSequence: 2, correct: 0 }), /INVALID_PROTECTED_HISTORY/)
})

test('恢复服务意外返回重复事实时拒绝整个统计快照', async t => {
  const { add } = setup(t), first = (await add('A', 'once', false)).attempt
  const client = createProtectedStudyClient({ getSession: () => ({ logged: true, openid: 'alice', token: 'tokA' }), call: async () => ({ ok: true,
    attempts: [first, { ...first, sequence: 2 }], snapshotSequence: 2, correct: 0, hasMore: false, nextSequence: 2 }) })
  await assert.rejects(client.restore('exam_a', 0, client.capture()), /INVALID_RESPONSE/)
})

test('题库更新后保留旧错题事实，查看时提示当前题目版本已变化', async t => {
  const { h, bank, add, loader, reader } = setup(t); await add('A', 'old', false)
  const p = page('../pages/mistakes/mistakes.js', loader, reader); await settle()
  const item = p.data.protectedWrongs.find(row => row.questionId === 'A')
  bank.questions.a[0].stem = '更新后的受保护题目'
  const source = sample.sources[sample.bank.questions.it[0].id]
  const next = paged.buildPagedCatalog({ ...bank, sources: { A: source, B: source, C: source } })
  h.questions.set('bank', { schemaVersion: 4, root: next.root, publicationRevision: 2 })
  h.questions.set(next.root.releaseId, { kind: 'pagedQuestionBankRelease', root: next.root, publishedAt: NOW + 1 })
  for (const entry of next.publicPages) h.questions.set(paged.pageDocumentId(entry.releaseId, entry.index), { kind: 'pagedQuestionBankPage', page: entry })
  h.appConfig.set('examAccessPolicy', policy.buildPolicy(next.root, 2, [{ examId: 'exam_a', access: 'paid' }, { examId: 'exam_b', access: 'free' }]))
  await p.showProtectedQuestion({ currentTarget: { dataset: { key: item.key } } })
  assert.equal(p.data.protectedQuestion.stem, '更新后的受保护题目'); assert.equal(p.data.protectedQuestion.updated, true)
  assert.equal(p.data.protectedWrongCount, 1); p.onHide()
})

test('科目和题目下架后保留历史记录并说明无法查看', async t => {
  const { h, bank, add, loader, reader } = setup(t); await add('B', 'old_b', false)
  const p = page('../pages/mistakes/mistakes.js', loader, reader); await settle()
  bank.manifest.subjects = bank.manifest.subjects.filter(subject => subject.key !== 'a2'); delete bank.questions.a2
  const source = sample.sources[sample.bank.questions.it[0].id]
  const next = paged.buildPagedCatalog({ ...bank, sources: { A: source, C: source } })
  h.questions.set('bank', { schemaVersion: 4, root: next.root, publicationRevision: 2 })
  h.questions.set(next.root.releaseId, { kind: 'pagedQuestionBankRelease', root: next.root, publishedAt: NOW + 1 })
  for (const entry of next.publicPages) h.questions.set(paged.pageDocumentId(entry.releaseId, entry.index), { kind: 'pagedQuestionBankPage', page: entry })
  h.appConfig.set('examAccessPolicy', policy.buildPolicy(next.root, 2, [{ examId: 'exam_a', access: 'paid' }, { examId: 'exam_b', access: 'free' }]))
  await p.refreshProtected(); const item = p.data.protectedWrongs[0]
  assert.equal(item.subjectLabel, '已移除科目'); assert.equal(item.chapterLabel, '已移除章节')
  await p.showProtectedQuestion({ currentTarget: { dataset: { key: item.key } } })
  assert.equal(p.data.protectedQuestion, null); assert.match(p.data.protectedQuestionError, /错题记录仍保留/); p.onHide()
})

test('学情页显示受保护考试、科目、章节统计，读取失败不能当作零记录', async t => {
  const { h, add, loader } = setup(t); await add('A', 'a1', false); await add('B', 'b1', true)
  t.mock.method(analytics, 'snapshot', () => ({ stats: [], wrongs: [] }))
  t.mock.method(analytics, 'overview', () => ({ total: 0, correct: 0, rate: 0 }))
  t.mock.method(analytics, 'radarData', () => []); t.mock.method(analytics, 'trendData', () => [])
  t.mock.method(analytics, 'weakPoints', () => []); t.mock.method(analytics, 'strongPoints', () => []); t.mock.method(analytics, 'stubbornQuestions', () => [])
  const p = page('../pages/analysis/analysis.js', loader); await settle()
  assert.equal(p.data.protectedReport.total, 2); assert.equal(p.data.protectedReport.correct, 1)
  assert.equal(p.data.protectedReport.subjects.length, 2); assert.equal(p.data.protectedReport.chapters.length, 2)
  h.fail.protectedQuery = new Error('injected')
  await p.refreshProtected(); assert.equal(p.data.protectedLoaded, false); assert.equal(p.data.protectedReport, null); assert.match(p.data.protectedError, /失败/)
  p.onHide(); assert.equal(p.data.protectedReport, null)
})

test('题目响应迟到时切账号或关闭页面，不显示先前账号的内容', async t => {
  const { add, loader, reader, session } = setup(t); await add('A', 'a1', false)
  const p = page('../pages/mistakes/mistakes.js', loader, reader); await settle()
  const row = p.data.protectedWrongs[0], ctx = p._protectedContext
  const response = await reader.question('exam_a', 'A', ctx.context.identity)
  let resolve; p._protectedReader.question = () => new Promise(r => { resolve = r })
  const pending = p.showProtectedQuestion({ currentTarget: { dataset: { key: row.key } } })
  session({ logged: true, openid: 'bob', token: 'tokB' }); resolve(response); await pending
  assert.equal(p.data.protectedQuestion, null); assert.equal(p.data.protectedWrongs.length, 0); assert.match(p.data.protectedError, /切换/)
  p.onHide(); assert.equal(p.data.protectedWrongs.length, 0); assert.equal(p.data.protectedQuestion, null)
})

test('错题重练从目标题开始，重新校验权益并提交一次受保护作答', async t => {
  const { h, add, reader, recorder, timelineKey } = setup(t); await add('B', 'before', false)
  let definition; global.Page = value => { definition = value }
  const location = require.resolve('../pages/protected-practice/protected-practice.js'); delete require.cache[location]; require(location)
  const p = Object.assign({}, definition, { data: clone(definition.data), setData(value) { Object.assign(this.data, value) } })
  p.onLoad({ questionId: 'B' }); p._client = reader; p._recorder = recorder; p.onShow(); await settle()
  assert.equal(p.data.question.id, 'B'); assert.equal(p.data.historyCount, 1)
  p.onSelect({ detail: { key: p.data.question.answer[0] } }); await p.onSubmit()
  assert.equal(p.data.submitted, true); assert.equal(h.protectedAttempts.size, 2)
  p.onNext(); assert.equal(p.data.finished, true); assert.equal(p.data.question, null)
  p.onHide(); const timeline = h.commerceTimelines.get(timelineKey)
  h.commerceTimelines.set(timelineKey, subscriptions.revoke(timeline, 'one', NOW))
  p.onShow(); await settle(); assert.equal(p.data.question, null); assert.match(p.data.error, /权限/)
  p.onUnload(); delete require.cache[location]
})

test('关闭记录联调时按目标题重练仍能校验题库并完成作答', async t => {
  const { h, reader, recorder } = setup(t); config.protectedRecordsPreview = false
  let definition; global.Page = value => { definition = value }
  const location = require.resolve('../pages/protected-practice/protected-practice.js'); delete require.cache[location]; require(location)
  const p = Object.assign({}, definition, { data: clone(definition.data), setData(value) { Object.assign(this.data, value) } })
  p.onLoad({ questionId: 'B' }); p._client = reader; p._recorder = recorder; p.onShow(); await settle()
  assert.equal(p.data.question.id, 'B'); p.onSelect({ detail: { key: p.data.question.answer[0] } }); await p.onSubmit()
  assert.equal(p.data.correct, true); assert.equal(h.protectedAttempts.size, 0); p.onUnload(); delete require.cache[location]
})

test('受保护模式下旧错题、学情和练习会话不回显本机题目快照', async t => {
  const { loader, reader } = setup(t), oldMode = config.protectedCatalog
  config.protectedCatalog = true; t.after(() => { config.protectedCatalog = oldMode })
  t.mock.method(bankApi, 'findQuestion', () => { throw new Error('must not read old cache') })
  t.mock.method(analytics, 'snapshot', () => { throw new Error('must not read old analytics') })
  t.mock.method(store, 'onPracticeRestored', () => () => {})
  t.mock.method(store, 'getPracticeSession', () => { throw new Error('must not restore old session') })
  const mistakes = page('../pages/mistakes/mistakes.js', loader, reader); await settle()
  assert.equal(mistakes.data.protectedMode, true); assert.deepEqual(mistakes.data.list, [])
  const analysis = page('../pages/analysis/analysis.js', loader); await settle()
  assert.equal(analysis.data.protectedMode, true); assert.equal(analysis.data.hasData, false)
  let definition; global.getApp = () => ({ globalData: {}, startPractice() {} }); global.Page = value => { definition = value }
  const location = require.resolve('../pages/practice/practice.js'); delete require.cache[location]; require(location)
  const p = Object.assign({}, definition, { data: clone(definition.data), setData(value) { Object.assign(this.data, value) } })
  p.onLoad({}); p.setData({ question: { stem: '旧缓存题目' }, queue: [{ stem: '旧缓存题目' }], total: 1 }); p.onShow()
  assert.equal(p.data.question, null); assert.deepEqual(p.data.queue, []); assert.match(p.data.emptyTip, /受保护/)
  assert.equal(p._restoreSession({ id: 'old' }), false)
  mistakes.onHide(); analysis.onHide(); p.onUnload(); delete require.cache[location]
})


test('错题收藏、标记掌握、取消掌握在跨设备恢复后保持一致', async t => {
  const { add, loader, reader, markers } = setup(t); await add('A', 'wrong', false)
  const first = page('../pages/mistakes/mistakes.js', loader, reader); first._protectedMarkers = markers; await settle()
  const row = first.data.protectedWrongs[0], action = field => ({ currentTarget: { dataset: { key: row.key, field } } })
  await first.setProtectedMarker(action('starred'))
  assert.equal(first.data.protectedWrongs[0].starred, true)
  const second = page('../pages/mistakes/mistakes.js', loader, reader); second._protectedMarkers = markers; await settle()
  assert.equal(second.data.protectedWrongs[0].starred, true)
  await second.setProtectedMarker(action('mastered'))
  assert.equal(second.data.protectedWrongs.length, 0)
  second.protectedTabChange({ currentTarget: { dataset: { tab: 'mastered' } } })
  assert.equal(second.data.protectedWrongs[0].mastered, true)
  await second.setProtectedMarker(action('mastered'))
  second.protectedTabChange({ currentTarget: { dataset: { tab: 'all' } } })
  assert.equal(second.data.protectedWrongs[0].mastered, false)
  first.onHide(); second.onHide()
})

test('练习提交后可收藏正确题，随后在收藏分类恢复', async t => {
  const { reader, recorder, markers, loader } = setup(t)
  global.getApp = () => ({ globalData: {}, startPractice() {} }); let definition; global.Page = value => { definition = value }
  const location = require.resolve('../pages/protected-practice/protected-practice.js'); delete require.cache[location]; require(location)
  const p = Object.assign({}, definition, { data: clone(definition.data), setData(value) { Object.assign(this.data, value) } })
  p.onLoad({ questionId: 'A' }); p._client = reader; p._recorder = recorder; p._markers = markers; p.onShow(); await settle(); await settle()
  p.onSelect({ detail: { key: p.data.question.answer[0] } }); await p.onSubmit(); await settle()
  assert.equal(p.data.markerLoaded, true); await p.toggleStar(); assert.equal(p.data.starred, true)
  const mistakes = page('../pages/mistakes/mistakes.js', loader, reader); mistakes._protectedMarkers = markers; await settle()
  mistakes.protectedTabChange({ currentTarget: { dataset: { tab: 'starred' } } })
  assert.equal(mistakes.data.protectedWrongs[0].questionId, 'A'); assert.equal(mistakes.data.protectedWrongs[0].wrong, 0)
  p.onUnload(); mistakes.onHide(); delete require.cache[location]
})

test('收藏回执丢失后重新读取真实状态，避免重复反转', async t => {
  const { add, loader, reader, markers } = setup(t); await add('A', 'wrong', false)
  const p = page('../pages/mistakes/mistakes.js', loader, reader); await settle()
  p._protectedMarkers = { set: async (...args) => { await markers.set(...args); throw Object.assign(new Error('lost ack'), { code: 'NETWORK_ERROR' }) } }
  const row = p.data.protectedWrongs[0]
  await p.setProtectedMarker({ currentTarget: { dataset: { key: row.key, field: 'starred' } } })
  assert.equal(p.data.protectedWrongs[0].starred, true)
  assert.match(p.data.protectedQuestionError, /未确认/); p.onHide()
})

test('收藏响应在账号 A→B→A 后返回时不应用到页面', async t => {
  const { add, loader, reader, session } = setup(t); await add('A', 'wrong', false)
  const p = page('../pages/mistakes/mistakes.js', loader, reader); await settle()
  let resolve; p._protectedMarkers = { set: () => new Promise(r => { resolve = r }) }
  const row = p.data.protectedWrongs[0], pending = p.setProtectedMarker({ currentTarget: { dataset: { key: row.key, field: 'starred' } } })
  session({ logged: true, openid: 'bob', token: 'tokB' }); session({ logged: true, openid: 'alice', token: 'tokA' })
  resolve({ revision: 1, duplicate: false }); await pending
  assert.equal(p.data.protectedLoaded, false); assert.deepEqual(p.data.protectedWrongs, [])
  p.onHide()
})

test('已掌握的题目再次答错会原子取消掌握，收藏不受影响', async t => {
  const { add, loader, reader, markers } = setup(t); await add('A', 'wrong1', false)
  const p = page('../pages/mistakes/mistakes.js', loader, reader); p._protectedMarkers = markers; await settle()
  const row = p.data.protectedWrongs[0], action = field => ({ currentTarget: { dataset: { key: row.key, field } } })
  await p.setProtectedMarker(action('starred')); await p.setProtectedMarker(action('mastered'))
  assert.equal(p.data.protectedWrongs.length, 0)
  assert.equal((await add('A', 'wrong2', false)).ok, true)
  await p.refreshProtected()
  assert.equal(p.data.protectedWrongs[0].mastered, false); assert.equal(p.data.protectedWrongs[0].starred, true)
  p.onHide()
})

test('恢复期间收藏或掌握状态变化时不发布混合快照', async t => {
  const { add, reader, recorder, client } = setup(t); await add('A', 'wrong', false)
  let calls = 0
  const markers = { get: async () => ({ revision: ++calls, entries: [] }) }
  const loader = createProtectedReportLoader({ client, reader, session: recorder, getExam: () => 'exam_a', markers })
  await assert.rejects(loader.load(loader.capture()), /SNAPSHOT_CHANGED/)
})
