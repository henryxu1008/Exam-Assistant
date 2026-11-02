/** User-scoped checkpoints and immutable confirmed-attempt pages. No network access. */
const { businessKey, sameOperation } = require('../shared/attempt-domain.js')
const { canonical, sha256 } = require('../shared/question-domain.js')
const { byteLength: bytes, checkEntry, createBudget } = require('./storage-budget.js')
const { createLocalBackup } = require('./local-backup.js')
const copy = value => JSON.parse(JSON.stringify(value))
const fail = code => { throw Object.assign(new Error(code), { code }) }
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value) }
  return value
}
function createLocalRepository(storage, onStatusChange) {
  const cache = new Map(), statuses = new Map()
  const rootKey = scope => 'exam_quiz_data_v1__' + scope
  const scopeHash = scope => sha256(String(scope))
  const prefix = scope => 'exam_quiz_history_v1__' + scopeHash(scope) + '__'
  const aiPrefix = scope => 'exam_quiz_ai_history_v1__' + scopeHash(scope) + '__'
  const backup = createLocalBackup(storage, scopeHash), backupKey = backup.key, budget = createBudget(storage)
  const status = scope => ({ state: 'ready', cleanupPending: false, ...(statuses.get(scope) || {}) })
  function mark(scope, patch) {
    const before = status(scope), next = { ...before, ...patch }
    statuses.set(scope, next)
    if (onStatusChange && JSON.stringify(before) !== JSON.stringify(next)) {
      try { onStatusChange(scope, copy(next)) } catch (e) { /* Observers cannot change a checkpoint result. */ }
    }
  }
  function readReady(scope, protocol) {
    const previous = status(scope)
    mark(scope, { protocol, readError: null, ...(previous.writeError ? { state: 'write_error', error: previous.writeError } : { state: 'ready', error: null }) })
  }
  // getStorageInfoSync reports KB. Reserve the old root, all new values and a margin;
  // do not credit post-commit cleanup or assume a native replacement needs no scratch space.
  function admitMigration(scope, entries) {
    let info
    try { info = storage.getStorageInfoSync() } catch (e) { /* Unknown capacity defers this optional migration. */ }
    if (!info || !Array.isArray(info.keys) || !Number.isFinite(info.currentSize) || info.currentSize < 0 ||
        !Number.isFinite(info.limitSize) || info.limitSize <= 0) {
      mark(scope, { capacity: { known: false } }); fail('LOCAL_CAPACITY_UNKNOWN')
    }
    const usedBytes = Math.ceil(info.currentSize * 1024), limitBytes = Math.floor(info.limitSize * 1024)
    const planned = entries.reduce((n, [key, value]) => n + Math.ceil(bytes(key + JSON.stringify(value)) / 1024) * 1024, 0)
    const requiredBytes = planned + Math.max(65536, Math.ceil(planned * 0.1))
    const availableBytes = Math.max(0, limitBytes - usedBytes)
    mark(scope, { capacity: { known: true, usedBytes, limitBytes, requiredBytes, availableBytes } })
    if (requiredBytes > availableBytes) fail('LOCAL_CAPACITY_INSUFFICIENT')
  }
  function metadata(root, scope) {
    const m = root && root.localRepository
    if (!m || !((root.version === 4 && m.version === 1) || (root.version === 5 && m.version === 2)) || m.scope !== scopeHash(scope) || !Number.isSafeInteger(m.epoch) || m.epoch < 0 ||
        typeof m.resetId !== 'string' || !Array.isArray(m.pages) || !Number.isSafeInteger(m.count) || m.count < 0 ||
        m.domainVersion !== 3 || m.pages.some(p => !p || !/^[a-f0-9]{64}$/.test(p.hash) || !Number.isInteger(p.count) || p.count < 1 || p.count > 32) ||
        new Set(m.pages.map(p => p.hash)).size !== m.pages.length || m.pages.reduce((n, p) => n + p.count, 0) !== m.count) fail('INVALID_LOCAL_CHECKPOINT')
    if ((m.deleted !== undefined && m.deleted !== true) || (m.deleted && (m.count !== 0 || m.pages.length !== 0))) fail('INVALID_LOCAL_CHECKPOINT')
    if (Number(root.dataEpoch || 0) !== m.epoch || String(root.pendingDeleteId || '') !== m.resetId) fail('LOCAL_EPOCH_MISMATCH')
    if (m.version === 2) {
      if (!Number.isSafeInteger(m.aiEpoch) || m.aiEpoch < 0 || Number(root.aiEpoch || 0) !== m.aiEpoch || !Array.isArray(m.aiPages) ||
          !Number.isSafeInteger(m.aiCount) || m.aiCount < 0 || m.aiPages.some(p => !p || !/^[a-f0-9]{64}$/.test(p.hash) || !Number.isInteger(p.count) || p.count < 1 || p.count > 32) ||
          m.aiPages.reduce((n, p) => n + p.count, 0) !== m.aiCount || (m.deleted && m.aiCount)) fail('INVALID_LOCAL_AI_CHECKPOINT')
    } else if (m.aiPages !== undefined || m.aiCount !== undefined || m.aiEpoch !== undefined) fail('INVALID_LOCAL_CHECKPOINT')
    return m
  }
  const factSignature = m => canonical({ scope: m.scope, epoch: m.epoch, resetId: m.resetId, pages: m.pages, count: m.count })
  const aiSignature = m => m.version === 2 ? canonical({ scope: m.scope, epoch: m.epoch, resetId: m.resetId, aiEpoch: m.aiEpoch, pages: m.aiPages, count: m.aiCount }) : null
  function aiPageValue(scope, m, descriptor) {
    const page = storage.getStorageSync(aiPrefix(scope) + descriptor.hash)
    if (!page || page.scope !== m.scope || page.epoch !== m.epoch || page.resetId !== m.resetId || page.aiEpoch !== m.aiEpoch ||
        !Array.isArray(page.rows) || page.rows.length !== descriptor.count || sha256(canonical(page)) !== descriptor.hash) fail('LOCAL_AI_HISTORY_UNAVAILABLE')
    return { descriptor, rows: page.rows.map(freeze), values: page.rows.map(canonical) }
  }
  function aiCache(pages, source) {
    const aiValues = pages.flatMap(p => p.values), aiRefs = new WeakMap()
    pages.flatMap(p => p.rows).forEach((row, i) => { if (row && typeof row === 'object') aiRefs.set(freeze(row), aiValues[i]) })
    ;(source || []).forEach((row, i) => { if (row && typeof row === 'object') aiRefs.set(freeze(row), aiValues[i]) })
    return { aiPages: pages, aiValues, aiRefs }
  }
  function planAi(scope, m, messages, old) {
    const values = messages.map(row => row && typeof row === 'object' && old?.aiRefs.has(row) ? old.aiRefs.get(row) : canonical(copy(row)))
    const changed = !old || values.length !== old.aiValues.length || values.some((v, i) => old.aiValues[i] !== v)
    const pages = [], prepared = new Map()
    let offset = 0
    if (old && old.aiContext === canonical([m.scope, m.epoch, m.resetId, m.aiEpoch])) for (const page of old.aiPages) {
      if (changed && page === old.aiPages.at(-1) && page.rows.length < 32) break
      if (page.values.some((v, i) => values[offset + i] !== v)) break
      pages.push(page); offset += page.rows.length
    }
    let rows = [], rowValues = [], size = 0
    const pack = () => {
      if (!rows.length) return
      const value = { scope: m.scope, epoch: m.epoch, resetId: m.resetId, aiEpoch: m.aiEpoch, rows }
      const hash = sha256(canonical(value)), descriptor = { hash, count: rows.length }, key = aiPrefix(scope) + hash
      const existing = storage.getStorageSync(key)
      if (existing && canonical(existing) !== canonical(value)) fail('LOCAL_AI_HISTORY_CONFLICT')
      if (!existing) prepared.set(key, value)
      pages.push({ descriptor, rows, values: rowValues }); rows = []; rowValues = []; size = 0
    }
    for (; offset < values.length; offset++) {
      const length = bytes(values[offset])
      if (rows.length && (rows.length >= 32 || size + length > 64000)) pack()
      rows.push(JSON.parse(values[offset])); rowValues.push(values[offset]); size += length
    }
    pack(); m.aiPages = pages.map(p => p.descriptor); m.aiCount = messages.length
    return { pages, prepared: [...prepared] }
  }
  function pageValue(scope, m, descriptor) {
    const page = storage.getStorageSync(prefix(scope) + descriptor.hash)
    if (!page || page.scope !== m.scope || page.epoch !== m.epoch || page.resetId !== m.resetId || !Array.isArray(page.rows) || page.rows.length !== descriptor.count ||
        sha256(canonical(page)) !== descriptor.hash) fail('LOCAL_HISTORY_UNAVAILABLE')
    return { descriptor, rows: page.rows.map(row => freeze(row)) }
  }
  function available(scope, pages, keyPrefix = prefix) {
    if (!pages.length) return
    const inventory = storage.getStorageInfoSync()
    if (!inventory || !Array.isArray(inventory.keys)) fail('LOCAL_INVENTORY_UNAVAILABLE')
    const keys = new Set(inventory.keys)
    if (pages.some(p => !keys.has(keyPrefix(scope) + p.descriptor.hash))) fail(keyPrefix === aiPrefix ? 'LOCAL_AI_HISTORY_UNAVAILABLE' : 'LOCAL_HISTORY_UNAVAILABLE')
  }
  function read(scope) {
    try {
      const root = storage.getStorageSync(rootKey(scope))
      if (!root || (root.localRepository === undefined && !(Number(root.version) >= 4))) { cache.delete(scope); readReady(scope, 0); return root || null }
      const m = metadata(root, scope)
      if (m.deleted) { if (Object.keys(root).some(k => !['version', 'localRepository'].includes(k))) fail('INVALID_LOCAL_CHECKPOINT'); cache.delete(scope); readReady(scope, 1); return null }
      if (!Array.isArray(root.attempts) || !root.attemptOutbox || root.attemptOutbox.version !== 1 || !Array.isArray(root.attemptOutbox.pending)) fail('INVALID_LOCAL_CHECKPOINT')
      const signature = factSignature(m), previous = cache.get(scope)
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
      const aiSig = aiSignature(m)
      let ai = { aiPages: [], aiValues: [], aiRefs: new WeakMap() }
      if (m.version === 2) {
        if (!Array.isArray(root.aiMessages) || root.aiMessages.length) fail('INVALID_LOCAL_AI_CHECKPOINT')
        const aiPages = previous && previous.aiSignature === aiSig ? previous.aiPages : m.aiPages.map(p => aiPageValue(scope, m, p))
        if (previous && previous.aiSignature === aiSig) available(scope, aiPages, aiPrefix)
        ai = previous && previous.aiSignature === aiSig ? { aiPages, aiValues: previous.aiValues, aiRefs: previous.aiRefs } : aiCache(aiPages)
      }
      const decoded = { ...root, version: m.domainVersion, attempts: pages.flatMap(p => p.rows).concat(root.attempts),
        ...(m.version === 2 ? { aiMessages: ai.aiPages.flatMap(p => p.rows) } : {}) }
      delete decoded.localRepository
      cache.set(scope, { signature, pages, index, ...ai, aiSignature: aiSig, aiContext: m.version === 2 ? canonical([m.scope, m.epoch, m.resetId, m.aiEpoch]) : null })
      readReady(scope, m.version)
      return decoded
    } catch (e) { cache.delete(scope); mark(scope, { state: 'read_error', readError: e.code || 'LOCAL_READ_FAILED', error: e.code || 'LOCAL_READ_FAILED' }); throw Object.assign(e, { code: e.code || 'LOCAL_READ_FAILED' }) }
  }
  function cleanup(scope, keep, dropBackup = false) {
    let failed = status(scope).cleanupPending && typeof storage.getStorageInfoSync !== 'function'
    const known = new Set((cache.get(scope)?.pages || []).map(p => prefix(scope) + p.descriptor.hash).concat((cache.get(scope)?.aiPages || []).map(p => aiPrefix(scope) + p.descriptor.hash)))
    let backupKeep = new Set(), backupSafe = true
    if (!dropBackup) try { backupKeep = backup.liveKeys(scope) } catch (e) { failed = true; backupSafe = false }
    try { if (typeof storage.getStorageInfoSync === 'function') for (const key of storage.getStorageInfoSync().keys) {
      if (key.startsWith(prefix(scope)) || key.startsWith(aiPrefix(scope)) || (backupSafe && key.startsWith(backup.prefix(scope)))) known.add(key)
    } } catch (e) { failed = true }
    for (const key of known) if (!keep.has(key) && !backupKeep.has(key)) { try { storage.removeStorageSync(key) } catch (e) { failed = true } }
    mark(scope, { cleanupPending: failed })
  }
  function write(scope, snapshot, inlineAi = false) {
    const written = []
    let committed = false, rootAttempted = false, legacyFallbackAllowed = false, aiFallbackAllowed = false
    try {
      let raw, oldMeta, previousSnapshot
      // Validate the authoritative checkpoint independently of the candidate write. Cached facts
      // cannot make a missing page readable, and a later write error cannot clear this evidence.
      try {
        raw = storage.getStorageSync(rootKey(scope))
        oldMeta = raw && (raw.localRepository || Number(raw.version) >= 4) ? metadata(raw, scope) : null
        if (oldMeta) previousSnapshot = read(scope)
      } catch (e) {
        cache.delete(scope)
        mark(scope, { state: 'read_error', readError: e.code || 'LOCAL_READ_FAILED', error: e.code || 'LOCAL_READ_FAILED' })
        throw e
      }
      const attempts = snapshot.attempts || [], queue = snapshot.attemptOutbox
      if (!Array.isArray(attempts) || (queue && (queue.version !== 1 || !Array.isArray(queue.pending)))) fail('INVALID_LOCAL_SNAPSHOT')
      const waiting = queue ? new Set(queue.pending.map(a => a && a.id)) : new Set(attempts.map(a => a.id)), seen = new Set()
      if (queue && (waiting.size !== queue.pending.length || [...waiting].some(id => typeof id !== 'string' || !id))) fail('INVALID_LOCAL_SNAPSHOT')
      for (const fact of attempts) { if (!fact || typeof fact.id !== 'string' || !fact.id || seen.has(fact.id)) fail('INVALID_LOCAL_HISTORY'); seen.add(fact.id) }
      const confirmed = attempts.filter(a => !waiting.has(a.id)), epoch = Number(snapshot.dataEpoch || 0), resetId = String(snapshot.pendingDeleteId || '')
      const reset = oldMeta && (oldMeta.epoch !== epoch || oldMeta.resetId !== resetId || (oldMeta.count && !attempts.length))
      const messages = snapshot.aiMessages || []
      if (!Array.isArray(messages)) fail('INVALID_LOCAL_AI_SNAPSHOT')
      const canSegment = snapshot.version === 3 && !!queue
      const pagedAi = oldMeta?.version === 2 || (canSegment && !inlineAi && !status(scope).migrationDeferred && messages.length > 0)
      if (!oldMeta && (!canSegment || (!confirmed.length && !pagedAi) || status(scope).migrationDeferred)) {
        budget.write(rootKey(scope), snapshot, () => { rootAttempted = true })
        committed = true
        if (!attempts.length) { cleanup(scope, new Set(), !messages.length); if (!messages.length) try { storage.removeStorageSync(backupKey(scope)) } catch (e) { mark(scope, { cleanupPending: true }) } }
        cache.delete(scope); mark(scope, { state: 'ready', error: null, readError: null, writeError: null, protocol: 0, commitUncertain: false,
          ...(!attempts.length && !messages.length ? { migrationDeferred: false, migrationError: null } : {}) }); return
      }
      if (!Number.isSafeInteger(epoch) || epoch < 0 || snapshot.version !== 3 || !queue) fail('INVALID_LOCAL_SNAPSHOT')
      const m = { version: pagedAi ? 2 : 1, scope: scopeHash(scope), epoch, resetId, domainVersion: 3, pages: [], count: confirmed.length }
      if (pagedAi) { m.aiEpoch = Number(snapshot.aiEpoch || 0); if (!Number.isSafeInteger(m.aiEpoch) || m.aiEpoch < 0) fail('INVALID_LOCAL_AI_SNAPSHOT') }
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
      let rows = [], size = 0
      const prepared = []
      const pack = () => {
        if (!rows.length) return
        const value = { scope: m.scope, epoch, resetId, rows }, hash = sha256(canonical(value)), descriptor = { hash, count: rows.length }
        const key = prefix(scope) + hash, existing = storage.getStorageSync(key)
        if (existing) { if (canonical(existing) !== canonical(value)) fail('LOCAL_HISTORY_CONFLICT') }
        else prepared.push({ key, value, descriptor })
        pages.push({ descriptor, rows }); rows = []; size = 0
      }
      legacyFallbackAllowed = !oldMeta
      aiFallbackAllowed = oldMeta?.version === 1 && pagedAi
      for (const fact of confirmed) if (!assigned.has(fact.id)) {
        const row = JSON.parse(values.get(fact.id)), length = bytes(values.get(fact.id))
        if (rows.length && (rows.length >= 32 || size + length > 64000)) pack()
        rows.push(row); size += length
      }
      pack(); m.pages = pages.map(p => p.descriptor)
      const ai = pagedAi ? planAi(scope, m, messages, old) : { pages: [], prepared: [] }
      const root = { ...snapshot, version: pagedAi ? 5 : 4, attempts: attempts.filter(a => waiting.has(a.id)), localRepository: m,
        ...(pagedAi ? { aiMessages: [] } : {}) }
      const backupEntries = (!oldMeta || aiFallbackAllowed) && raw ? backup.plan(scope, previousSnapshot || raw) : []
      const entries = backupEntries.concat(prepared.map(p => [p.key, p.value]), ai.prepared)
      // Validate the complete candidate before any preparation write, including large outboxes.
      entries.concat([[rootKey(scope), root]]).forEach(([key, value]) => checkEntry(key, value))
      if (!oldMeta || aiFallbackAllowed || entries.length) admitMigration(scope, entries.concat([[rootKey(scope), root]]))
      for (const [key, value] of entries) {
        budget.write(key, value); written.push(key)
        if (canonical(storage.getStorageSync(key)) !== canonical(value)) fail('LOCAL_PREPARE_VERIFY_FAILED')
      }
      budget.write(rootKey(scope), root, () => { rootAttempted = true })
      committed = true
      const index = new Map()
      for (const page of pages) for (const row of page.rows) {
        const entry = old && old.index.get(row.id)?.value === values.get(row.id) ? old.index.get(row.id) : { value: values.get(row.id), refs: new WeakSet() }
        entry.refs.add(freeze(row)); entry.refs.add(freeze(refs.get(row.id))); index.set(row.id, entry)
      }
      cleanup(scope, new Set(m.pages.map(p => prefix(scope) + p.hash).concat((m.aiPages || []).map(p => aiPrefix(scope) + p.hash))), !!reset)
      cache.set(scope, { signature: factSignature(m), pages, index, ...aiCache(ai.pages, pagedAi ? messages : []), aiSignature: aiSignature(m),
        aiContext: pagedAi ? canonical([m.scope, m.epoch, m.resetId, m.aiEpoch]) : null })
      if (reset) { try { storage.removeStorageSync(backupKey(scope)) } catch (e) { mark(scope, { cleanupPending: true }) } }
      const deferred = !pagedAi && !!messages.length && status(scope).migrationDeferred
      mark(scope, { state: 'ready', error: null, readError: null, writeError: null, protocol: m.version, migrationDeferred: !!deferred,
        migrationError: deferred ? status(scope).migrationError : null, commitUncertain: false })
    } catch (e) {
      if (rootAttempted && !committed) mark(scope, { cleanupPending: true, commitUncertain: true }) // The root may have committed before the storage API reported failure.
      if (!committed && !rootAttempted) for (const key of written) { try { storage.removeStorageSync(key) } catch (cleanupError) { mark(scope, { cleanupPending: true }) } }
      if (aiFallbackAllowed && !rootAttempted) {
        try {
          write(scope, snapshot, true)
          mark(scope, { migrationDeferred: true, migrationError: e.code || 'LOCAL_MIGRATION_FAILED' })
          return
        } catch (fallbackError) { e = fallbackError }
      } else if (legacyFallbackAllowed && !rootAttempted) {
        // Preparing a first migration is an optimization. A complete legacy checkpoint remains a valid atomic write.
        try {
          budget.write(rootKey(scope), snapshot, () => { rootAttempted = true })
          committed = true
          cache.delete(scope)
          mark(scope, { state: 'ready', error: null, readError: null, writeError: null, protocol: 0, migrationDeferred: true, migrationError: e.code || 'LOCAL_MIGRATION_FAILED', commitUncertain: false })
          return
        } catch (fallbackError) {
          if (rootAttempted && !committed) mark(scope, { commitUncertain: true })
          e = fallbackError
        }
      }
      const readError = status(scope).readError
      mark(scope, { state: readError ? 'read_error' : 'write_error', error: readError || e.code || 'LOCAL_WRITE_FAILED', writeError: e.code || 'LOCAL_WRITE_FAILED' })
      throw Object.assign(e, { code: e.code || 'LOCAL_WRITE_FAILED' })
    }
  }
  function clear(scope) {
    // Empty authoritative checkpoint precedes physical deletion. A cleanup failure cannot resurrect the backup.
    const m = { version: 1, scope: scopeHash(scope), epoch: 0, resetId: '', domainVersion: 3, pages: [], count: 0, deleted: true }
    let attempted = false
    try { budget.write(rootKey(scope), { version: 4, localRepository: m }, () => { attempted = true }) } catch (e) { mark(scope, { state: status(scope).readError ? 'read_error' : 'write_error', error: status(scope).readError || e.code || 'LOCAL_WRITE_FAILED', writeError: e.code || 'LOCAL_WRITE_FAILED', commitUncertain: attempted }); throw e }
    cleanup(scope, new Set(), true); cache.delete(scope)
    mark(scope, { state: 'ready', error: null, readError: null, writeError: null, protocol: 1, migrationDeferred: false, migrationError: null, commitUncertain: false })
    try { storage.removeStorageSync(backupKey(scope)) } catch (e) { mark(scope, { cleanupPending: true }) }
  }
  function rollback(scope) {
    const snapshot = read(scope)
    let attempted = false
    try {
      budget.write(rootKey(scope), snapshot || { version: 3, attempts: [], attemptOutbox: { version: 1, pending: [] } }, () => { attempted = true })
    } catch (e) { mark(scope, { state: 'write_error', error: e.code || 'LOCAL_WRITE_FAILED', writeError: e.code || 'LOCAL_WRITE_FAILED', commitUncertain: attempted }); throw e }
    cleanup(scope, new Set(), true); cache.delete(scope)
    try { storage.removeStorageSync(backupKey(scope)) } catch (e) { mark(scope, { cleanupPending: true }) }
    mark(scope, { state: 'ready', error: null, readError: null, writeError: null, protocol: 0, migrationDeferred: false, migrationError: null, commitUncertain: false })
    return { ok: true, cleanupPending: status(scope).cleanupPending }
  }
  return { read, write, clear, rollback, readMigrationBackup: backup.read, release: scope => cache.delete(scope), retryMigration: scope => mark(scope, { migrationDeferred: false }), status, rootKey, backupKey }
}
module.exports = { createLocalRepository }
