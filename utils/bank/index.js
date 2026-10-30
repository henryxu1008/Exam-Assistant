/**
 * utils/bank/index.js
 * 题库加载器（manifest 驱动 + 按科目分片）
 *
 * 题目按科目拆分到 <key>.js 分片文件，科目 / 章节定义集中在 manifest.js。
 * 本模块对外提供与旧 questions.js 完全一致的函数集合，因此 pages / store / analytics / ai
 * 等调用方无需改动。
 *
 * 题目字段见 manifest.js 顶部说明。
 *
 * 后续「题库上云 / 分包」：只需把 loadSubject 里的 require 换成异步拉取（fetch / 分包加载），
 * 其余查询逻辑不动。
 */

const manifest = require('./manifest.js')

const SUBJECT_BY_KEY = {}
const SUBJECT_BY_NAME = {}
manifest.subjects.forEach((s) => {
  SUBJECT_BY_KEY[s.key] = s
  SUBJECT_BY_NAME[s.name] = s
})

const cache = {}
function loadSubject(key) {
  if (cache[key]) return cache[key]
  const mod = require(`./${key}.js`)
  const list = Array.isArray(mod) ? mod : (mod && mod.questions ? mod.questions : [])
  cache[key] = list
  return list
}

function allQuestions() {
  let out = []
  manifest.subjects.forEach((s) => {
    out = out.concat(loadSubject(s.key))
  })
  return out
}

let _index = null
function index() {
  if (_index) return _index
  _index = new Map()
  allQuestions().forEach((q) => _index.set(q.id, q))
  return _index
}

function getAllQuestions() {
  return allQuestions().slice()
}

function findQuestion(id) {
  if (!id) return null
  return index().get(id) || null
}

function getSubjects() {
  // 科目清单由 manifest 驱动；count 仍按真实题目累计
  return manifest.subjects.map((s) => {
    const count = loadSubject(s.key).reduce((n) => n + 1, 0)
    return { name: s.name, count: count }
  })
}

function getChapters(subject) {
  // 章节清单由 manifest 驱动
  if (!subject) {
    const all = []
    manifest.subjects.forEach((s) => s.chapters.forEach((c) => all.push(c.name)))
    return all
  }
  const s = SUBJECT_BY_NAME[subject]
  return s ? s.chapters.map((c) => c.name) : []
}

function getQuestionsByIds(ids) {
  const list = Array.isArray(ids) ? ids : []
  return list.map((id) => findQuestion(id)).filter(Boolean)
}

function filterQuestions(option) {
  const opt = option || {}
  let list = allQuestions().filter((q) => {
    if (opt.subject && q.subject !== opt.subject) return false
    if (opt.chapter && q.chapter !== opt.chapter) return false
    if (opt.type && q.type !== opt.type) return false
    return true
  })
  if (opt.ids && opt.ids.length) {
    const set = {}
    opt.ids.forEach((id) => {
      set[id] = true
    })
    list = list.filter((q) => set[q.id])
  }
  return list
}

function shuffle(list) {
  const arr = list.slice()
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const t = arr[i]
    arr[i] = arr[j]
    arr[j] = t
  }
  return arr
}

const TYPE_MAP = {
  single: '单选题',
  multiple: '多选题',
  judge: '判断题',
  uncertain: '不定项选择',
  fill: '填空题',
  sort: '排序题'
}

function typeName(type) {
  return TYPE_MAP[type] || '单选题'
}

function typeTip(type) {
  return (
    {
      single: '单选题：选择一个最符合题意的选项',
      multiple: '多选题：可同时选择多个选项',
      judge: '判断题：选择「正确」或「错误」',
      uncertain: '不定项选择：正确选项 1 个或多个，需全部选对才得分',
      fill: '填空题：按空位顺序填写，不区分大小写与多余空格',
      sort: '排序题：点击选项依次加入，可上下调整，需排满所有项'
    }[type] || ''
  )
}

function isMultiSelect(type) {
  return type === 'multiple' || type === 'uncertain'
}

function answerPlain(question) {
  if (!question) return ''
  const answer = Array.isArray(question.answer) ? question.answer : []
  if (question.type === 'fill') {
    return answer.map((a) => (Array.isArray(a) ? a[0] : a)).join('、')
  }
  if (question.type === 'sort') {
    return answer.join(' → ')
  }
  if (question.type === 'judge') {
    const opts = question.options || []
    return answer
      .map((k) => {
        const o = opts.filter((x) => x.key === k)[0]
        return o ? o.text : k
      })
      .join('')
  }
  return answer.join('')
}

function normalizeText(v) {
  return String(v === undefined || v === null ? '' : v)
    .replace(/\s+/g, '')
    .toLowerCase()
}

function judge(type, selected, answer) {
  const sel = Array.isArray(selected) ? selected.slice() : []
  const ans = Array.isArray(answer) ? answer.slice() : []

  if (type === 'fill') {
    if (sel.length !== ans.length) return false
    return ans.every((expect, i) => {
      const list = Array.isArray(expect) ? expect : [expect]
      const got = normalizeText(sel[i])
      if (!got) return false
      return list.some((e) => normalizeText(e) === got)
    })
  }

  if (type === 'sort') {
    if (sel.length !== ans.length) return false
    return ans.every((k, i) => String(k) === String(sel[i]))
  }

  return sel.length === ans.length && ans.every((k) => sel.indexOf(k) > -1)
}

const api = {
  getAllQuestions,
  findQuestion,
  getSubjects,
  getChapters,
  getQuestionsByIds,
  filterQuestions,
  shuffle,
  typeName,
  typeTip,
  answerPlain,
  isMultiSelect,
  normalizeText,
  judge,
  TYPE_MAP
}

// 兼容旧代码对 bank.QUESTIONS 的直接引用：保持惰性（不提前加载全部分片）
Object.defineProperty(api, 'QUESTIONS', {
  enumerable: true,
  get() {
    return getAllQuestions()
  }
})

module.exports = api
