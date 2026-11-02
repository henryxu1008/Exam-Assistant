const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const domain = require('../shared/question-domain.js')
const manifest = require('../utils/bank/manifest.js')
const clone = v => JSON.parse(JSON.stringify(v))
const input = () => ({ manifest, questions: Object.fromEntries(manifest.subjects.map(s => [s.key, require('../utils/bank/' + s.key + '.js')])) })
function client(storage = new Map()) {
  const controls = { response: null, failWrite: false, requests: [], wait: null }
  const wx = { __cloudReady: true, getStorageSync: key => clone(storage.get(key) || ''), setStorageSync: (key, value) => {
    if (controls.failWrite) throw new Error('storage full')
    storage.set(key, clone(value))
  }, cloud: { async callFunction(opts) {
    controls.requests.push(opts.data)
    const response = clone(controls.responses ? controls.responses[opts.data.action] : controls.response)
    if (controls.wait) await controls.wait
    return { result: response }
  } } }
  const module = { exports: {} }, file = path.join(__dirname, '../utils/bank/index.js')
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, wx, require: name => require(path.resolve(path.dirname(file), name)) })
  return { bank: module.exports, storage, controls, wx }
}
const response = (bank, publicationRevision) => ({ ok: true, bank: { ...domain.buildRelease(bank), publicationRevision } })

test('客户端只读取已发布协议，缓存持久化后才切换，重启离线仍有同一版本', async () => {
  const c = client(), before = c.bank.getAllQuestions()[0]
  const next = clone(input()); next.questions.gk[0].stem = '发布后的新题面'
  c.controls.response = response(next, 1)
  c.controls.failWrite = true
  assert.equal(await c.bank.loadCloudBank(), false)
  assert.equal(c.bank.findQuestion(before.id).stem, before.stem)
  c.controls.failWrite = false
  assert.equal(await c.bank.loadCloudBank(), true)
  assert.equal(c.controls.requests.every(r => r.action === 'getPublished'), true)
  const q = c.bank.findQuestion(before.id)
  assert.equal(q.stem, '发布后的新题面'); assert.notEqual(q.versionId, before.versionId)
  const restarted = client(c.storage); restarted.wx.__cloudReady = false
  assert.equal(await restarted.bank.loadCloudBank(), false)
  assert.equal(restarted.bank.findQuestion(q.id).versionId, q.versionId)
  const mutable = restarted.bank.getAllQuestions()[0]; mutable.answer.push('tamper')
  assert.notEqual(restarted.bank.findQuestion(q.id).answer.length, mutable.answer.length)
})

test('旧协议、损坏发布、缺失发布和读失败不替换当前题库或污染缓存', async () => {
  const c = client(), before = JSON.stringify(c.bank.getAllQuestions())
  const invalid = response(input(), 1); invalid.bank.questions.gk[0].stem = '内容与版本不符'
  for (const result of [{ ok: false, error: 'BAD_ACTION' }, { ok: false, error: 'READ_BANK_FAILED' },
    { ok: true, bank: input() }, { ok: true, bank: null }, invalid]) {
    c.controls.response = result
    assert.equal(await c.bank.loadCloudBank(), false)
    assert.equal(JSON.stringify(c.bank.getAllQuestions()), before)
    assert.equal(c.storage.size, 0)
  }
  c.storage.set('exam_quiz_bank_cloud_v1', input())
  c.storage.set('exam_quiz_bank_published_v2', invalid.bank)
  assert.equal(JSON.stringify(client(c.storage).bank.getAllQuestions()), before, '不信任旧缓存或损坏版本')
})

test('延迟旧响应不能倒退题库修订；管理员回滚以新修订切回旧内容', async () => {
  const c = client(), old = response(input(), 1), changed = clone(input())
  changed.questions.gk[0].stem = '第二版'
  c.controls.response = old
  let release; c.controls.wait = new Promise(resolve => { release = resolve })
  const slow = c.bank.loadCloudBank()
  c.controls.wait = null; c.controls.response = response(changed, 2)
  assert.equal(await c.bank.loadCloudBank(), true)
  release(); assert.equal(await slow, false)
  assert.equal(c.bank.getAllQuestions()[0].stem, '第二版')
  c.controls.response = { ...old, bank: { ...old.bank, publicationRevision: 3 } }
  assert.equal(await c.bank.loadCloudBank(), true)
  assert.equal(c.bank.getAllQuestions()[0].stem, input().questions.gk[0].stem)
})

test('考试题库完整验证并缓存，离线重启保留考试归属，读取失败不替换已有发布', async () => {
  const exam = require('../shared/exam-catalog-domain.js'), bank = input()
  bank.schemaVersion = 3; bank.manifest = clone(bank.manifest)
  bank.manifest.exams = [{ id: 'exam-a', name: '合成考试' }]
  bank.manifest.subjects.forEach(s => { s.examId = 'exam-a' })
  const release = exam.buildExamRelease(bank), c = client()
  c.controls.responses = { getPublished: { ok: false, error: 'EXAM_PROTOCOL_REQUIRED' }, getExamPublished: { ok: true, bank: { ...release, publicationRevision: 2 } } }
  assert.equal(await c.bank.loadCloudBank(), true)
  assert.equal(c.bank.getExams()[0].id, 'exam-a')
  assert.equal(c.bank.getSubjects('exam-a').length, 3)
  const restored = client(c.storage); restored.wx.__cloudReady = false
  assert.equal(restored.bank.getExams()[0].name, '合成考试')
  c.controls.responses.getExamPublished = { ok: false, error: 'READ_BANK_FAILED' }
  assert.equal(await c.bank.loadCloudBank(), false)
  assert.equal(c.bank.getExams()[0].id, 'exam-a')
  const corrupt = clone(release); corrupt.manifest.exams[0].name = '篡改'
  c.controls.responses.getExamPublished = { ok: true, bank: { ...corrupt, publicationRevision: 3 } }
  assert.equal(await c.bank.loadCloudBank(), false)
  assert.equal(c.bank.getExams()[0].name, '合成考试')
})
