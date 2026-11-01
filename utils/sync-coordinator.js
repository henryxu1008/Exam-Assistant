/** 同一身份的恢复触发合并为一轮；每轮最多三次，失败后等下一次外部触发。 */
function createSyncCoordinator({ ready, context, isCurrent, push, pull, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  let active = null
  return function syncNow() {
    if (!ready()) return Promise.resolve({ ok: false, error: 'SYNC_UNAVAILABLE', attempts: 0 })
    const ctx = context()
    const key = JSON.stringify(ctx)
    if (active && active.key === key) return active.promise
    const run = { key }
    active = run
    run.promise = Promise.resolve().then(async () => {
      for (let index = 0; index < 3; index++) {
        if (index) await wait(index === 1 ? 100 : 400)
        if (!isCurrent(ctx)) return { ok: false, error: 'STALE_CONTEXT', attempts: index }
        try {
          if (await push()) {
            if (!isCurrent(ctx)) return { ok: false, error: 'STALE_CONTEXT', attempts: index + 1 }
            if (await pull()) {
              if (!isCurrent(ctx)) return { ok: false, error: 'STALE_CONTEXT', attempts: index + 1 }
              // 恢复在途期间的新编辑可能已排队，确认这些写入后才能报告本轮成功。
              if (await push()) {
                if (!isCurrent(ctx)) return { ok: false, error: 'STALE_CONTEXT', attempts: index + 1 }
                return { ok: true, attempts: index + 1 }
              }
            }
          }
        } catch (e) {
          if (e && e.retryable === false) return { ok: false, error: e.code, attempts: index + 1 }
          // 本轮失败，下次有界重试仍读取同一持久队列/游标。
        }
      }
      return { ok: false, error: 'SYNC_RETRY_EXHAUSTED', attempts: 3 }
    }).finally(() => { if (active === run) active = null })
    return run.promise
  }
}

module.exports = { createSyncCoordinator }
