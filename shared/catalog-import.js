/** Offline JSON/CSV preflight. Invalid rows are reported, never silently published as a partial bank. */
const domain = require('./question-domain.js')
const examDomain = require('./exam-catalog-domain.js')
const { sourcesFor } = require('./workflow-domain.js')
const REQUIRED = ['id', 'subjectKey', 'subject', 'chapterKey', 'chapter', 'type', 'stem', 'options', 'answer',
  'sourceKind', 'sourceTitle', 'sourceReference', 'sourcePermission', 'sourceAttribution']
const OPTIONAL = ['level', 'explain', 'pitfall', 'keyPoint', 'tags', 'sourceGenerator', 'examId', 'examName']
const fail = (code, row = 0, field = 'input') => { throw Object.assign(new Error(code), { code, row, field }) }
function csvRecords(input) {
  const records = [], cells = []
  let value = '', quoted = false, closed = false, line = 1, start = 1
  const cell = () => { cells.push(value); value = ''; closed = false }
  const record = () => { cell(); if (cells.some(v => v !== '')) records.push({ row: start, cells: cells.splice(0) }); else cells.length = 0; start = line + 1 }
  for (let i = 0; i < input.length; i++) {
    const c = input[i]
    if (quoted) {
      if (c === '"') { if (input[i + 1] === '"') { value += '"'; i++ } else { quoted = false; closed = true } }
      else if (c === '\r' || c === '\n') { if (c === '\r' && input[i + 1] === '\n') i++; value += '\n'; line++ }
      else value += c
    } else if (c === ',') cell()
    else if (c === '\r' || c === '\n') { if (c === '\r' && input[i + 1] === '\n') i++; record(); line++ }
    else if (c === '"' && value === '' && !closed) quoted = true
    else { if (c === '"' || closed) fail('CSV_SYNTAX', line); value += c }
    if (records.length > 501) fail('TOO_MANY_ROWS', line)
  }
  if (quoted) fail('CSV_SYNTAX', start)
  if (value !== '' || cells.length || closed) record()
  return records
}
function csvRows(text) {
  const records = csvRecords(text), header = records.shift()
  if (!header) fail('CSV_HEADER_REQUIRED')
  const names = header.cells.map(v => v.trim())
  if (new Set(names).size !== names.length || REQUIRED.some(k => !names.includes(k)) || names.some(k => !REQUIRED.includes(k) && !OPTIONAL.includes(k))) fail('BAD_CSV_HEADER', header.row)
  if (names.includes('examId') !== names.includes('examName')) fail('BAD_CSV_HEADER', header.row)
  return records.map(record => {
    if (record.cells.length !== names.length) return { row: record.row, error: { code: 'CSV_COLUMN_COUNT', field: 'input' } }
    const raw = Object.fromEntries(names.map((name, i) => [name, record.cells[i]]))
    const json = (field, fallback) => {
      if (!raw[field] && fallback !== undefined) return fallback
      try { return JSON.parse(raw[field]) } catch (e) { fail('BAD_JSON_CELL', record.row, field) }
    }
    try {
      return { row: record.row, subjectKey: raw.subjectKey, chapterKey: raw.chapterKey,
        ...(names.includes('examId') ? { examId: raw.examId, examName: raw.examName } : {}),
        question: { id: raw.id, subject: raw.subject, chapter: raw.chapter, type: raw.type, stem: raw.stem,
          options: json('options'), answer: json('answer'), tags: json('tags', []),
          ...(raw.level ? { level: Number(raw.level) } : {}), ...Object.fromEntries(['explain', 'pitfall', 'keyPoint'].filter(k => raw[k] !== undefined).map(k => [k, raw[k]])) },
        source: { kind: raw.sourceKind, title: raw.sourceTitle, reference: raw.sourceReference, permission: raw.sourcePermission,
          attribution: raw.sourceAttribution, ...(raw.sourceGenerator ? { generator: raw.sourceGenerator } : {}) } }
    } catch (e) { return { row: record.row, error: { code: e.code, field: e.field } } }
  })
}
function jsonRows(text) {
  let parsed
  try { parsed = JSON.parse(text) } catch (e) { fail('BAD_JSON') }
  const bank = parsed && (parsed.bank || parsed), sources = parsed && parsed.sources
  if (!bank || !bank.manifest || !Array.isArray(bank.manifest.subjects) || !bank.questions || !sources || typeof sources !== 'object' || Array.isArray(sources)) fail('BAD_IMPORT_SCHEMA')
  const isExam = bank.schemaVersion === 3 || bank.manifest.exams !== undefined || bank.manifest.subjects.some(s => s && s.examId !== undefined)
  if (isExam && (bank.schemaVersion !== 3 || !Array.isArray(bank.manifest.exams))) fail('BAD_EXAM_CATALOG')
  const rows = [], subjectKeys = new Set(), subjectNames = new Set()
  for (const s of bank.manifest.subjects) {
    const scopedName = isExam ? JSON.stringify([s && s.examId, s && s.name]) : s && s.name
    if (!s || !Array.isArray(s.chapters) || subjectKeys.has(s.key) || subjectNames.has(scopedName) || !Array.isArray(bank.questions[s.key])) fail('BAD_MANIFEST', 0, 'manifest')
    subjectKeys.add(s.key); subjectNames.add(scopedName)
    for (const q of bank.questions[s.key]) rows.push({ row: rows.length + 1, subjectKey: s.key,
      ...(isExam ? { examId: s.examId, examName: (bank.manifest.exams.find(e => e && e.id === s.examId) || {}).name, subjectName: s.name } : {}),
      chapterKey: q && (s.chapters.find(c => c && (c.name === q.chapter || (isExam && (c.key === q.chapter || examDomain.chapterIdentity(s.key, c.key) === q.chapter)))) || {}).key, question: q, source: q && sources[q.id],
      ...(q && q.subject !== s.name && (!isExam || q.subject !== s.key) ? { error: { code: 'BAD_QUESTION_SCOPE', field: 'subject' } } : {}) })
  }
  if (Object.keys(bank.questions).some(k => !subjectKeys.has(k)) || Object.keys(sources).some(k => !rows.some(r => r.question && r.question.id === k))) fail('BAD_IMPORT_SCHEMA')
  // Validate even unused manifest entries; imported content cannot silently hide an invalid chapter.
  try {
    const empty = Object.fromEntries(bank.manifest.subjects.map(s => [s.key, []]))
    if (isExam) examDomain.buildExamRelease({ schemaVersion: 3, manifest: bank.manifest, questions: empty })
    else domain.buildRelease({ manifest: bank.manifest, questions: empty })
  }
  catch (e) { fail(e.code || 'BAD_MANIFEST', 0, 'manifest') }
  return { rows, manifest: bank.manifest, isExam }
}
function preflight(input, format) {
  const errors = [], add = (row, field, code) => errors.push({ row, field, code })
  let rows = []
  try {
    if (typeof input !== 'string' || input.length > 2000000 || encodeURIComponent(input).replace(/%[A-F0-9]{2}/g, 'x').length > 2000000) fail('INPUT_TOO_LARGE')
    const text = input.replace(/^\uFEFF/, '')
    if (!['json', 'csv'].includes(format)) fail('BAD_FORMAT')
    const parsed = format === 'csv' ? { rows: csvRows(text) } : jsonRows(text)
    rows = parsed.rows
    if (!rows.length) fail('EMPTY_IMPORT')
    if (rows.length > 500) fail('TOO_MANY_ROWS')
    const isExam = parsed.isExam || rows.some(row => row.examId !== undefined || row.examName !== undefined)
    const subjects = new Map(), names = new Map(), examNames = new Map(), ids = new Set(), questions = {}, sources = {}
    let validCount = 0
    for (const row of rows) {
      if (row.error) { add(row.row, row.error.field, row.error.code); continue }
      const q = row.question
      try {
        const single = domain.buildRelease({ manifest: { subjects: [{ key: row.subjectKey, name: q && q.subject,
          chapters: [{ key: row.chapterKey, name: q && q.chapter }] }] }, questions: { [row.subjectKey]: [q] } })
        const source = sourcesFor(single, { [q.id]: row.source })[q.id]
        if (ids.has(q.id)) fail('DUPLICATE_ID', row.row, 'id')
        const s = subjects.get(row.subjectKey), subjectName = row.subjectName || q.subject
        const nameKey = isExam ? JSON.stringify([row.examId, subjectName]) : subjectName
        if (isExam && (!row.examId || !row.examName || (examNames.has(row.examId) && examNames.get(row.examId) !== row.examName) ||
          Array.from(examNames).some(([id, n]) => id !== row.examId && n === row.examName))) fail('EXAM_CONFLICT', row.row, 'examId')
        if ((s && (s.name !== subjectName || (isExam && s.examId !== row.examId))) || (names.has(nameKey) && names.get(nameKey) !== row.subjectKey)) fail('SUBJECT_CONFLICT', row.row, 'subjectKey')
        if (s && s.chapters.some(c => (c.key === row.chapterKey && c.name !== q.chapter) || (c.name === q.chapter && c.key !== row.chapterKey))) fail('CHAPTER_CONFLICT', row.row, 'chapterKey')
        if (!s) { subjects.set(row.subjectKey, { key: row.subjectKey, name: subjectName, chapters: [], ...(isExam ? { examId: row.examId } : {}) }); questions[row.subjectKey] = []; names.set(nameKey, row.subjectKey) }
        if (isExam) examNames.set(row.examId, row.examName)
        const subject = subjects.get(row.subjectKey)
        if (!subject.chapters.some(c => c.key === row.chapterKey)) subject.chapters.push({ key: row.chapterKey, name: q.chapter })
        ids.add(q.id); questions[row.subjectKey].push(single.questions[row.subjectKey][0]); sources[q.id] = source; validCount++
      } catch (e) { add(row.row, e.field || ({ BAD_ANSWER: 'answer', BAD_OPTIONS: 'options', BAD_SOURCES: 'sources', BAD_MANIFEST: 'manifest' }[e.code] || 'question'), e.code || 'INVALID_ROW') }
    }
    if (errors.length) return { ok: false, total: rows.length, validCount, errors }
    const manifest = parsed.manifest || { subjects: [...subjects.values()], ...(isExam ? { exams: [...examNames].map(([id, name]) => ({ id, name })) } : {}) }
    const complete = Object.fromEntries(manifest.subjects.map(s => [s.key, questions[s.key] || []]))
    const bank = isExam ? examDomain.buildExamRelease({ schemaVersion: 3, manifest, questions: complete }) : domain.buildRelease({ manifest, questions: complete })
    const checked = sourcesFor(bank, sources)
    return { ok: true, total: rows.length, validCount, errors: [], releaseId: bank.releaseId, prepared: { bank, sources: checked } }
  } catch (e) {
    add(e.row || 0, e.field || 'input', e.code || 'INVALID_INPUT')
    return { ok: false, total: rows.length, validCount: 0, errors }
  }
}
module.exports = { preflight }
