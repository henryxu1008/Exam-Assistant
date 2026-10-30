/**
 * 合并语义的三条 P1/P2 回归测试（PR #10 评审 4423125072 / 4423125081 / 4422339103）
 *
 * 这三条原本是三个独立的 bug，根因其实是同一个：
 * 早期 mergeStats 是「纯单调」的——只会取并集、取较大，
 * 于是：
 *   - 删除无法表达：清空对话后上传 []，并集之后旧消息原样保留；
 *   - 不推进 lastAt / createdAt 的修改无法表达：收藏、移出错题本、
 *     恢复会话后继续作答，永远被判为「旧」而丢弃。
 *
 * 收敛做法是一套统一机制，而不是三处补丁：
 *   - 可修改实体携带 updatedAt（任何修改都推进它）；
 *   - 删除用「纪元 aiEpoch」墓碑，高纪元的空值胜出；
 *   - 冲突 last-write-wins，决胜规则对参数顺序对称。
 */

const { test } = require('node:test')
const assert = require('node:assert/strict')

const { mergeStats, mergeSession, pickNewer, bumpVersion } = require('../shared/stats-merge.js')

function baseState(over) {
  return Object.assign(
    {
      version: 3,
      records: {},
      daily: {},
      settings: { dailyGoal: 30, autoNext: true, aiExplain: true, currentSubject: '' },
      practiceSession: null,
      aiMessages: [],
      aiEpoch: 0,
      attempts: []
    },
    over || {}
  )
}

/* ------------------------------------------------------------------ *
 * P1 4423125072：清空对话必须能传播，而不是被并集复原
 * ------------------------------------------------------------------ */

test('清空对话后上传的空列表能覆盖云端旧对话', () => {
  const server = baseState({ aiMessages: [{ time: 1, role: 'u', text: '旧消息' }], aiEpoch: 0 })
  const cleared = baseState({ aiMessages: [], aiEpoch: 1 })

  const merged = mergeStats(server, cleared)
  assert.deepEqual(merged.aiMessages, [], '高纪元的清空必须胜出，旧对话不得被复原')
  assert.strictEqual(merged.aiEpoch, 1)
})

test('清空后再新增的对话不会被旧快照复活', () => {
  const server = baseState({ aiMessages: [{ time: 1, role: 'u', text: '旧消息' }], aiEpoch: 0 })
  const cleared = baseState({ aiMessages: [], aiEpoch: 1 })

  const afterClear = mergeStats(server, cleared)
  // 另一个还没同步到清空操作的设备上传它手里的旧对话
  const stale = baseState({ aiMessages: [{ time: 1, role: 'u', text: '旧消息' }], aiEpoch: 0 })

  const merged = mergeStats(afterClear, stale)
  assert.deepEqual(merged.aiMessages, [], '纪元更低的旧对话不得覆盖已清空状态')
})

test('合并后的对话按时间升序排列（评审 P2 4425408887）', () => {
  const seq = (from, to) => {
    const arr = []
    for (let i = from; i <= to; i++) arr.push({ time: i, role: 'u', text: 'm' + i })
    return arr
  }
  // 上传侧只带最近 60 条窗口（pushAiMessage 的保留上限），服务端存着更早的 1–60
  const server = baseState({ aiMessages: seq(1, 60), aiEpoch: 0 })
  const upload = baseState({ aiMessages: seq(61, 120), aiEpoch: 0 })

  const times = mergeStats(server, upload).aiMessages.map((m) => m.time)
  assert.deepEqual(
    times.slice().sort((a, b) => a - b),
    times,
    '顺序不能依赖哪一侧在前，否则下游取「最后 N 条」会拿到旧对话'
  )
  // 保留上限会截掉末尾之外的内容：必须留下最新的 61–120
  assert.deepEqual(times.slice(-60), seq(61, 120).map((m) => m.time))
})

test('同一纪元内的对话仍按 time 并集去重（不误删）', () => {
  const a = baseState({ aiMessages: [{ time: 1, role: 'u' }], aiEpoch: 2 })
  const b = baseState({ aiMessages: [{ time: 1, role: 'u' }, { time: 2, role: 'a' }], aiEpoch: 2 })

  const merged = mergeStats(a, b)
  assert.strictEqual(merged.aiMessages.length, 2, '同纪元内应取并集而非整段替换')
})

/* ------------------------------------------------------------------ *
 * P2 4423125081：不推进 lastAt 的修改（收藏 / 掌握）也必须能同步
 * ------------------------------------------------------------------ */

test('收藏状态即使不改变 lastAt 也能覆盖云端旧记录', () => {
  const server = baseState({
    records: { q1: { id: 'q1', lastAt: 1000, starred: false, updatedAt: 1000 } }
  })
  const starred = baseState({
    records: { q1: { id: 'q1', lastAt: 1000, starred: true, updatedAt: 2000 } }
  })

  const merged = mergeStats(server, starred)
  assert.strictEqual(merged.records.q1.starred, true, '收藏必须能同步，否则换设备后会被回退')
})

test('移出错题本（mastered）同样依赖 updatedAt 生效', () => {
  const server = baseState({
    records: { q1: { id: 'q1', lastAt: 1000, mastered: false, updatedAt: 1000 } }
  })
  const mastered = baseState({
    records: { q1: { id: 'q1', lastAt: 1000, mastered: true, updatedAt: 3000 } }
  })

  const merged = mergeStats(server, mastered)
  assert.strictEqual(merged.records.q1.mastered, true)
})

test('旧数据（无 updatedAt）仍按 lastAt 判定，保持兼容', () => {
  const old = { records: { q1: { id: 'q1', lastAt: 500, right: 1 } } }
  const newer = { records: { q1: { id: 'q1', lastAt: 900, right: 2 } } }

  assert.strictEqual(mergeStats(old, newer).records.q1.right, 2)
  assert.strictEqual(mergeStats(newer, old).records.q1.right, 2, '结果与参数顺序无关')
})

/* ------------------------------------------------------------------ *
 * P2 4422339103：同一会话的进度要合并，而不是二选一
 * ------------------------------------------------------------------ */

test('同一会话在两端各自作答时，submitted 取并集', () => {
  const a = {
    id: 'ps1', status: 'in_progress', createdAt: 1000, currentIndex: 1,
    submitted: { q1: { attemptId: 'a1' } }
  }
  const b = {
    id: 'ps1', status: 'in_progress', createdAt: 1000, currentIndex: 2,
    submitted: { q2: { attemptId: 'a2' } }
  }

  const merged = mergeSession(a, b)
  assert.deepEqual(Object.keys(merged.submitted).sort(), ['q1', 'q2'])
  assert.strictEqual(merged.currentIndex, 2, '进度只前进不回退')
})

test('不同会话仍取较新的一方', () => {
  const old = { id: 'ps1', status: 'completed', createdAt: 1000, submitted: {} }
  const fresh = { id: 'ps2', status: 'in_progress', createdAt: 2000, submitted: {} }

  assert.strictEqual(mergeSession(old, fresh).id, 'ps2')
  assert.strictEqual(mergeSession(fresh, old).id, 'ps2', '结果与参数顺序无关')
})

test('任一侧完成即视为会话已完成（避免重复渲染未作答）', () => {
  const a = { id: 'ps1', status: 'completed', createdAt: 1000, submitted: {} }
  const b = { id: 'ps1', status: 'in_progress', createdAt: 1000, submitted: {} }

  assert.strictEqual(mergeSession(a, b).status, 'completed')
  assert.strictEqual(mergeSession(b, a).status, 'completed')
})

test('pickNewer 对参数顺序对称', () => {
  const x = { updatedAt: 5, v: 'x' }
  const y = { updatedAt: 5, v: 'y' }

  assert.strictEqual(pickNewer(x, y), pickNewer(y, x), '决胜规则必须对称')
})

test('bumpVersion 严格单调递增', () => {
  let v = 0
  const seen = []
  for (let i = 0; i < 5; i++) {
    v = bumpVersion({ updatedAt: v })
    seen.push(v)
  }
  for (let i = 1; i < seen.length; i++) {
    assert.ok(seen[i] > seen[i - 1], '每次修改都必须推进版本')
  }
})
