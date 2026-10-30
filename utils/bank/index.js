/**
 * utils/bank/index.js
 * 题库加载器（manifest 驱动 + 按科目分片）
 *
 * 题目按科目拆分到 <key>.js 分片文件，科目 / 章节定义集中在 manifest.js。
 * 本模块对外提供与旧 questions.js 完全一致的函数集合，因此 pages / store / analytics / ai
 * 等调用方无需改动。
 *
 * 题库上云（动态更新题目、不发版）：
 *  - 默认数据源来自静态 manifest + 分片（离线 / 控制台未配置时的兜底）。
 *  - 启动后由 app.js 调用 loadCloudBank() 从 bankSync 拉取云端题库，整体替换 source。
 *  - pushStaticBankToCloud() 在云端为空时把内置静态题库种入云端（仅一次，受 seed 标记保护）。
 *  - 拉到的云端题库会缓存到本地存储，下次启动即使断网也用得上一次云端版本。
 *  - 所有查询函数只读 `source`，因此切换数据源对外完全透明。
 *
 * 题目字段见 manifest.js 顶部说明。
 */

const manifest = require('./manifest.js')
const config = require('../config.js')

const cache = {}
function loadSubject(key) {
  if (cache[key]) return cache[key]
  const mod = require(`./${key}.js`)
  const list = Array.isArray(mod) ? mod : (mod && mod.questions ? mod.questions : [])
  cache[key] = list
  return list
}

/** 由静态 manifest + 分片组装一个完整数据源对象（与云端结构一致） */
function buildStaticSource() {
  const questions = {}
  manifest.subjects.forEach((s) => {
    questions[s.key] = loadSubject(s.key)
  })
  return { manifest: manifest, questions: questions }
}

// 当前数据源：先尝试用上一次缓存的云端题库，否则用静态兜底
let source = buildStaticSource()

const CLOUD_BANK_KEY = 'exam_quiz_bank_cloud_v1'
function loadPersistedCloudBank() {
  try {
    const raw = wx.getStorageSync(CLOUD_BANK_KEY)
    if (raw && raw.manifest && raw.questions) return raw
  } catch (e) {
    /* ignore */
  }
  return null
}
if (typeof wx !== 'undefined') {
  const persisted = loadPersistedCloudBank()
  if (persisted) source = persisted
}

let _index = null
function index() {
  if (_index) return _index
  _index = new Map()
  allQuestions().forEach((q) => _index.set(q.id, q))
  return _index
}

function allQuestions() {
  let out = []
  source.manifest.subjects.forEach((s) => {
    out = out.concat(source.questions[s.key] || [])
  })
  return out
}

function findQuestion(id) {
  if (!id) return null
  return index().get(id) || null
}

function getAllQuestions() {
  return allQuestions().slice()
}

function getSubjects() {
  // 科目清单由 dataSource 驱动；count 按真实题目累计
  return source.manifest.subjects.map((s) => ({
    name: s.name,
    count: (source.questions[s.key] || []).length
  }))
}

function getChapters(subject) {
  // 章节清单由 dataSource 驱动
  if (!subject) {
    const all = []
    source.manifest.subjects.forEach((s) => s.chapters.forEach((c) => all.push(c.name)))
    return all
  }
  const s = source.manifest.subjects.filter((x) => x.name === subject)[0]
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

/** 用云端题库整体替换数据源（结构须为 {manifest, questions}）；成功返回 true */
function swapSource(bank) {
  if (!bank || !bank.manifest || !bank.questions) return false
  source = bank
  _index = null
  try {
    wx.setStorageSync(CLOUD_BANK_KEY, bank)
  } catch (e) {
    /* ignore */
  }
  return true
}

function hasCloud() {
  // 仅在云已初始化后才调用云 API，避免 "Cloud API isn't enabled"；
  // 同时兼容无 wx 的运行环境（如部分测试）
  if (typeof wx === 'undefined' || !wx.__cloudReady) return false
  return !!wx.cloud && typeof wx.cloud.callFunction === 'function'
}

/** 从云端拉取题库并整体替换数据源；无云/失败时保持现有数据源 */
async function loadCloudBank() {
  if (!hasCloud()) return false
  try {
    const res = await wx.cloud.callFunction({ name: config.functions.bankSync, data: { action: 'get' } })
    const r = res && res.result
    if (r && r.ok && r.bank) return swapSource(r.bank)
  } catch (e) {
    /* ignore */
  }
  return false
}

/** 一次性把内置静态题库种入云端（仅当云端为空）；受本地 seed 标记保护，不会反复覆盖 */
const SEED_FLAG_KEY = 'exam_quiz_bank_seeded_v1'
async function pushStaticBankToCloud() {
  if (!hasCloud()) return false
  try {
    if (wx.getStorageSync(SEED_FLAG_KEY)) return false
    const res = await wx.cloud.callFunction({ name: config.functions.bankSync, data: { action: 'get' } })
    const r = res && res.result
    if (r && r.ok && r.bank) {
      wx.setStorageSync(SEED_FLAG_KEY, 1) // 云端已存在，标记已种
      return false
    }
    const staticBank = buildStaticSource()
    await wx.cloud.callFunction({ name: config.functions.bankSync, data: { action: 'set', bank: staticBank } })
    wx.setStorageSync(SEED_FLAG_KEY, 1)
    return true
  } catch (e) {
    return false
  }
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
  TYPE_MAP,
  loadCloudBank,
  pushStaticBankToCloud
}

// 兼容旧代码对 bank.QUESTIONS 的直接引用：保持惰性（不提前加载全部分片）
Object.defineProperty(api, 'QUESTIONS', {
  enumerable: true,
  get() {
    return getAllQuestions()
  }
})

module.exports = api
