/** Pure data contract for a paged exam catalog. It does not publish or access storage. */
const questions = require('./question-domain.js')
const exams = require('./exam-catalog-domain.js')
const { sourcesFor } = require('./workflow-domain.js')
const { canonical, sha256 } = questions
const fail = code => { throw Object.assign(new Error(code), { code }) }
const bytes = value => encodeURIComponent(canonical(value)).replace(/%[A-F0-9]{2}/g, 'x').length
const keysEqual = (value, expected) => value && typeof value === 'object' && !Array.isArray(value) &&
  canonical(Object.keys(value).sort()) === canonical(expected.slice().sort())
const digest = value => sha256(canonical(value))
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value)
// Activation rereads every public/private page in one bounded transaction.
const MAX_QUESTIONS = 2000, MAX_PAGES = 20, PAGE_QUESTIONS = 100, PAGE_BYTES = 120000, ROOT_BYTES = 200000
const identityDigest = rows => digest(rows.map(q => ({ id: q.id, subject: q.subject, chapter: q.chapter })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

function checkedManifest(manifest) {
  if (!manifest || !Array.isArray(manifest.subjects)) fail('BAD_MANIFEST')
  const empty = Object.fromEntries(manifest.subjects.filter(Boolean).map(s => [s.key, []]))
  return exams.buildExamRelease({ schemaVersion: 3, manifest, questions: empty }).manifest
}
function normalizedQuestion(subject, q) {
  if (!q || (q.subject !== subject.key && q.subject !== subject.name)) fail('BAD_QUESTION_SCOPE')
  const chapters = subject.chapters.filter(c => q.chapter === c.name || q.chapter === c.key || q.chapter === exams.chapterIdentity(subject.key, c.key))
  if (chapters.length !== 1) fail('BAD_QUESTION_SCOPE')
  return questions.versionQuestion({ ...q, subject: subject.key, chapter: exams.chapterIdentity(subject.key, chapters[0].key) })
}
function validRoot(root) {
  try {
    if (!keysEqual(root, ['schemaVersion', 'manifest', 'pages', 'totalQuestions', 'identityDigest', 'releaseId']) || root.schemaVersion !== 4 ||
        !Array.isArray(root.pages) || !root.pages.length || root.pages.length > MAX_PAGES ||
        !Number.isSafeInteger(root.totalQuestions) || root.totalQuestions < 1 || root.totalQuestions > MAX_QUESTIONS ||
        !/^qb_[a-f0-9]{64}$/.test(root.releaseId || '') || !hash(root.identityDigest) || bytes(root) > ROOT_BYTES ||
        canonical(checkedManifest(root.manifest)) !== canonical(root.manifest)) return false
    let total = 0, last = ''
    for (let i = 0; i < root.pages.length; i++) {
      const page = root.pages[i]
      if (!keysEqual(page, ['index', 'count', 'firstId', 'lastId', 'digest']) || page.index !== i ||
          !Number.isSafeInteger(page.count) || page.count < 1 || page.count > PAGE_QUESTIONS ||
          !id(page.firstId) || !id(page.lastId) || page.firstId > page.lastId || (last && page.firstId <= last) || !hash(page.digest)) return false
      total += page.count; last = page.lastId
    }
    const content = { schemaVersion: root.schemaVersion, manifest: root.manifest, pages: root.pages, totalQuestions: root.totalQuestions, identityDigest: root.identityDigest }
    return total === root.totalQuestions && root.releaseId === 'qb_' + digest(content)
  } catch (e) { /* swallow: pure validation rejects invalid input; no storage or network access. */ return false }
}
function validEvidence(root, evidence) {
  try {
    if (!validRoot(root) || !keysEqual(evidence, ['releaseId', 'pages', 'digest']) || evidence.releaseId !== root.releaseId ||
        !Array.isArray(evidence.pages) || evidence.pages.length !== root.pages.length ||
        evidence.pages.some((p, i) => !keysEqual(p, ['index', 'digest']) || p.index !== i || !hash(p.digest))) return false
    return evidence.digest === digest({ releaseId: evidence.releaseId, pages: evidence.pages })
  } catch (e) { /* swallow: pure validation rejects invalid input; no storage or network access. */ return false }
}
function validQuestionPage(root, page) {
  try {
    if (!validRoot(root) || !keysEqual(page, ['releaseId', 'index', 'questions']) || page.releaseId !== root.releaseId ||
        !Number.isSafeInteger(page.index) || !root.pages[page.index] || !Array.isArray(page.questions) || bytes(page) > PAGE_BYTES) return false
    const descriptor = root.pages[page.index], rows = page.questions, subjects = new Map(root.manifest.subjects.map(s => [s.key, s]))
    if (rows.length !== descriptor.count || rows[0].id !== descriptor.firstId || rows[rows.length - 1].id !== descriptor.lastId || digest(rows) !== descriptor.digest) return false
    let previous = ''
    for (const q of rows) {
      const subject = q && subjects.get(q.subject)
      if (!subject || (previous && q.id <= previous) || canonical(normalizedQuestion(subject, q)) !== canonical(q)) return false
      previous = q.id
    }
    return true
  } catch (e) { /* swallow: pure validation rejects invalid input; no storage or network access. */ return false }
}
function validSourcePage(root, evidence, page) {
  try {
    if (!validEvidence(root, evidence) || !keysEqual(page, ['releaseId', 'index', 'sources']) || page.releaseId !== root.releaseId ||
        !Number.isSafeInteger(page.index) || !root.pages[page.index] || !page.sources || typeof page.sources !== 'object' ||
        Array.isArray(page.sources) || bytes(page) > PAGE_BYTES || digest(page.sources) !== evidence.pages[page.index].digest) return false
    return Object.keys(page.sources).length === root.pages[page.index].count
  } catch (e) { /* swallow: pure validation rejects invalid input; no storage or network access. */ return false }
}
function validPagePair(root, evidence, publicPage, privatePage) {
  try {
    if (!validQuestionPage(root, publicPage) || !validSourcePage(root, evidence, privatePage) || publicPage.index !== privatePage.index) return false
    const bank = { questions: { page: publicPage.questions } }
    return canonical(sourcesFor(bank, privatePage.sources)) === canonical(privatePage.sources)
  } catch (e) { /* swallow: pure validation rejects invalid input; no storage or network access. */ return false }
}
function validComplete(root, evidence, publicPages, privatePages) {
  try {
    return validRoot(root) && validEvidence(root, evidence) && Array.isArray(publicPages) && Array.isArray(privatePages) &&
      publicPages.length === root.pages.length && privatePages.length === root.pages.length &&
      publicPages.every((page, i) => page && page.index === i && privatePages[i] && privatePages[i].index === i && validPagePair(root, evidence, page, privatePages[i])) &&
      identityDigest(publicPages.flatMap(page => page.questions)) === root.identityDigest
  } catch (e) { /* swallow: pure validation rejects invalid input; no storage or network access. */ return false }
}
function buildPagedCatalog(input) {
  if (!input || input.schemaVersion !== 4 || !input.questions || typeof input.questions !== 'object' || Array.isArray(input.questions) ||
      !input.sources || typeof input.sources !== 'object' || Array.isArray(input.sources)) fail('BAD_PAGED_CATALOG')
  const manifest = checkedManifest(input.manifest), rows = [], ids = new Set(), names = new Set(manifest.subjects.map(s => s.key))
  if (Object.keys(input.questions).some(k => !names.has(k))) fail('BAD_PAGED_CATALOG')
  const sources = {}
  for (const subject of manifest.subjects) {
    if (!Array.isArray(input.questions[subject.key])) fail('BAD_PAGED_CATALOG')
    for (const raw of input.questions[subject.key]) {
      const row = rows.length + 1
      try {
        const q = normalizedQuestion(subject, raw)
        if (ids.has(q.id)) fail('DUPLICATE_ID')
        if (!Object.prototype.hasOwnProperty.call(input.sources, q.id)) fail('BAD_SOURCES')
        sources[q.id] = sourcesFor({ questions: { page: [q] } }, { [q.id]: input.sources[q.id] })[q.id]
        ids.add(q.id); rows.push(q)
        if (rows.length > MAX_QUESTIONS) fail('PAGED_CATALOG_TOO_LARGE')
      } catch (e) {
        e.row = row
        e.field = ({ BAD_ANSWER: 'answer', BAD_OPTIONS: 'options', BAD_SOURCES: 'sources', BAD_QUESTION_SCOPE: 'scope', DUPLICATE_ID: 'id' })[e.code] || 'question'
        throw e
      }
    }
  }
  if (!rows.length || Object.keys(input.sources).length !== rows.length) fail('BAD_PAGED_CATALOG')
  rows.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  const groups = []
  let group = [], groupSources = {}
  const flush = () => { if (group.length) groups.push({ questions: group, sources: groupSources }); group = []; groupSources = {} }
  for (const q of rows) {
    const nextGroup = group.concat(q), nextSources = { ...groupSources, [q.id]: sources[q.id] }
    // Reserve wrapper metadata below the per-document budget.
    if (group.length && (nextGroup.length > PAGE_QUESTIONS || bytes(nextGroup) > PAGE_BYTES - 256 || bytes(nextSources) > PAGE_BYTES - 256)) flush()
    group.push(q); groupSources[q.id] = sources[q.id]
    if (bytes(group) > PAGE_BYTES - 256 || bytes(groupSources) > PAGE_BYTES - 256) fail('PAGED_ITEM_TOO_LARGE')
  }
  flush()
  if (groups.length > MAX_PAGES) fail('PAGED_CATALOG_TOO_LARGE')
  const descriptors = groups.map((g, index) => ({ index, count: g.questions.length, firstId: g.questions[0].id,
    lastId: g.questions[g.questions.length - 1].id, digest: digest(g.questions) }))
  const content = { schemaVersion: 4, manifest, pages: descriptors, totalQuestions: rows.length, identityDigest: identityDigest(rows) }
  const root = { ...content, releaseId: 'qb_' + digest(content) }
  const evidenceContent = { releaseId: root.releaseId, pages: groups.map((g, index) => ({ index, digest: digest(g.sources) })) }
  const evidence = { ...evidenceContent, digest: digest(evidenceContent) }
  const publicPages = groups.map((g, index) => ({ releaseId: root.releaseId, index, questions: g.questions }))
  const privatePages = groups.map((g, index) => ({ releaseId: root.releaseId, index, sources: g.sources }))
  if (!validComplete(root, evidence, publicPages, privatePages)) fail('BAD_PAGED_CATALOG')
  return { root, evidence, publicPages, privatePages }
}
function findQuestion(root, page, questionId, versionId) {
  if (!validQuestionPage(root, page) || !id(questionId) || !/^qv_[a-f0-9]{64}$/.test(versionId || '')) return null
  const q = page.questions.find(item => item.id === questionId && item.versionId === versionId)
  return q ? { ...q, bankReleaseId: root.releaseId, catalogProtocol: 4 } : null
}
function pageDocumentId(releaseId, index) {
  if (!/^qb_[a-f0-9]{64}$/.test(releaseId || '') || !Number.isSafeInteger(index) || index < 0 || index >= MAX_PAGES) fail('BAD_PAGE_QUERY')
  return 'bp_' + sha256(JSON.stringify([releaseId, index]))
}
function findPageIndex(root, questionId) {
  if (!validRoot(root) || !id(questionId)) return -1
  let lo = 0, hi = root.pages.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1, page = root.pages[mid]
    if (questionId < page.firstId) hi = mid - 1
    else if (questionId > page.lastId) lo = mid + 1
    else return mid
  }
  return -1
}
module.exports = { buildPagedCatalog, validRoot, validEvidence, validQuestionPage, validSourcePage, validPagePair, validComplete, findQuestion, pageDocumentId, findPageIndex, identityDigest,
  limits: { MAX_QUESTIONS, MAX_PAGES, PAGE_QUESTIONS, PAGE_BYTES, ROOT_BYTES } }
