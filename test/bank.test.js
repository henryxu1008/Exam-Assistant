/**
 * utils/bank 测试：确认"静态兜底 + 云覆盖"重构后对外 API 与离线行为不变。
 * 测试沙箱无 wx.cloud（wx.__cloudReady 未置位），loadCloudBank / pushStaticBankToCloud 应安全返回 false。
 */

const test = require('node:test')
const assert = require('node:assert')

const bank = require('../utils/questions.js')

test('getSubjects 返回科目且 count 为非负数字', () => {
  const subs = bank.getSubjects()
  assert.ok(Array.isArray(subs) && subs.length > 0, '应有科目')
  subs.forEach((s) => {
    assert.strictEqual(typeof s.name, 'string')
    assert.ok(typeof s.count === 'number' && s.count >= 0)
  })
})

test('findQuestion / getAllQuestions 可用', () => {
  const all = bank.getAllQuestions()
  assert.ok(all.length > 0)
  const q = all[0]
  assert.strictEqual(bank.findQuestion(q.id).id, q.id)
})

test('filterQuestions 按 subject/chapter/type 过滤', () => {
  const all = bank.getAllQuestions()
  const sample = all[0]
  const bySubject = bank.filterQuestions({ subject: sample.subject })
  assert.ok(bySubject.length > 0)
  assert.ok(bySubject.every((q) => q.subject === sample.subject))
})

test('无云环境下 loadCloudBank / pushStaticBankToCloud 安全返回 false', async () => {
  assert.strictEqual(await bank.loadCloudBank(), false)
  assert.strictEqual(await bank.pushStaticBankToCloud(), false)
})
