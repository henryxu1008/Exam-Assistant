/**
 * 共享合并模块一致性测试（PR #10 评审 P1 4422245834 的根因收敛）
 *
 * 「合并」同时发生在端上（utils/store.js 启动拉取）和云端（studySync 收到上传）。
 * 云函数按目录独立部署、无法 require 父级代码，因此 shared/ 下的模块
 * 必须在各 cloudfunctions/<fn>/ 目录留一份部署副本。
 *
 * 这里防止两份实现漂移：
 *  1) 逐字节比对：副本必须与 shared/ 源文件完全一致；
 *  2) 行为比对：同一组输入下，端上与云端的合并结果必须完全相同。
 */

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const ROOT = path.resolve(__dirname, '..')
/** 冻结时间，避免两份实现的 createdAt 跨毫秒导致比对偶发失败 */
const NOW = new Date('2026-10-30T06:00:00Z').getTime()

/** [源文件, ...部署副本] */
const MAPPINGS = [
  ['shared/stats-merge.js', 'cloudfunctions/studySync/stats-merge.js'],
  [
    'shared/auth.js',
    'cloudfunctions/bankSync/auth.js',
    'cloudfunctions/initConfig/auth.js',
    'cloudfunctions/studySync/auth.js'
  ]
]

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

/** 小程序端与云端各自的合并实现；端上即 utils/store.js require 的那份 shared 实现 */
const clientMerge = require('../shared/stats-merge.js')
const serverMerge = require('../cloudfunctions/studySync/stats-merge.js')

function dailyStat(date, total, correct, timeMs) {
  return {
    date: date,
    total: total,
    correct: correct,
    timeMs: timeMs,
    chapters: {},
    subjects: {}
  }
}

function fixtures() {
  return [
    { name: '空对空', a: {}, b: {} },
    {
      name: 'records 按 lastAt 取较新',
      a: { records: { q1: { id: 'q1', lastAt: 100, right: 1 } } },
      b: {
        records: {
          q1: { id: 'q1', lastAt: 200, right: 0 },
          q2: { id: 'q2', lastAt: 50, right: 1 }
        }
      }
    },
    {
      name: 'daily 同日各指标取较大',
      a: { daily: { d: dailyStat('d', 5, 1, 100) } },
      b: { daily: { d: dailyStat('d', 3, 3, 300) } }
    },
    {
      name: 'aiMessages 按 time 并集去重',
      a: { aiMessages: [{ time: 1, role: 'u' }, { time: 2, role: 'a' }] },
      b: { aiMessages: [{ time: 2, role: 'dup' }, { time: 3, role: 'u' }] }
    },
    {
      name: 'attempts 按 id 并集去重',
      a: { attempts: [{ id: 'a1' }, { id: 'a2' }] },
      b: { attempts: [{ id: 'a2' }, { id: 'a3' }] }
    },
    {
      name: 'settings 以后到达的一方为准',
      a: { settings: { dailyGoal: 10, currentSubject: 'A' } },
      b: { settings: { dailyGoal: 99 } }
    },
    {
      name: 'practiceSession 取 createdAt 较新',
      a: { practiceSession: { id: 'old', createdAt: 1 } },
      b: { practiceSession: { id: 'new', createdAt: 9 } }
    },
    { name: 'version 取较大', a: { version: 2 }, b: { version: 3 } }
  ]
}

test('部署副本与 shared/ 源文件逐字节一致', () => {
  MAPPINGS.forEach((mapping) => {
    const src = mapping[0]
    const srcHash = sha256(path.join(ROOT, src))
    mapping.slice(1).forEach((rel) => {
      assert.equal(sha256(path.join(ROOT, rel)), srcHash, `${rel} 与 ${src} 不一致`)
    })
  })
})

test('端上与云端两份实现行为完全一致', () => {
  // 冻结时间：mergeStats 会用 Date.now() 生成默认 createdAt，
  // 两次调用若跨毫秒会让比对偶发失败。
  const realNow = Date.now
  try {
    Date.now = () => NOW
    fixtures().forEach((f) => {
      assert.deepEqual(
        clientMerge.mergeStats(f.a, f.b),
        serverMerge.mergeStats(f.a, f.b),
        `端上/云端合并结果不一致：${f.name}`
      )
    })
  } finally {
    Date.now = realNow
  }
})

test('合并是累加：后到达的上传不会抹掉已有记录', () => {
  const existing = {
    version: 3,
    records: { q1: { id: 'q1', lastAt: 100, right: 1 } },
    daily: { d1: dailyStat('d1', 7, 7, 700) },
    settings: { dailyGoal: 30, autoNext: true, aiExplain: true, currentSubject: '公基' },
    practiceSession: null,
    aiMessages: [{ time: 1, role: 'u' }],
    attempts: [{ id: 'a1' }]
  }
  const incoming = {
    version: 3,
    records: { q2: { id: 'q2', lastAt: 200, right: 1 } },
    daily: { d1: dailyStat('d1', 1, 0, 50) },
    settings: { dailyGoal: 30, autoNext: true, aiExplain: true, currentSubject: '' },
    practiceSession: null,
    aiMessages: [{ time: 2, role: 'a' }],
    attempts: [{ id: 'a2' }]
  }

  const merged = serverMerge.mergeStats(existing, incoming)
  assert.ok(merged.records.q1, '已有记录必须保留')
  assert.ok(merged.records.q2, '新上传记录必须保留')
  assert.equal(merged.daily.d1.total, 7, '同日 total 取较大')
  assert.equal(merged.daily.d1.correct, 7, '同日 correct 取较大')
  assert.equal(merged.aiMessages.length, 2, '对话取并集')
  assert.deepEqual(
    merged.attempts.map((a) => a.id).sort(),
    ['a1', 'a2'],
    '作答流水取并集'
  )
})

test('合并结果始终包含默认字段（缺失会被补齐）', async () => {
  const merged = serverMerge.mergeStats(null, null)
  assert.equal(merged.version, 3)
  assert.deepEqual(merged.records, {})
  assert.deepEqual(merged.attempts, [])
  assert.deepEqual(merged.aiMessages, [])
  assert.equal(merged.practiceSession, null)
  assert.equal(typeof merged.settings.dailyGoal, 'number')
})
