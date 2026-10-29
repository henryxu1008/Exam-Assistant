/**
 * 测试用 Date 可控桩（Issue 4）
 *
 * 让 todayKey() / getDailyRange() / getStreakDays() 等依赖「今天」的逻辑可确定性测试。
 * mockDate(ts) 之后：`new Date()`（无参）返回固定时刻，`Date.now()` 返回固定时间戳；
 * `new Date(number)` 等带参构造仍走真实 Date，保证日期运算正确。
 */

let saved = null

function mockDate(ts) {
  if (!saved) saved = Date
  const fixed = ts
  function Patched(...args) {
    if (args.length === 0) return new saved(fixed)
    return new saved(...args)
  }
  Patched.now = () => fixed
  Patched.prototype = saved.prototype
  Patched.parse = saved.parse
  Patched.UTC = saved.UTC
  global.Date = Patched
  return Patched
}

function restoreDate() {
  if (saved) {
    global.Date = saved
    saved = null
  }
}

module.exports = { mockDate, restoreDate }
