/** Portable immutable question/release identities. No storage, cloud or Node dependencies. */
const copy = value => JSON.parse(JSON.stringify(value))
const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
  : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}' : JSON.stringify(value)
// SHA-256 over UTF-8; shared by the mini program and the independently deployed function.
function sha256(text) {
  const bytes = []
  for (const ch of encodeURIComponent(text).match(/%[0-9A-F]{2}|./g) || []) bytes.push(ch[0] === '%' ? parseInt(ch.slice(1), 16) : ch.charCodeAt(0))
  const bits = bytes.length * 8
  bytes.push(128)
  while (bytes.length % 64 !== 56) bytes.push(0)
  for (let i = 7; i >= 0; i--) bytes.push(Math.floor(bits / Math.pow(256, i)) & 255)
  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
  const k = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]
  const rotr = (x, n) => (x >>> n) | (x << (32 - n))
  for (let offset = 0; offset < bytes.length; offset += 64) {
    const w = []
    for (let i = 0; i < 64; i++) {
      const j = offset + i * 4
      if (i < 16) w[i] = (bytes[j] << 24) | (bytes[j + 1] << 16) | (bytes[j + 2] << 8) | bytes[j + 3]
      else { const a = w[i - 15], b = w[i - 2]; w[i] = (w[i - 16] + (rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)) + w[i - 7] + (rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10))) | 0 }
    }
    let [a, b, c, d, e, f, g, z] = h
    for (let i = 0; i < 64; i++) {
      const t = (z + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + k[i] + w[i]) | 0
      const u = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0
      z = g; g = f; f = e; e = (d + t) | 0; d = c; c = b; b = a; a = (t + u) | 0
    }
    ;[a, b, c, d, e, f, g, z].forEach((v, i) => { h[i] = (h[i] + v) | 0 })
  }
  return h.map(n => (n >>> 0).toString(16).padStart(8, '0')).join('')
}
function fail(code) { throw Object.assign(new Error(code), { code }) }
const text = (v, max = 20000) => typeof v === 'string' && v.trim().length > 0 && v.length <= max
const name = v => text(v, 160) && !['__proto__', 'constructor', 'prototype'].includes(v)
const key = v => text(v, 120) && /^[A-Za-z0-9_-]+$/.test(v) && !['__proto__', 'constructor', 'prototype'].includes(v)
function versionQuestion(q) {
  if (!q || !key(q.id) || !name(q.subject) || !name(q.chapter) || !text(q.stem) ||
      !['single', 'multiple', 'judge', 'uncertain', 'fill', 'sort'].includes(q.type)) fail('BAD_QUESTION')
  const out = { id: q.id, subject: q.subject, chapter: q.chapter, type: q.type, stem: q.stem,
    level: q.level === undefined ? 1 : q.level, options: [], answer: copy(q.answer || []) }
  if (![1, 2, 3].includes(out.level) || !Array.isArray(out.answer) || !out.answer.length || out.answer.length > 30) fail('BAD_ANSWER')
  for (const field of ['explain', 'pitfall', 'keyPoint']) {
    if (q[field] !== undefined && (typeof q[field] !== 'string' || q[field].length > 20000)) fail('BAD_QUESTION')
    out[field] = q[field] || ''
  }
  if (q.tags !== undefined && (!Array.isArray(q.tags) || q.tags.length > 30 || !q.tags.every(v => text(v, 160)))) fail('BAD_QUESTION')
  out.tags = copy(q.tags || [])
  if (q.type === 'fill') {
    if (!out.answer.every(a => text(a, 1000) || (Array.isArray(a) && a.length > 0 && a.length <= 20 && a.every(v => text(v, 1000))))) fail('BAD_ANSWER')
  } else {
    if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 30 || !q.options.every(o => o && key(o.key) && text(o.text))) fail('BAD_OPTIONS')
    out.options = q.options.map(o => ({ key: o.key, text: o.text }))
    const keys = new Set(out.options.map(o => o.key))
    if (keys.size !== out.options.length || !out.answer.every(a => typeof a === 'string' && keys.has(a)) || new Set(out.answer).size !== out.answer.length ||
        (['single', 'judge'].includes(q.type) && out.answer.length !== 1) || (q.type === 'sort' && out.answer.length !== keys.size)) fail('BAD_ANSWER')
    if (q.type !== 'sort') out.answer.sort()
  }
  return { ...out, versionId: 'qv_' + sha256(canonical(out)) }
}
function buildRelease(input) {
  if (!input || !input.manifest || !Array.isArray(input.manifest.subjects) || !input.questions || Array.isArray(input.questions)) fail('BAD_BANK')
  const subjects = [], questions = {}, ids = new Set(), names = new Set(), keys = new Set()
  if (input.manifest.subjects.length > 30) fail('BAD_BANK')
  for (const subject of input.manifest.subjects) {
    if (!subject || !key(subject.key) || !name(subject.name) || keys.has(subject.key) || names.has(subject.name) || !Array.isArray(subject.chapters)) fail('BAD_MANIFEST')
    keys.add(subject.key); names.add(subject.name)
    const chapterKeys = new Set(), chapterNames = new Set()
    const chapters = subject.chapters.map(c => {
      if (!c || !key(c.key) || !name(c.name) || chapterKeys.has(c.key) || chapterNames.has(c.name)) fail('BAD_MANIFEST')
      chapterKeys.add(c.key); chapterNames.add(c.name); return { key: c.key, name: c.name }
    })
    if (!Array.isArray(input.questions[subject.key])) fail('BAD_BANK')
    questions[subject.key] = input.questions[subject.key].map(raw => {
      const q = versionQuestion(raw)
      if (q.subject !== subject.name || !chapterNames.has(q.chapter) || ids.has(q.id)) fail('BAD_QUESTION_SCOPE')
      ids.add(q.id); return q
    })
    subjects.push({ key: subject.key, name: subject.name, chapters })
  }
  if (Object.keys(input.questions).some(k => !keys.has(k)) || ids.size > 500) fail('BAD_BANK')
  const bank = { schemaVersion: 2, manifest: { version: 1, subjects }, questions }
  // Leave room below CloudBase's document limit for publication metadata.
  if (encodeURIComponent(canonical(bank)).replace(/%[A-F0-9]{2}/g, 'x').length > 600000) fail('BANK_TOO_LARGE')
  return { ...bank, releaseId: 'qb_' + sha256(canonical(bank)) }
}
function validRelease(bank) {
  try {
    const built = buildRelease(bank)
    return bank.schemaVersion === 2 && bank.releaseId === built.releaseId &&
      canonical(bank.questions) === canonical(built.questions) && canonical(bank.manifest) === canonical(built.manifest)
  } catch (e) { /* swallow: pure validation failure rejects the untrusted release; no I/O occurs. */ return false }
}
function snapshotQuestion(q) {
  const snapshot = versionQuestion(q)
  if (q.versionId !== snapshot.versionId) fail('BAD_QUESTION_VERSION')
  if (q.bankReleaseId !== undefined) {
    if (!/^qb_[a-f0-9]{64}$/.test(q.bankReleaseId)) fail('BAD_RELEASE_ID')
    snapshot.bankReleaseId = q.bankReleaseId
  }
  return snapshot
}
function attemptQuestion(attempt) {
  try {
    const q = snapshotQuestion(attempt.questionSnapshot)
    return q.id === attempt.questionId && q.versionId === attempt.questionVersionId &&
      canonical(q.answer) === canonical(attempt.answer) &&
      (!attempt.projection || (attempt.projection.subject === q.subject && attempt.projection.chapter === q.chapter)) &&
      (q.bankReleaseId || '') === (attempt.bankReleaseId || '') ? q : null
  } catch (e) { /* swallow: missing/invalid historical evidence stays unknown; no current question substitution. */ return null }
}
module.exports = { canonical, sha256, buildRelease, validRelease, versionQuestion, snapshotQuestion, attemptQuestion }
