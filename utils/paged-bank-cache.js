/** Stages immutable public pages before atomically switching the local root pointer. */
const paged = require('../shared/paged-catalog-domain.js')
const { canonical } = require('../shared/question-domain.js')
const ROOT = 'exam_quiz_bank_paged_root_v1'
const key = (root, index) => 'exam_quiz_bank_paged_v1__' + root.releaseId + '__' + index
const same = (a, b) => canonical(a) === canonical(b)
const absent = value => value === undefined || value === null || value === ''
function createPagedCache(storage) {
  const get = k => {
    try { return storage.getStorageSync(k) }
    catch (e) { throw Object.assign(new Error('PAGED_CACHE_READ_FAILED'), { code: 'PAGED_CACHE_READ_FAILED' }) }
  }
  function pointer() {
    const data = get(ROOT)
    if (absent(data)) return null
    if (!data || !paged.validRoot(data.root) || !Number.isSafeInteger(data.publicationRevision) || data.publicationRevision < 1) throw Object.assign(new Error('INVALID_PAGED_CACHE'), { code: 'INVALID_PAGED_CACHE' })
    return data
  }
  function pointerForInstall() {
    try { return pointer() }
    catch (e) { if (e.code === 'INVALID_PAGED_CACHE') return null; throw e }
  }
  function assemble(root, publicationRevision, pages) {
    const questions = Object.fromEntries(root.manifest.subjects.map(s => [s.key, []]))
    for (const page of pages) for (const q of page.questions) questions[q.subject].push(q)
    return { schemaVersion: 4, manifest: root.manifest, questions, releaseId: root.releaseId, publicationRevision }
  }
  function read() {
    try {
      const head = pointer()
      if (!head) return { status: 'missing' }
      const pages = head.root.pages.map((_, index) => get(key(head.root, index)))
      if (pages.some((page, index) => !page || page.index !== index || !paged.validQuestionPage(head.root, page)) ||
          paged.identityDigest(pages.flatMap(page => page.questions)) !== head.root.identityDigest) throw new Error('INVALID_PAGED_CACHE')
      return { status: 'ready', source: assemble(head.root, head.publicationRevision, pages), root: head.root }
    } catch (e) { return { status: 'error', error: e.code === 'PAGED_CACHE_READ_FAILED' ? e.code : 'INVALID_PAGED_CACHE' } }
  }
  function install(root, publicationRevision, pages) {
    try {
      if (!paged.validRoot(root) || !Number.isSafeInteger(publicationRevision) || publicationRevision < 1 || !Array.isArray(pages) ||
          pages.length !== root.pages.length || pages.some((page, i) => !page || page.index !== i || !paged.validQuestionPage(root, page)) ||
          paged.identityDigest(pages.flatMap(page => page.questions)) !== root.identityDigest) return { ok: false, error: 'INVALID_PAGED_RELEASE' }
      let previous = pointerForInstall()
      const stale = p => p && (publicationRevision < p.publicationRevision || (publicationRevision === p.publicationRevision && root.releaseId !== p.root.releaseId))
      if (stale(previous)) return { ok: false, error: 'STALE_PAGED_RELEASE' }
      for (const page of pages) {
        const name = key(root, page.index), old = get(name)
        if (!same(old, page)) storage.setStorageSync(name, page)
        if (!same(get(name), page)) return { ok: false, error: 'PAGED_CACHE_WRITE_FAILED' }
      }
      // No asynchronous operation between this check and the pointer update.
      previous = pointerForInstall()
      if (stale(previous)) return { ok: false, error: 'STALE_PAGED_RELEASE' }
      const next = { root, publicationRevision }
      try { storage.setStorageSync(ROOT, next) } catch (e) { if (!same(get(ROOT), next)) return { ok: false, error: 'PAGED_CACHE_WRITE_FAILED' } }
      if (!same(get(ROOT), next)) return { ok: false, error: 'PAGED_CACHE_WRITE_FAILED' }
      return { ok: true, source: assemble(root, publicationRevision, pages) }
    } catch (e) { return { ok: false, error: e.code === 'PAGED_CACHE_READ_FAILED' ? e.code : 'PAGED_CACHE_WRITE_FAILED' } }
  }
  return { read, install }
}
module.exports = { createPagedCache }
