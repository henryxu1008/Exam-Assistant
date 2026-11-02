/** Read-only migration archive. Never substituted for the current checkpoint. */
const { canonical, sha256 } = require('../shared/question-domain.js')
const { ENTRY_BUDGET, byteLength } = require('./storage-budget.js')
const fail = () => { throw Object.assign(new Error('LOCAL_BACKUP_UNAVAILABLE'), { code: 'LOCAL_BACKUP_UNAVAILABLE' }) }
function createLocalBackup(storage, scopeHash) {
  const key = scope => 'exam_quiz_backup_v1__' + scopeHash(scope)
  const prefix = scope => 'exam_quiz_backup_page_v1__' + scopeHash(scope) + '__'
  function descriptors(scope, value) {
    const m = value && value.localRepositoryBackup
    if (!m || m.version !== 1 || m.scope !== scopeHash(scope) || !Array.isArray(m.chunks) || !m.chunks.length ||
        !Number.isSafeInteger(m.bytes) || m.bytes < 1 || !/^[a-f0-9]{64}$/.test(m.hash) || m.chunks.some(h => !/^[a-f0-9]{64}$/.test(h))) fail()
    if (sha256(canonical({ scope: m.scope, chunks: m.chunks, bytes: m.bytes })) !== m.hash) fail()
    return m
  }
  function plan(scope, value) {
    if (storage.getStorageSync(key(scope))) return []
    const text = JSON.stringify(value)
    if (byteLength(key(scope)) + byteLength(text) <= ENTRY_BUDGET) return [[key(scope), value]]
    const chunks = [], entries = new Map()
    let bytes = 0
    for (let start = 0; start < text.length;) {
      let end = Math.min(text.length, start + 16000)
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--
      const page = { scope: scopeHash(scope), text: text.slice(start, end) }, hash = sha256(canonical(page))
      const name = prefix(scope) + hash, existing = storage.getStorageSync(name)
      if (existing && canonical(existing) !== canonical(page)) fail()
      if (!existing) entries.set(name, page)
      chunks.push(hash); bytes += byteLength(page.text); start = end
    }
    const m = { scope: scopeHash(scope), chunks, bytes }
    entries.set(key(scope), { localRepositoryBackup: { version: 1, ...m, hash: sha256(canonical(m)) } })
    return [...entries]
  }
  function read(scope) {
    const value = storage.getStorageSync(key(scope))
    if (!value || !value.localRepositoryBackup) return value || null
    const m = descriptors(scope, value)
    let bytes = 0
    const text = m.chunks.map(hash => {
      const page = storage.getStorageSync(prefix(scope) + hash)
      if (!page || page.scope !== m.scope || typeof page.text !== 'string' || sha256(canonical(page)) !== hash) fail()
      bytes += byteLength(page.text); return page.text
    }).join('')
    if (bytes !== m.bytes) fail()
    return JSON.parse(text)
  }
  function liveKeys(scope) {
    const value = storage.getStorageSync(key(scope))
    return new Set(value && value.localRepositoryBackup ? descriptors(scope, value).chunks.map(hash => prefix(scope) + hash) : [])
  }
  return { key, prefix, plan, read, liveKeys }
}
module.exports = { createLocalBackup }
