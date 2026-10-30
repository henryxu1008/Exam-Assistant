/**
 * store.mergeStats 单元测试（双向合并逻辑，与云同步相关）
 * 仅测试纯函数 mergeStats，不依赖 wx.cloud（沙箱无 cloud，pullFromCloud 不会真正触发）。
 */

const test = require('node:test')
const assert = require('node:assert')

const store = require('../utils/store.js')

// 构造一个最小本地 state（与 getDefaultState 结构对齐）
function makeState(over) {
  return Object.assign(
    {
      version: 3,
      records: {},
      daily: {},
      settings: { dailyGoal: 30, autoNext: true, aiExplain: true, currentSubject: '' },
      practiceSession: null,
      aiMessages: []
    },
    over || {}
  )
}

test('records：本地更新的取本地，云端更新的取云端', () => {
  const local = makeState({
    records: {
      q1: { id: 'q1', lastAt: 1000, right: 1 },
      q2: { id: 'q2', lastAt: 500, right: 1 }
    }
  })
  const remote = makeState({
    records: {
      q1: { id: 'q1', lastAt: 800, right: 0 }, // 云端更旧 -> 应保留本地
      q2: { id: 'q2', lastAt: 900, right: 0 }, // 云端更新 -> 应取云端
      q3: { id: 'q3', lastAt: 700, right: 1 } // 仅云端 -> 保留
    }
  })
  const merged = store.mergeStats(local, remote)
  assert.strictEqual(merged.records.q1.right, 1, 'q1 应保留本地较新值')
  assert.strictEqual(merged.records.q2.right, 0, 'q2 应取云端较新值')
  assert.ok(merged.records.q3, 'q3 应来自云端')
  assert.strictEqual(Object.keys(merged.records).length, 3)
})

test('daily：同日指标取较大、章节取并集', () => {
  const local = makeState({
    daily: {
      '2026-10-30': {
        date: '2026-10-30',
        total: 5,
        correct: 3,
        timeMs: 1000,
        chapters: { c1: { total: 5, correct: 3 } },
        subjects: { s1: { total: 5, correct: 3, timeMs: 1000 } }
      }
    }
  })
  const remote = makeState({
    daily: {
      '2026-10-30': {
        date: '2026-10-30',
        total: 4,
        correct: 4,
        timeMs: 800,
        chapters: { c1: { total: 4, correct: 4 }, c2: { total: 2, correct: 1 } },
        subjects: { s1: { total: 4, correct: 4, timeMs: 800 } }
      },
      '2026-10-29': { date: '2026-10-29', total: 2, correct: 1, timeMs: 500, chapters: {}, subjects: {} }
    }
  })
  const merged = store.mergeStats(local, remote)
  const d = merged.daily['2026-10-30']
  assert.strictEqual(d.total, 5, 'total 取较大')
  assert.strictEqual(d.correct, 4, 'correct 取较大')
  assert.strictEqual(d.timeMs, 1000, 'timeMs 取较大')
  assert.ok(d.chapters.c1 && d.chapters.c2, '章节取并集')
  assert.strictEqual(d.chapters.c1.correct, 4, '同章节 correct 取较大')
  assert.ok(merged.daily['2026-10-29'], '不同日期保留并集')
})

test('practiceSession：取 createdAt 较新方', () => {
  const local = makeState({ practiceSession: { id: 'a', createdAt: 100 } })
  const remote = makeState({ practiceSession: { id: 'b', createdAt: 200 } })
  assert.strictEqual(store.mergeStats(local, remote).practiceSession.id, 'b')
  assert.strictEqual(store.mergeStats(remote, local).practiceSession.id, 'b')
})

test('aiMessages：按 time 去重取并集', () => {
  const local = makeState({ aiMessages: [{ time: 1, role: 'u' }, { time: 2, role: 'a' }] })
  const remote = makeState({ aiMessages: [{ time: 2, role: 'a' }, { time: 3, role: 'u' }] })
  const merged = store.mergeStats(local, remote).aiMessages
  const times = merged.map((m) => m.time).sort()
  assert.deepStrictEqual(times, [1, 2, 3])
})

test('settings：云端优先', () => {
  const local = makeState({ settings: { dailyGoal: 30, currentSubject: '公基' } })
  const remote = makeState({ settings: { dailyGoal: 50, currentSubject: '职测' } })
  const merged = store.mergeStats(local, remote).settings
  assert.strictEqual(merged.dailyGoal, 50)
  assert.strictEqual(merged.currentSubject, '职测')
})

test('version：取较大值', () => {
  assert.strictEqual(store.mergeStats(makeState({ version: 3 }), makeState({ version: 5 })).version, 5)
})

test('空云端时保留本地完整数据', () => {
  const local = makeState({ records: { q1: { id: 'q1', lastAt: 1 } } })
  const merged = store.mergeStats(local, null)
  assert.deepStrictEqual(merged.records, local.records)
})

test('attempts：按 id 去重取并集', () => {
  const local = makeState({ attempts: [{ id: 'a1', q: 1 }, { id: 'a2', q: 2 }] })
  const remote = makeState({ attempts: [{ id: 'a2', q: 99 }, { id: 'a3', q: 3 }] })
  const merged = store.mergeStats(local, remote).attempts
  const ids = merged.map((a) => a.id).sort()
  assert.deepStrictEqual(ids, ['a1', 'a2', 'a3'])
  // 同 id 以先出现（云端在前）为准，a2 来自 remote
  const a2 = merged.find((a) => a.id === 'a2')
  assert.strictEqual(a2.q, 99)
})
