/** Validate the proposed artifacts; this does not emulate Tencent's rules engine. */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const manifest = require('../cloudbase/protected-access/manifest.json')
const deny = require('../cloudbase/protected-access/deny-client.rule.json')
const exact = ['users', 'appConfig', 'questions', 'attempts', 'studyStats', 'protectedAttempts', 'protectedStudyHeads',
  'protectedQuestionStates', 'protectedStateReceipts', 'commerceProducts', 'commerceOrders', 'commerceGrants',
  'commerceEvents', 'commerceTimelines', 'aiQuestionUsage', 'aiTutorUsage']
const collection = name => manifest.collections.find(c => c.name === name)
const index = (name, key) => collection(name).indexes.find(i => i.name === key)
test('配置清单包含所有敏感集合，每个集合使用同一份拒绝客户端规则', () => {
  assert.deepEqual(deny, { read: false, write: false })
  assert.equal(manifest.status, 'review-only'); assert.equal(manifest.clientRuleFile, 'deny-client.rule.json')
  assert.deepEqual(manifest.collections.map(c => c.name).sort(), [...exact].sort())
  assert.equal(new Set(manifest.collections.map(c => c.name)).size, exact.length)
  for (const item of manifest.collections) assert.ok(item.purpose && Array.isArray(item.indexes))
})
test('索引声明包含恢复、清空和登录所需字段顺序，不强加新唯一约束', () => {
  const keys = (name, key) => index(name, key).keys.map(field => field.field)
  assert.deepEqual(keys('protectedAttempts', 'protected_facts_cursor'), ['openid', 'dataEpoch', 'examId', 'sequence'])
  for (const [name, key] of [['protectedStudyHeads', 'protected_heads_epoch'], ['protectedQuestionStates', 'protected_states_epoch'],
    ['protectedStateReceipts', 'protected_receipts_epoch'], ['attempts', 'attempts_epoch']]) assert.deepEqual(keys(name, key), ['openid', 'dataEpoch'])
  assert.deepEqual(keys('users', 'users_token'), ['token']); assert.deepEqual(keys('users', 'users_openid'), ['openid'])
  assert.deepEqual(keys('studyStats', 'ai_receipts_epoch'), ['kind', 'openid', 'dataEpoch'])
  for (const item of manifest.collections) {
    assert.equal(new Set(item.indexes.map(i => i.name)).size, item.indexes.length)
    for (const candidate of item.indexes) {
      assert.equal(candidate.unique, false); assert.ok(candidate.purpose); assert.ok(candidate.keys.length)
      assert.ok(candidate.keys.every(field => typeof field.field === 'string' && field.direction === 'asc'))
    }
  }
})
