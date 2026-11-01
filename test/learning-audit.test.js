const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { auditLearning } = require('../shared/learning-audit.js')
const { projectCounts, PREFIX } = require('../shared/attempt-domain.js')
const fact = (id, extra = {}) => ({ id, sessionId: 's', questionId: 'q', clientOpId: id, questionVersionId: 'v1',
  selected: ['SECRET-ANSWER'], answer: ['SECRET-ANSWER'], score: 1, costMs: 20, createdAt: 100,
  projection: { version: 1, date: '2026-11-01', subject: '公基', chapter: '测试' }, ...extra })
const snapshot = facts => {
  const s = { records: {}, daily: {}, attempts: facts, token: 'SECRET-TOKEN' }
  for (const f of facts) projectCounts(s, f)
  return s
}

test('事实计数精确一致，输入冻结后仍只读；报告不含答案或令牌', () => {
  const s = snapshot([fact('a'), fact('b', { score: 0 })])
  const before = JSON.stringify(s)
  const freeze = v => { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v) } }
  freeze(s)
  const report = auditLearning(s)
  assert.equal(report.status, 'consistent')
  assert.equal(report.summary.factCount, 2)
  assert.equal(JSON.stringify(s), before)
  assert.equal(JSON.stringify(report).includes('SECRET'), false)
})

test('缓存合计及事实分区篡改都得到明确差异', () => {
  const s = snapshot([fact('a')])
  s.records.q.attempts += 1
  assert.ok(auditLearning(s).issues.some(i => i.code === 'AGGREGATE_CACHE_MISMATCH'))
  s.daily['2026-11-01'].by[PREFIX + 'a'].total = 99
  assert.ok(auditLearning(s).issues.some(i => i.code === 'FACT_CONTRIBUTION_MISMATCH'))
})

test('不同事实 ID 的同业务重复、同 ID 内容冲突分别报告', () => {
  const a = fact('a', { clientOpId: 'same' }), b = fact('b', { clientOpId: 'same' })
  const duplicate = auditLearning(snapshot([a, b]))
  assert.ok(duplicate.issues.some(i => i.code === 'DUPLICATE_OPERATION'))
  const conflict = auditLearning(snapshot([a, { ...a, selected: ['another'] }]))
  assert.ok(conflict.issues.some(i => i.code === 'FACT_ID_CONFLICT'))
  assert.equal(JSON.stringify(conflict).includes('another'), false)
})

test('旧聚合大于现存明细只标未知，不误判重复或生成虚构流水', () => {
  const old = fact('old'); delete old.projection
  const s = { attempts: [old], records: { q: { attempts: 20, right: 10, wrong: 10 } }, daily: {} }
  const before = JSON.stringify(s), result = auditLearning(s)
  assert.equal(result.status, 'incomplete')
  assert.equal(result.issues.length, 0)
  assert.ok(result.unknown.some(i => i.code === 'LEGACY_AGGREGATE_UNKNOWN'))
  assert.equal(JSON.stringify(s), before)
})

test('即使旧数据日期未知，明细多于题目计数也是可证明的缺口', () => {
  const old = fact('old'); delete old.projection
  const result = auditLearning({ attempts: [old], records: {}, daily: {} })
  assert.equal(result.status, 'issues')
  assert.ok(result.issues.some(i => i.code === 'FACT_COUNT_EXCEEDS_RECORD'))
  assert.ok(result.unknown.some(i => i.code === 'UNATTRIBUTED_LEGACY_FACT'))
})

test('孤立事实分区、缺少贡献与非法数值不得被当作一致', () => {
  const s = snapshot([fact('a')])
  s.records.q.answerBy[PREFIX + 'ghost'] = { attempts: 1, right: 1, wrong: 0 }
  assert.ok(auditLearning(s).issues.some(i => i.code === 'ORPHAN_FACT_CONTRIBUTION'))
  delete s.daily['2026-11-01'].by[PREFIX + 'a']
  s.records.q.wrong = 'not-a-number'
  const result = auditLearning(s)
  assert.ok(result.issues.some(i => i.code === 'MISSING_FACT_CONTRIBUTION'))
  assert.ok(result.issues.some(i => i.code === 'INVALID_COUNTER'))
})

test('离线 CLI 区分一致、缺口、历史未知和坏输入，不写回文件', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'learning-audit-'))
  const input = path.join(dir, 'synthetic.json')
  const run = data => {
    const text = JSON.stringify(data)
    fs.writeFileSync(input, text)
    const result = spawnSync(process.execPath, ['scripts/audit-learning.js', '--input', input], { cwd: path.join(__dirname, '..'), encoding: 'utf8' })
    assert.equal(fs.readFileSync(input, 'utf8'), text)
    assert.equal(result.stdout.includes('SECRET'), false)
    return result
  }
  try {
    assert.equal(run(snapshot([fact('a')])).status, 0)
    assert.equal(run({ attempts: [], records: { q: { attempts: 1, right: 1 } }, daily: {} }).status, 3)
    const bad = snapshot([fact('a')]); bad.records.q.right = 0
    assert.equal(run(bad).status, 2)
    fs.writeFileSync(input, '{bad SECRET-TOKEN')
    const invalid = spawnSync(process.execPath, ['scripts/audit-learning.js', '--input', input], { cwd: path.join(__dirname, '..'), encoding: 'utf8' })
    assert.equal(invalid.status, 1)
    assert.equal(invalid.stderr.includes('SECRET'), false)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('提交标记必须能定位同会话同题的事实，成绩缓存也要一致', () => {
  const s = snapshot([fact('a')])
  s.practiceSession = { id: 's', submitted: { q: { attemptId: 'missing' } }, sessionTotal: 1, sessionCorrect: 1 }
  assert.ok(auditLearning(s).issues.some(i => i.code === 'MISSING_SUBMITTED_FACT'))
  s.practiceSession.submitted.q.attemptId = 'a'
  s.practiceSession.sessionCorrect = 0
  assert.ok(auditLearning(s).issues.some(i => i.code === 'SESSION_CACHE_MISMATCH'))
})

test('完全没有旧流水账本时明确未知，不把空列表当作完整历史', () => {
  const report = auditLearning({ records: { q: { attempts: 1, right: 1, wrong: 0 } }, daily: {} })
  assert.equal(report.status, 'incomplete')
  assert.ok(report.unknown.some(i => i.code === 'NO_ATTEMPT_LEDGER'))
})
