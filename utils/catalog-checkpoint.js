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
    if (!root || root.version !== 1 || root.owner !== owner || typeof root.id !== 'string' || !/^[a-f0-9]{64}$/.test(root.id) ||
      !Number.isSafeInteger(root.revision) || root.revision < 1 || !root.workspace || !root.ui || size(root) > 900000 || !intact(root)) fail('LOCAL_DRAFT_INVALID')
    const overlay = get(overlayKey)
    let ui = root.ui, sequence = 0
    if (overlay !== '' && overlay !== undefined && overlay !== null) {
      if (!overlay || overlay.version !== 1 || overlay.owner !== owner || typeof overlay.id !== 'string' ||
          !Number.isSafeInteger(overlay.revision) || !Number.isSafeInteger(overlay.sequence) || overlay.sequence < 1 || !overlay.ui || size(overlay) > 100000 || !intact(overlay)) fail('LOCAL_DRAFT_INVALID')
      if (overlay.id === root.id && overlay.revision === root.revision) { ui = overlay.ui; sequence = overlay.sequence }
    }
    return { workspace: root.workspace, ui, token: { id: root.id, revision: root.revision, sequence } }
  }
  function check(expected) {
    const current = read()
    if (!current || !same(current.token, expected)) fail('LOCAL_DRAFT_CHANGED')
    return current
  }
  function create(workspace, ui) {
    if (read()) fail('LOCAL_DRAFT_EXISTS')
    const root = { version: 1, owner, id: sha256(JSON.stringify([owner, Date.now(), Math.random()])), revision: 1, workspace, ui }
    write(key, seal(root))
    return { id: root.id, revision: 1, sequence: 0 }
  }
  function saveWorkspace(expected, workspace, ui) {
    const old = check(expected), revision = old.token.revision + 1
    if (!Number.isSafeInteger(revision)) fail('LOCAL_DRAFT_INVALID')
    write(key, seal({ version: 1, owner, id: old.token.id, revision, workspace, ui }))
    return { id: old.token.id, revision, sequence: 0 }
  }
  function saveForm(expected, ui) {
    const old = check(expected), sequence = old.token.sequence + 1
    if (!Number.isSafeInteger(sequence)) fail('LOCAL_DRAFT_INVALID')
    write(overlayKey, seal({ version: 1, owner, id: old.token.id, revision: old.token.revision, sequence, ui }), 100000)
    return { id: old.token.id, revision: old.token.revision, sequence }
  }
  function clear(expected) {
    check(expected)
    try { storage.removeStorageSync(key); storage.removeStorageSync(overlayKey) } catch (e) { fail('LOCAL_DRAFT_CLEANUP_FAILED') }
    if (read()) fail('LOCAL_DRAFT_CLEANUP_FAILED')
  }
  return { read, create, saveWorkspace, saveForm, clear }
}
module.exports = { createCatalogCheckpoint }
