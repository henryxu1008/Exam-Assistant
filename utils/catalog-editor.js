/** In-memory editing of a complete published catalog; submission is always a separate reviewed draft. */
const legacy = require('../shared/question-domain.js')
const exam = require('../shared/exam-catalog-domain.js')
const paged = require('../shared/paged-catalog-domain.js')
const { sourcesFor } = require('../shared/workflow-domain.js')
const copy = v => JSON.parse(JSON.stringify(v))
const fail = code => { throw Object.assign(new Error(code), { code }) }
const key = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(v) && !['__proto__', 'constructor', 'prototype'].includes(v)
const name = v => typeof v === 'string' && !!v.trim() && v.length <= 160 && !['__proto__', 'constructor', 'prototype'].includes(v)
function openWorkspace(result) {
  if (!result || !Object.prototype.hasOwnProperty.call(result, 'draft')) fail('INVALID_PUBLISHED_DRAFT')
  if (!result.draft) return { bank: { schemaVersion: 3, manifest: { exams: [], subjects: [] }, questions: {} }, sources: {}, basePublication: null }
  const { bank, sources } = result.draft
  if (!(legacy.validRelease(bank) || exam.validExamRelease(bank)) || !result.basePublication || result.basePublication.releaseId !== bank.releaseId ||
      result.basePublication.revision !== result.draft.publicationRevision) fail('INVALID_PUBLISHED_DRAFT')
  const validSources = sourcesFor(bank, sources)
  const questions = copy(bank.questions)
  for (const s of bank.manifest.subjects) questions[s.key].forEach(q => {
    const matches = s.chapters.filter(c => q.chapter === c.name || q.chapter === c.key || q.chapter === exam.chapterIdentity(s.key, c.key))
    if (matches.length !== 1) fail('INVALID_PUBLISHED_DRAFT')
    q.subject = s.key; q.chapter = exam.chapterIdentity(s.key, matches[0].key)
  })
  return { bank: { schemaVersion: 3, manifest: { exams: copy(bank.manifest.exams || []), subjects: copy(bank.manifest.subjects) }, questions },
    sources: copy(validSources), basePublication: copy(result.basePublication) }
}
function change(workspace, action) {
  const w = copy(workspace), m = w.bank.manifest
  const subject = () => { const s = m.subjects.find(item => item.key === action.subjectKey); if (!s) fail('SUBJECT_NOT_FOUND'); return s }
  const getExam = () => { const e = m.exams.find(item => item.id === action.id); if (!e) fail('EXAM_NOT_FOUND'); return e }
  const getChapter = s => { const c = s.chapters.find(item => item.key === action.chapterKey); if (!c) fail('CHAPTER_NOT_FOUND'); return c }
  switch (action.type) {
    case 'addGeneratedQuestions': {
      if (!Array.isArray(action.questions) || action.questions.length < 1 || action.questions.length > 5 || !action.source || action.source.kind !== 'ai_generated') fail('BAD_AI_RESPONSE')
      const normalized = value => value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase()
      const existing = new Set(Object.values(w.bank.questions).flat().map(q => normalized(q.stem)))
      let next = w
      for (const question of action.questions) {
        if (!question || typeof question.stem !== 'string') fail('BAD_AI_RESPONSE')
        const stem = normalized(question.stem)
        if (existing.has(stem)) fail('DUPLICATE_AI_QUESTION')
        existing.add(stem)
        next = change(next, { type: 'saveQuestion', subjectKey: action.subjectKey, chapterKey: action.chapterKey, question, source: action.source })
      }
      return next
    }
    case 'addExam':
      if (!key(action.id) || !name(action.name) || m.exams.some(e => e.id === action.id || e.name === action.name)) fail('BAD_EXAMS')
      m.exams.push({ id: action.id, name: action.name }); break
    case 'renameExam': {
      const e = getExam(); if (!name(action.name) || m.exams.some(x => x.id !== e.id && x.name === action.name)) fail('BAD_EXAMS')
      e.name = action.name; break
    }
    case 'removeExam':
      getExam(); if (m.subjects.some(s => s.examId === action.id)) fail('EXAM_NOT_EMPTY')
      m.exams = m.exams.filter(e => e.id !== action.id); break
    case 'addSubject':
      if (!m.exams.some(e => e.id === action.examId)) fail('EXAM_NOT_FOUND')
      if (!key(action.subjectKey) || !name(action.name) || m.subjects.some(s => s.key === action.subjectKey || (s.examId === action.examId && s.name === action.name))) fail('BAD_MANIFEST')
      m.subjects.push({ key: action.subjectKey, name: action.name, examId: action.examId, chapters: [] }); w.bank.questions[action.subjectKey] = []; break
    case 'assignSubject': {
      const s = subject(); if (!m.exams.some(e => e.id === action.examId)) fail('EXAM_NOT_FOUND')
      if (m.subjects.some(x => x.key !== s.key && x.examId === action.examId && x.name === s.name)) fail('BAD_MANIFEST')
      s.examId = action.examId; break
    }
    case 'renameSubject': {
      const s = subject(); if (!name(action.name) || m.subjects.some(x => x.key !== s.key && x.examId === s.examId && x.name === action.name)) fail('BAD_MANIFEST')
      s.name = action.name; break
    }
    case 'removeSubject': {
      const s = subject(); if (s.chapters.length || w.bank.questions[s.key].length) fail('SUBJECT_NOT_EMPTY')
      m.subjects = m.subjects.filter(x => x.key !== s.key); delete w.bank.questions[s.key]; break
    }
    case 'addChapter': {
      const s = subject(); if (!key(action.chapterKey) || !name(action.name) || s.chapters.some(c => c.key === action.chapterKey || c.name === action.name)) fail('BAD_MANIFEST')
      s.chapters.push({ key: action.chapterKey, name: action.name }); break
    }
    case 'renameChapter': {
      const s = subject(), c = getChapter(s); if (!name(action.name) || s.chapters.some(x => x.key !== c.key && x.name === action.name)) fail('BAD_MANIFEST')
      c.name = action.name; break
    }
    case 'removeChapter': {
      const s = subject(), c = getChapter(s); if (w.bank.questions[s.key].some(q => q.chapter === exam.chapterIdentity(s.key, c.key))) fail('CHAPTER_NOT_EMPTY')
      s.chapters = s.chapters.filter(x => x.key !== c.key); break
    }
    case 'saveQuestion': {
      const s = subject(), c = getChapter(s), input = action.question || {}, existingId = action.existingId
      if (existingId && existingId !== input.id) fail('QUESTION_ID_IMMUTABLE')
      const all = Object.values(w.bank.questions).flat(), existing = all.find(q => q.id === input.id)
      if ((!existingId && existing) || (existingId && !existing)) fail('QUESTION_ID_CONFLICT')
      if (existing && (existing.subject !== s.key || existing.chapter !== exam.chapterIdentity(s.key, c.key))) fail('QUESTION_SCOPE_IMMUTABLE')
      const q = legacy.versionQuestion({ ...existing, ...input, subject: s.key, chapter: exam.chapterIdentity(s.key, c.key) })
      const one = { questions: { [s.key]: [q] } }, source = sourcesFor(one, { [q.id]: action.source })[q.id]
      for (const list of Object.values(w.bank.questions)) { const index = list.findIndex(item => item.id === q.id); if (index >= 0) list.splice(index, 1) }
      w.bank.questions[s.key].push(q); w.sources[q.id] = source; break
    }
    case 'removeQuestion': {
      const s = subject(), index = w.bank.questions[s.key].findIndex(q => q.id === action.id)
      if (index < 0) fail('QUESTION_NOT_FOUND')
      w.bank.questions[s.key].splice(index, 1); delete w.sources[action.id]; break
    }
    default: fail('BAD_EDITOR_ACTION')
  }
  return w
}
function prepare(workspace) {
  if (workspace.bank.schemaVersion === 4) return paged.buildPagedCatalog({ ...workspace.bank, sources: workspace.sources })
  const bank = exam.buildExamRelease(workspace.bank), sources = sourcesFor(bank, workspace.sources)
  return { bank, sources }
}
function validWorkspace(workspace) {
  try {
    const bank = workspace && workspace.bank, m = bank && bank.manifest
    if (!bank || ![3, 4].includes(bank.schemaVersion) || !m || !Array.isArray(m.exams) || !Array.isArray(m.subjects) ||
      !bank.questions || typeof bank.questions !== 'object' || Array.isArray(bank.questions) || !workspace.sources || typeof workspace.sources !== 'object') return false
    const subjects = new Set(), ids = new Set()
    for (const s of m.subjects) {
      if (!s || !key(s.key) || !name(s.name) || subjects.has(s.key) || !Array.isArray(s.chapters) || !Array.isArray(bank.questions[s.key])) return false
      subjects.add(s.key)
      for (const q of bank.questions[s.key]) {
        if (!q || q.subject !== s.key || ids.has(q.id) || !s.chapters.some(c => exam.chapterIdentity(s.key, c.key) === q.chapter)) return false
        legacy.versionQuestion(q); ids.add(q.id)
      }
    }
    if (Object.keys(bank.questions).some(k => !subjects.has(k))) return false
    if (bank.schemaVersion === 3) sourcesFor(bank, workspace.sources)
    else {
      if (ids.size > paged.limits.MAX_QUESTIONS || Object.keys(workspace.sources).length !== ids.size) return false
      for (const rows of Object.values(bank.questions)) for (const q of rows) sourcesFor({ questions: { page: [q] } }, { [q.id]: workspace.sources[q.id] })
    }
    return true
  } catch (e) { return false }
}
module.exports = { openWorkspace, change, prepare, validWorkspace }
