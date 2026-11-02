/** Conservative UTF-8 JSON budget below the native single-key ceiling. */
const ENTRY_BUDGET = 900 * 1024
const byteLength = text => encodeURIComponent(text).replace(/%[A-F0-9]{2}/g, 'x').length
const entryBytes = (key, value) => byteLength(key + JSON.stringify(value))
const fail = code => { throw Object.assign(new Error(code), { code }) }
function checkEntry(key, value) {
  const size = entryBytes(key, value)
  if (size > ENTRY_BUDGET) fail('LOCAL_ENTRY_TOO_LARGE')
  return size
}
function createBudget(storage) {
  function write(key, value, onAttempt) {
    const size = checkEntry(key, value)
    let info
    try { info = storage.getStorageInfoSync() } catch (e) { /* Native write remains authoritative when quota metadata is unavailable. */ }
    if (info && Array.isArray(info.keys) && Number.isFinite(info.currentSize) && info.currentSize >= 0 && Number.isFinite(info.limitSize) && info.limitSize > 0) {
      const oldSize = info.keys.includes(key) ? entryBytes(key, storage.getStorageSync(key)) : 0
      if (Math.ceil(info.currentSize * 1024) + Math.max(0, size - oldSize) > Math.floor(info.limitSize * 1024)) fail('LOCAL_CAPACITY_INSUFFICIENT')
    }
    if (onAttempt) onAttempt()
    storage.setStorageSync(key, value)
  }
  return { write }
}
module.exports = { ENTRY_BUDGET, byteLength, entryBytes, checkEntry, createBudget }
