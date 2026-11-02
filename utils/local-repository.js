/** User-scoped checkpoints and immutable confirmed-attempt pages. No network access. */
const { businessKey, sameOperation } = require('../shared/attempt-domain.js')
const { canonical, sha256 } = require('../shared/question-domain.js')
const copy = value => JSON.parse(JSON.stringify(value))
const fail = code => { throw Object.assign(new Error(code), { code }) }
const bytes = text => encodeURIComponent(text).replace(/%[A-F0-9]{2}/g, 'x').length
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value) }
  return value
}
function createLocalRepository(storage) {
  const cache = new Map(), statuses = new Map()
  const rootKey = scope => 'exam_quiz_data_v1__' + scope
  const scopeHash = scope => sha256(String(scope))
  const prefix = scope => 'exam_quiz_history_v1__' + scopeHash(scope) + '__'
  const backupKey = scope => 'exam_quiz_backup_v1__' + scopeHash(scope)
  const status = scope => ({ state: 'ready', cleanupPending: false, ...(statuses.get(scope) || {}) })
  const mark = (scope, patch) => statuses.set(scope, { ...status(scope), ...patch })
  function metadata(root, scope) {
    const m = root && root.localRepository
    if (!m || root.version !== 4 || m.version !== 1 || m.scope !== scopeHash(scope) || !Number.isSafeInteger(m.epoch) || m.epoch < 0 ||
        typeof m.resetId !== 'string' || !Array.isArray(m.pages) || !Number.isSafeInteger(m.count) || m.count < 0 ||
        m.domainVersion !== 3 || m.pages.some(p => !p || !/^[a-f0-9]{64}$/.test(p.hash) || !Number.isInteger(p.count) || p.count < 1 || p.count > 32) ||
        new Set(m.pages.map(p => p.hash)).size !== m.pages.length || m.pages.reduce((n, p) => n + p.count, 0) !== m.count) fail('INVALID_LOCAL_CHECKPOINT')
    if ((m.deleted !== undefined && m.deleted !== true) || (m.deleted && (m.count !== 0 || m.pages.length !== 0))) fail('INVALID_LOCAL_CHECKPOINT')
    if (Number(root.dataEpoch || 0) !== m.epoch || String(root.pendingDeleteId || '') !== m.resetId) fail('LOCAL_EPOCH_MISMATCH')
    return m
  }
  function pageValue(scope, m, descriptor) {
    const page = storage.getStorageSync(prefix(scope) + descriptor.hash)
    if (!page || page.scope !== m.scope || page.epoch !== m.epoch || page.resetId !== m.resetId || !Array.isArray(page.rows) || page.rows.length !== descriptor.count ||
        sha256(canonical(page)) !== descriptor.hash) fail('LOCAL_HISTORY_UNAVAILABLE')
    return { descriptor, rows: page.rows.map(row => freeze(row)) }
  }
  function available(scope, pages) {
    if (!pages.length) return
    const inventory = storage.getStorageInfoSync()
    if (!inventory || !Array.isArray(inventory.keys)) fail('LOCAL_INVENTORY_UNAVAILABLE')
    const keys = new Set(inventory.keys)
    if (pages.some(p => !keys.has(prefix(scope) + p.descriptor.hash))) fail('LOCAL_HISTORY_UNAVAILABLE')
  }
  function read(scope) {
    try {
      const root = storage.getStorageSync(rootKey(scope))
      if (!root || (root.localRepository === undefined && !(Number(root.version) >= 4))) { cache.delete(scope); mark(scope, { state: 'ready', error: null, protocol: 0 }); return root || null }
      const m = metadata(root, scope)
      if (m.deleted) { if (Object.keys(root).some(k => !['version', 'localRepository'].includes(k))) fail('INVALID_LOCAL_CHECKPOINT'); cache.delete(scope); mark(scope, { state: 'ready', error: null, protocol: 1 }); return null }
      if (!Array.isArray(root.attempts) || !root.attemptOutbox || root.attemptOutbox.version !== 1 || !Array.isArray(root.attemptOutbox.pending)) fail('INVALID_LOCAL_CHECKPOINT')
      const signature = canonical(m), previous = cache.get(scope)
      const pages = previous && previous.signature === signature ? previous.pages : m.pages.map(p => pageValue(scope, m, p))
      if (previous && previous.signature === signature) available(scope, pages)
      const index = previous && previous.signature === signature ? previous.index : new Map()
      if (!(previous && previous.signature === signature)) for (const page of pages) for (const fact of page.rows) {
        if (!fact || typeof fact.id !== 'string' || !fact.id || index.has(fact.id)) fail('INVALID_LOCAL_HISTORY')
        const old = previous && previous.index.get(fact.id)
        index.set(fact.id, old && old.value === canonical(fact) ? old : { value: canonical(fact), refs: new WeakSet([fact]) })
      }
      const pending = new Set(root.attemptOutbox.pending.map(a => a && a.id)), inline = new Map(root.attempts.map(a => [a && a.id, a]))
      if (pending.size !== root.attemptOutbox.pending.length || [...pending].some(id => typeof id !== 'string' || !id || index.has(id)) || inline.size !== root.attempts.length ||
          root.attempts.some(a => !a || typeof a.id !== 'string' || !pending.has(a.id))) fail('INVALID_LOCAL_CHECKPOINT')
      for (const operation of root.attemptOutbox.pending) {
        const fact = inline.get(operation.id)
        if (fact ? !sameOperation(fact, operation) : !businessKey(operation) || !pages.some(p => p.rows.some(a => businessKey(a) === businessKey(operation) && sameOperation(a, operation)))) fail('INVALID_LOCAL_CHECKPOINT')
      }
      const decoded = { ...root, version: m.domainVersion, attempts: pages.flatMap(p => p.rows).concat(root.attempts) }
      delete decoded.localRepository
      cache.set(scope, { signature, pages, index })
      mark(scope, { state: 'ready', error: null, protocol: 1 })
      return decoded
    } catch (e) { mark(scope, { state: 'read_error', error: e.code || 'LOCAL_READ_FAILED' }); throw Object.assign(e, { code: e.code || 'LOCAL_READ_FAILED' }) }
  }
  function cleanup(scope, keep) {
    let failed = status(scope).cleanupPending && typeof storage.getStorageInfoSync !== 'function'
    const known = new Set((cache.get(scope)?.pages || []).map(p => prefix(scope) + p.descriptor.hash))
    try { if (typeof storage.getStorageInfoSync === 'function') for (const key of storage.getStorageInfoSync().keys) if (key.startsWith(prefix(scope))) known.add(key) } catch (e) { failed = true }
    for (const key of known) if (!keep.has(key)) { try { storage.removeStorageSync(key) } catch (e) { failed = true } }
    mark(scope, { cleanupPending: failed })
  }
  function write(scope, snapshot) {
    const written = [], previousCache = cache.get(scope)
    let committed = false, rootAttempted = false, legacyFallbackAllowed = false
    try {
      const raw = storage.getStorageSync(rootKey(scope)), oldMeta = raw && raw.localRepository ? metadata(raw, scope) : null
      // A missing/corrupt page must be noticed before a new checkpoint can replace its evidence.
      if (oldMeta && !oldMeta.deleted && (!previousCache || previousCache.signature !== canonical(oldMeta))) read(scope)
      const attempts = snapshot.attempts || [], queue = snapshot.attemptOutbox
      if (!Array.isArray(attempts) || (queue && (queue.version !== 1 || !Array.isArray(queue.pending)))) fail('INVALID_LOCAL_SNAPSHOT')
      const waiting = queue ? new Set(queue.pending.map(a => a && a.id)) : new Set(attempts.map(a => a.id)), seen = new Set()
      if (queue && (waiting.size !== queue.pending.length || [...waiting].some(id => typeof id !== 'string' || !id))) fail('INVALID_LOCAL_SNAPSHOT')
      for (const fact of attempts) { if (!fact || typeof fact.id !== 'string' || !fact.id || seen.has(fact.id)) fail('INVALID_LOCAL_HISTORY'); seen.add(fact.id) }
      const confirmed = attempts.filter(a => !waiting.has(a.id)), epoch = Number(snapshot.dataEpoch || 0), resetId = String(snapshot.pendingDeleteId || '')
      const reset = oldMeta && (oldMeta.epoch !== epoch || oldMeta.resetId !== resetId || (oldMeta.count && !attempts.length))
      if (!oldMeta && (!confirmed.length || status(scope).migrationDeferred)) {
        storage.setStorageSync(rootKey(scope), snapshot)
        if (!attempts.length) { cleanup(scope, new Set()); try { storage.removeStorageSync(backupKey(scope)) } catch (e) { mark(scope, { cleanupPending: true }) } }
        cache.delete(scope); mark(scope, { state: 'ready', error: null, protocol: 0 }); return
      }
      if (!Number.isSafeInteger(epoch) || epoch < 0 || snapshot.version !== 3 || !queue) fail('INVALID_LOCAL_SNAPSHOT')
      const m = { version: 1, scope: scopeHash(scope), epoch, resetId, domainVersion: 3, pages: [], count: confirmed.length }
      const old = cache.get(scope), values = new Map(), refs = new Map()
      for (const fact of confirmed) {
        const prior = old && old.index.get(fact.id)
        const value = prior && prior.refs.has(fact) ? prior.value : canonical(copy(fact))
        values.set(fact.id, value); refs.set(fact.id, fact)
      }
      const assigned = new Set(), pages = []
      const changed = !old || old.index.size !== values.size || [...values].some(([id, value]) => old.index.get(id)?.value !== value)
      if (!reset && old) for (const page of old.pages) {
        if (changed && page === old.pages.at(-1) && page.rows.length < 32) continue // Coalesce only the bounded tail, not one page per ACK.
        if (page.rows.every(row => values.get(row.id) === old.index.get(row.id)?.value)) {
          pages.push(page); page.rows.forEach(row => assigned.add(row.id))
        }
      }
      available(scope, pages)
      let rows = [], size = 0
      const pack = () => {
        if (!rows.length) return
        const value = { scope: m.scope, epoch, resetId, rows }, hash = sha256(canonical(value)), descriptor = { hash, count: rows.length }
        const key = prefix(scope) + hash, existing = storage.getStorageSync(key)
        if (existing) { if (canonical(existing) !== canonical(value)) fail('LOCAL_HISTORY_CONFLICT') }
        else { storage.setStorageSync(key, value); written.push(key) }
        const checked = pageValue(scope, m, descriptor)
        pages.push(checked); rows = []; size = 0
      }
      legacyFallbackAllowed = !oldMeta
      if (!oldMeta && raw) {
        const backup = storage.getStorageSync(backupKey(scope))
        if (!backup) storage.setStorageSync(backupKey(scope), raw)
      }
      for (const fact of confirmed) if (!assigned.has(fact.id)) {
        const row = JSON.parse(values.get(fact.id)), length = bytes(values.get(fact.id))
        if (rows.length && (rows.length >= 32 || size + length > 64000)) pack()
        rows.push(row); size += length
      }
      pack(); m.pages = pages.map(p => p.descriptor)
      const root = { ...snapshot, version: 4, attempts: attempts.filter(a => waiting.has(a.id)), localRepository: m }
      rootAttempted = true
      storage.setStorageSync(rootKey(scope), root)
      committed = true
      const index = new Map()
      for (const page of pages) for (const row of page.rows) {
        const entry = old && old.index.get(row.id)?.value === values.get(row.id) ? old.index.get(row.id) : { value: values.get(row.id), refs: new WeakSet() }
        entry.refs.add(freeze(row)); entry.refs.add(freeze(refs.get(row.id))); index.set(row.id, entry)
      }
      cleanup(scope, new Set(m.pages.map(p => prefix(scope) + p.hash)))
      cache.set(scope, { signature: canonical(m), pages, index })
      if (reset) { try { storage.removeStorageSync(backupKey(scope)) } catch (e) { mark(scope, { cleanupPending: true }) } }
      mark(scope, { state: 'ready', error: null, protocol: 1, migrationDeferred: false, migrationError: null })
    } catch (e) {
      if (rootAttempted && !committed) mark(scope, { cleanupPending: true }) // The root may have committed before the storage API reported failure.
      if (!committed && !rootAttempted) for (const key of written) { try { storage.removeStorageSync(key) } catch (cleanupError) { mark(scope, { cleanupPending: true }) } }
      if (legacyFallbackAllowed && !rootAttempted) {
        // Preparing a first migration is an optimization. A complete legacy checkpoint remains a valid atomic write.
        try {
          try { storage.removeStorageSync(backupKey(scope)) } catch (cleanupError) { mark(scope, { cleanupPending: true }) }
          storage.setStorageSync(rootKey(scope), snapshot)
          cache.delete(scope)
          mark(scope, { state: 'ready', error: null, protocol: 0, migrationDeferred: true, migrationError: e.code || 'LOCAL_MIGRATION_FAILED' })
          return
        } catch (fallbackError) { e = fallbackError }
      }
      mark(scope, { state: 'write_error', error: e.code || 'LOCAL_WRITE_FAILED' })
      throw Object.assign(e, { code: e.code || 'LOCAL_WRITE_FAILED' })
    }
  }
  function clear(scope) {
    // Empty authoritative checkpoint precedes physical deletion. A cleanup failure cannot resurrect the backup.
    const m = { version: 1, scope: scopeHash(scope), epoch: 0, resetId: '', domainVersion: 3, pages: [], count: 0, deleted: true }
    try { storage.setStorageSync(rootKey(scope), { version: 4, localRepository: m }) } catch (e) { mark(scope, { state: 'write_error', error: 'LOCAL_WRITE_FAILED' }); throw e }
    cleanup(scope, new Set()); cache.delete(scope)
    mark(scope, { state: 'ready', error: null, protocol: 1 })
    try { storage.removeStorageSync(backupKey(scope)) } catch (e) { mark(scope, { cleanupPending: true }) }
  }
  function rollback(scope) {
    const snapshot = read(scope)
    try {
      if (snapshot) storage.setStorageSync(rootKey(scope), snapshot)
      else storage.setStorageSync(rootKey(scope), { version: 3, attempts: [], attemptOutbox: { version: 1, pending: [] } })
    } catch (e) { mark(scope, { state: 'write_error', error: 'LOCAL_WRITE_FAILED' }); throw e }
    cleanup(scope, new Set()); cache.delete(scope)
    try { storage.removeStorageSync(backupKey(scope)) } catch (e) { mark(scope, { cleanupPending: true }) }
    mark(scope, { state: 'ready', error: null, protocol: 0 })
    return { ok: true, cleanupPending: status(scope).cleanupPending }
  }
  return { read, write, clear, rollback, release: scope => cache.delete(scope), retryMigration: scope => mark(scope, { migrationDeferred: false }), status, rootKey, backupKey }
}
module.exports = { createLocalRepository }
