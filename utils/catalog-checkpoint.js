/** Account-scoped local workspace; root changes and small form edits use independent checkpoints. */
const { sha256 } = require('../shared/question-domain.js')
const fail = code => { throw Object.assign(new Error(code), { code }) }
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const size = value => encodeURIComponent(JSON.stringify(value)).replace(/%[A-F0-9]{2}/g, 'x').length
const seal = value => ({ ...value, digest: sha256(JSON.stringify(value)) })
const intact = value => { const { digest, ...body } = value; return typeof digest === 'string' && digest === sha256(JSON.stringify(body)) }
function createCatalogCheckpoint(storage, openid) {
  if (typeof openid !== 'string' || !openid) fail('NO_TOKEN')
  const owner = sha256(openid), key = 'exam_catalog_editor_v1__' + owner, overlayKey = key + '__form'
  function get(k) { try { return storage.getStorageSync(k) } catch (e) { fail('LOCAL_DRAFT_READ_FAILED') } }
  function write(k, value, limit = 900000) {
    if (size(value) > limit) fail('LOCAL_DRAFT_TOO_LARGE')
    try { storage.setStorageSync(k, value) } catch (e) {
      // Some APIs can report failure after writing. Read back before deciding whether it committed.
      if (!same(get(k), value)) fail('LOCAL_DRAFT_WRITE_FAILED')
    }
    if (!same(get(k), value)) fail('LOCAL_DRAFT_WRITE_FAILED')
  }
  function read() {
    const root = get(key)
    if (root === '' || root === undefined || root === null) return null
    if (!root || ![1, 2].includes(root.version) || root.owner !== owner || typeof root.id !== 'string' || !/^[a-f0-9]{64}$/.test(root.id) ||
      !Number.isSafeInteger(root.revision) || root.revision < 1 || !root.ui || size(root) > 900000 || !intact(root)) fail('LOCAL_DRAFT_INVALID')
    let workspace = root.workspace
    if (root.version === 2) {
      if (!/^[a-f0-9]{64}$/.test(root.generation || '') || !Number.isSafeInteger(root.chunks) || root.chunks < 1 || root.chunks > 150 || !/^[a-f0-9]{64}$/.test(root.contentDigest || '')) fail('LOCAL_DRAFT_INVALID')
      let content = ''
      for (let i = 0; i < root.chunks; i++) {
        const part = get(key + '__part__' + root.generation + '__' + i)
        if (!part || part.owner !== owner || part.generation !== root.generation || part.index !== i || typeof part.content !== 'string' || !intact(part)) fail('LOCAL_DRAFT_INVALID')
        content += part.content
      }
      if (sha256(content) !== root.contentDigest) fail('LOCAL_DRAFT_INVALID')
      try { workspace = JSON.parse(content) } catch (e) { fail('LOCAL_DRAFT_INVALID') }
    }
    if (!workspace || typeof workspace !== 'object') fail('LOCAL_DRAFT_INVALID')
    const overlay = get(overlayKey)
    let ui = root.ui, sequence = 0
    if (overlay !== '' && overlay !== undefined && overlay !== null) {
      if (!overlay || overlay.version !== 1 || overlay.owner !== owner || typeof overlay.id !== 'string' ||
          !Number.isSafeInteger(overlay.revision) || !Number.isSafeInteger(overlay.sequence) || overlay.sequence < 1 || !overlay.ui || size(overlay) > 800000 || !intact(overlay)) fail('LOCAL_DRAFT_INVALID')
      if (overlay.id === root.id && overlay.revision === root.revision) { ui = overlay.ui; sequence = overlay.sequence }
    }
    return { workspace, ui, token: { id: root.id, revision: root.revision, sequence } }
  }
  function check(expected) {
    const current = read()
    if (!current || !same(current.token, expected)) fail('LOCAL_DRAFT_CHANGED')
    return current
  }
  function create(workspace, ui) {
    if (read()) fail('LOCAL_DRAFT_EXISTS')
    const id = sha256(JSON.stringify([owner, Date.now(), Math.random()]))
    writeWorkspace(id, 1, workspace, ui, null)
    return { id, revision: 1, sequence: 0 }
  }
  function writeWorkspace(id, revision, workspace, ui, expected) {
    const content = JSON.stringify(workspace)
    if (!content || content.length > 9000000) fail('LOCAL_DRAFT_TOO_LARGE')
    const generation = sha256(JSON.stringify([owner, id, revision, Date.now(), Math.random()])), parts = []
    for (let offset = 0; offset < content.length;) {
      let end = Math.min(offset + 60000, content.length)
      if (end < content.length && /[\uD800-\uDBFF]/.test(content[end - 1])) end--
      parts.push(content.slice(offset, end)); offset = end
    }
    const chunks = parts.length
    if (chunks > 150) fail('LOCAL_DRAFT_TOO_LARGE')
    for (let i = 0; i < chunks; i++) write(key + '__part__' + generation + '__' + i,
      seal({ owner, generation, index: i, content: parts[i] }))
    if (expected) check(expected)
    else if (read()) fail('LOCAL_DRAFT_EXISTS')
    const previous = get(key)
    write(key, seal({ version: 2, owner, id, revision, generation, chunks, contentDigest: sha256(content), ui }))
    // Only the old committed generation is reclaimable; failed staging generations remain untouched.
    if (previous && previous.version === 2 && previous.owner === owner && intact(previous) && /^[a-f0-9]{64}$/.test(previous.generation || '') && Number.isSafeInteger(previous.chunks) && previous.chunks > 0 && previous.chunks <= 150) {
      for (let i = 0; i < previous.chunks; i++) { try { storage.removeStorageSync(key + '__part__' + previous.generation + '__' + i) } catch (e) { /* committed root remains valid */ } }
    }
  }
  function saveWorkspace(expected, workspace, ui) {
    const old = check(expected), revision = old.token.revision + 1
    if (!Number.isSafeInteger(revision)) fail('LOCAL_DRAFT_INVALID')
    writeWorkspace(old.token.id, revision, workspace, ui, expected)
    return { id: old.token.id, revision, sequence: 0 }
  }
  function saveForm(expected, ui) {
    const old = check(expected), sequence = old.token.sequence + 1
    if (!Number.isSafeInteger(sequence)) fail('LOCAL_DRAFT_INVALID')
    write(overlayKey, seal({ version: 1, owner, id: old.token.id, revision: old.token.revision, sequence, ui }), 800000)
    return { id: old.token.id, revision: old.token.revision, sequence }
  }
  function clear(expected) {
    check(expected)
    const root = get(key)
    try { storage.removeStorageSync(key); storage.removeStorageSync(overlayKey) } catch (e) { fail('LOCAL_DRAFT_CLEANUP_FAILED') }
    if (read()) fail('LOCAL_DRAFT_CLEANUP_FAILED')
    if (root.version === 2) for (let i = 0; i < root.chunks; i++) {
      const partKey = key + '__part__' + root.generation + '__' + i
      try { storage.removeStorageSync(partKey) } catch (e) { fail('LOCAL_DRAFT_CLEANUP_FAILED') }
      if (get(partKey)) fail('LOCAL_DRAFT_CLEANUP_FAILED')
    }
  }
  return { read, create, saveWorkspace, saveForm, clear }
}
module.exports = { createCatalogCheckpoint }
