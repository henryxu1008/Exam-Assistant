/**
 * utils/store.js
 * 本地数据仓储：答题记录 / 每日统计 / 学习设置 / AI 对话历史
 * 领域状态与同步；本地读写由 local-repository.js 提供用户隔离检查点。
 */

const bank = require('./questions.js')
const config = require('./config.js')
const attemptOutbox = require('./attempt-outbox.js')
const grading = require('../shared/grading-domain.js')
const { createLocalRepository } = require('./local-repository.js')
const localStorageListeners = new Set()
function effectiveLocalStatus(status) {
  return { ...status, ...(scopeMigrationError ? { state: 'read_error', readError: 'LOCAL_LEGACY_MIGRATION_FAILED', error: 'LOCAL_LEGACY_MIGRATION_FAILED' } : {}) }
}
function notifyLocalStatus(status) {
  const effective = effectiveLocalStatus(status)
  localStorageListeners.forEach(listener => { try { listener(effective) } catch (e) { /* UI observers cannot affect storage. */ } })
}
const localRepository = createLocalRepository({
  getStorageSync: key => wx.getStorageSync(key),
  setStorageSync: (key, value) => wx.setStorageSync(key, value),
  removeStorageSync: key => wx.removeStorageSync(key),
  getStorageInfoSync: () => { if (typeof wx.getStorageInfoSync !== 'function') throw new Error('LOCAL_INVENTORY_UNAVAILABLE'); return wx.getStorageInfoSync() }
}, (scope, status) => {
  if (scope !== userScope) return
  notifyLocalStatus(status)
})
const { createSyncCoordinator } = require('./sync-coordinator.js')
const attemptDomain = require('../shared/attempt-domain.js')

/**
 * 档案合并逻辑与云端 studySync 共用同一份实现（shared/stats-merge.js），
 * 避免端上与云端的合并语义漂移。
 */
const { CURRENT_VERSION, getDefaultState, mergeStats, bumpVersion, counterBy, sumCounter,
  recordCountsBy, sumRecordCounts, recomputeSessionStats, nextFieldVersion,
  recordFieldVersions, advanceRecordFields, settingsFieldVersions } = require('../shared/stats-merge.js')

const STORAGE_KEY = 'exam_quiz_data_v1'

/** 登录会话存储键，与 utils/user.js 保持一致（避免 require user 造成循环依赖） */
const SESSION_KEY = 'exam_quiz_session_v1'

/** 旧版本数组游标仅在清理作用域时删除，不再作为上传进度。 */
const LEGACY_ATTEMPT_CURSOR_KEY = 'exam_quiz_attempt_cursor_v1'

/**
 * 迁移函数表：MIGRATIONS[n] 负责把版本 n 的数据升级到 n + 1
 * 约定：提升 CURRENT_VERSION 前必须先补对应的迁移函数，否则等于清空用户数据
 */
const MIGRATIONS = {
  // v1 -> v2：日统计增加科目维度。历史作答无从反推当天各科目分布，
  // 迁移后各科目当天的统计为 0，此后正常累计
  1: (data) => {
    const daily = {}
    Object.keys(data.daily || {}).forEach((key) => {
      const d = data.daily[key]
      daily[key] = d ? Object.assign({}, d, { subjects: {} }) : d
    })
    return Object.assign({}, data, { daily: daily, version: 2 })
  },
  // v2 -> v3：引入 AnswerAttempt 不可变作答日志与练习 Session 状态机（Issue 2/3）。
  // 旧聚合记录（records）保留为派生来源；不可变流水无法由聚合反推，不伪造历史。
  2: (data) => {
    const next = Object.assign({}, data)
    if (!Array.isArray(next.attempts)) next.attempts = []
    if (!next.practiceSession) next.practiceSession = null
    next.version = 3
    return next
  }
}

/** 生成带前缀的唯一 ID（会话 / 作答 / 客户端操作） */
/**
 * 本设备的「写入者标识」，用于给 daily 计数器分区（评审 P2 4429855405）。
 *
 * 必须存在独立的本地 key、且**不参与同步**：若它跟着档案一起同步，
 * 两台设备会共用同一个标识，分区就退化成单一写入者，又回到 max 的老问题。
 */
const WRITER_KEY = 'exam_quiz_writer_v1'

let writerId = null

function getWriterId() {
  if (writerId) return writerId
  try {
    writerId = wx.getStorageSync(WRITER_KEY)
    if (typeof writerId !== 'string' || !writerId) {
      writerId = newId('w')
      wx.setStorageSync(WRITER_KEY, writerId)
    }
  } catch (e) {
    writerId = newId('w')
  }
  return writerId
}

/**
 * 计数器累加：只写分区明细，聚合值由分区求和重算。
 *
 * 先 counterBy() 归一化的原因：老数据没有 by，直接用空 by 累加
 * 会把已有的聚合值当作 0 丢掉。归一化后老值归入 legacy 写入者，再叠加新贡献。
 *
 * @param {Object} node 计数器节点（会被就地修改）
 * @param {Boolean} isCorrect 本题是否答对
 * @param {Number} costMs 本题耗时
 */
function bumpCounter(node, isCorrect, costMs) {
  node.by = counterBy(node)
  const wid = getWriterId()
  const mine = node.by[wid] || { total: 0, correct: 0, timeMs: 0 }
  mine.total += 1
  if (isCorrect) mine.correct += 1
  mine.timeMs += costMs || 0
  node.by[wid] = mine
  return sumCounter(node)
}

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/** 掌握等级对应的复习间隔（天），艾宾浩斯式简化版 */
const REVIEW_INTERVALS = [0, 1, 2, 4, 7, 15]

/** 连续答对该天数后，自动移出错题本 */
const MASTER_DAYS = 3

const DAY = 24 * 60 * 60 * 1000

let state = null

/**
 * 用户隔离作用域：本地数据按 openid 命名空间存储，避免账号 A 登出、账号 B 登录后
 * 读取到 A 的答题记录 / AI 对话（Issue 1）。未登录或无法获取 openid 时回落 'anon'。
 * 切换账号必须调用 setUserScope 重置内存态并切到对应 key。
 */
let userScope = 'anon'
let scopeMigrationError = null

/**
 * 云端同步代次：切换作用域或清空数据即递增（A→B→A 也算新代次，不能只比较 openid）。
 * 云端请求发起后代次 / 作用域 / 令牌任一变化，回包一律丢弃，
 * 避免把账号 A 的档案并入账号 B 的内存态并随之上传（评审 P1）。
 */
let cloudSyncGeneration = 0

// 页面持有的练习上下文必须与当前会话一致；替换后即使会话 ID 回到原值也不能复用。
let practiceGeneration = 0
const practiceRestoredListeners = new Set()

function getPracticeContext() {
  const session = load().practiceSession
  return { scope: userScope, generation: practiceGeneration, syncGeneration: cloudSyncGeneration, sessionId: session && session.id }
}

function isPracticeContextCurrent(context) {
  const session = load().practiceSession
  return !!context && context.scope === userScope && context.generation === practiceGeneration &&
    context.syncGeneration === cloudSyncGeneration && !!session && context.sessionId === session.id
}

function onPracticeRestored(listener) {
  practiceRestoredListeners.add(listener)
  return () => practiceRestoredListeners.delete(listener)
}

// 当前进程内的对话代次：账号切换或删除历史即递增，阻止缓存页面和旧异步回复复用。
// 不随普通消息追加变化；A→B→A 也必须产生新代次，不能只比较 openid。
let aiConversationVersion = 0

function getAiConversationVersion() {
  return aiConversationVersion
}

/** 读取当前隔离作用域（openid 或 'anon'） */
function getUserScope() {
  return userScope
}

/**
 * 切换数据存储作用域（通常在登录成功后用 openid、登出时用 null/'anon' 调用）。
 * 会重置内存态并从新 key 重新加载；首次从旧版全局 key 迁移数据（仅一次，避免丢数据）。
 */
function setUserScope(openid) {
  const next = openid && String(openid).length ? String(openid) : 'anon'
  if (next === userScope) return userScope // 同作用域不重置内存态、不重复迁移
  // 切换前先把当前作用域的待落盘数据同步写入，避免节流定时器在 state 置空后丢失
  // （评审 P2：Flush pending changes before switching user scopes）
  if (state) {
    try {
      localRepository.write(userScope, state)
    } catch (e) {
      /* 忽略写入失败 */
    }
    pushToCloud() // 切换账号前把旧账号的学习档案上传云端
  }
  localRepository.release(userScope)
  userScope = next
  scopeMigrationError = null
  state = null
  aiConversationVersion += 1
  // 作用域已变，作废所有在途云端请求（其回包属于旧账号）
  cloudSyncGeneration += 1
  // 切换到真实账号后，允许下次 load 再次从云端拉取该账号的档案
  if (next !== 'anon') bootPulled = false
  // 一次性迁移：旧版用全局单一 key，升级后首次进入该作用域时把全局数据搬过来，
  // 再删除旧 key；多账号同设备时首个登录用户承接历史数据（与升级前单租户行为一致）。
  const legacy = STORAGE_KEY
  if (userScope !== 'anon') {
    try {
      const rawLegacy = wx.getStorageSync(legacy)
      const rawScoped = localRepository.read(userScope)
      if (rawLegacy && typeof rawLegacy === 'object' && (!rawScoped || rawScoped === '')) {
        try { localRepository.write(userScope, rawLegacy) } catch (e) {
          scopeMigrationError = e.code || 'LOCAL_LEGACY_MIGRATION_FAILED'
          notifyLocalStatus(localRepository.status(userScope))
          throw e
        }
        wx.removeStorageSync(legacy)
      } else if (rawLegacy && typeof rawLegacy === 'object') {
        wx.removeStorageSync(legacy)
      }
    } catch (e) {
      /* 迁移失败不影响新会话 */
    }
  }
  return userScope
}

/** 获取今日日期 key */
function todayKey(date) {
  const d = date || new Date()
  const y = d.getFullYear()
  const m = `${d.getMonth() + 1}`.padStart(2, '0')
  const day = `${d.getDate()}`.padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 取 yyyy-mm-dd 的月日形式 */
function shortDate(key) {
  if (!key) return ''
  const parts = String(key).split('-')
  return parts.length === 3 ? `${parts[1]}-${parts[2]}` : key
}

/** 日期 key 转时间戳（按本地时区解析，避免 UTC 偏移） */
function toTime(key) {
  const p = String(key || '').split('-')
  if (p.length !== 3) return NaN
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])).getTime()
}

/** 两个日期 key 相差天数（b - a） */
function dayDiff(a, b) {
  const ta = toTime(a)
  const tb = toTime(b)
  if (isNaN(ta) || isNaN(tb)) return NaN
  return Math.round((tb - ta) / DAY)
}

/** 把今日并入「连续答对天」序列：同日不变、相邻日累加、中断则重置 */
function nextRightDays(days, key) {
  const list = (Array.isArray(days) ? days : []).slice(-MASTER_DAYS)
  const last = list[list.length - 1]
  if (last === key) return list
  if (last && dayDiff(last, key) === 1) return list.concat([key]).slice(-MASTER_DAYS)
  return [key]
}

/**
 * 按版本链升级本地数据，无法升级到当前版本时返回 null（由调用方回落默认状态）
 * 约定：提升 CURRENT_VERSION 前必须先补上对应的迁移函数，否则等于清空用户数据
 */
function migrate(raw) {
  let data = raw
  let v = Number(data && data.version) || 0
  while (v < CURRENT_VERSION && MIGRATIONS[v]) {
    data = MIGRATIONS[v](data)
    v += 1
  }
  return v === CURRENT_VERSION ? data : null
}

function load(options = {}) {
  if (scopeMigrationError) throw Object.assign(new Error('LOCAL_LEGACY_MIGRATION_FAILED'), { code: 'LOCAL_LEGACY_MIGRATION_FAILED' })
  if (state) return state
  try {
    const raw = localRepository.read(userScope)
    state = migrate(raw) || getDefaultState()
  } catch (e) {
    state = null
    throw e // An unreadable checkpoint is not an empty account and must never be overwritten.
  }
  if (!state.records) state.records = {}
  if (!state.daily) state.daily = {}
  if (!state.settings) state.settings = getDefaultState().settings
  if (!Array.isArray(state.aiMessages)) state.aiMessages = []
  if (!Array.isArray(state.attempts)) state.attempts = []
  const deletion = userScope !== 'anon' && getDeleteOperation(userScope)
  if (deletion && deletion.localResetId && state.pendingDeleteId !== deletion.localResetId) {
    // 删除意图已提交、清空快照尚未落盘就退出时，旧档案不得带入新云端代次。
    state = getDefaultState()
    state.dataEpoch = deletion.dataEpoch
    state.pendingDeleteId = deletion.localResetId
    aiConversationVersion += 1
    cloudSyncGeneration += 1
    dirty = true
  }
  try {
    const migrated = attemptOutbox.ensure(state)
    if (migrated && attemptOutbox.pending(state).length) {
      dirty = true
      localRepository.write(userScope, state)
    }
  } catch (e) { dirty = true } // 保留原档案；持久化/队列异常时禁止发送。
  // 启动时恢复一次；之后由登录、前台和网络事件通过协调器继续增量恢复。
  if (!options.localOnly) {
    if (isLogged() && getPendingDelete(userScope)) deleteCloud()
    else if (isLogged() && (state.aiClearQueue || []).length) clearAiFromCloud()
    else if (!bootPulled && isLogged()) pullFromCloud()
  }
  return state
}

/** 写盘节流窗口（毫秒）：连续作答时合并为至多每窗口一次 */
const FLUSH_INTERVAL = 800

let flushTimer = null
let lastFlushAt = 0
let dirty = false

/** 立即同步落盘，与作答/确认检查点严格排序；其他修改仍由 persist 节流。 */
function flush() {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  // 待重试的云端删除：先补发，成功后再放行上传。
  // 离线清空后恢复网络时，靠这里把删除意图真正推到服务端（评审 P2 4425593448）。
  if (state && hasCloud() && isLogged() && getPendingDelete(userScope)) deleteCloud()
  if (!dirty && state && (state.aiClearQueue || []).length) clearAiFromCloud()
  if (!state) return
  if (!dirty) {
    try { if (attemptOutbox.pending(state).length) pushToCloud() } catch (e) { dirty = true }
    return
  }
  dirty = false
  lastFlushAt = Date.now()
  try {
    attemptOutbox.ensure(state)
    // 与 submitAttempt 的同步检查点使用同一写入顺序，旧异步写不能覆盖新作答。
    localRepository.write(userScope, state)
  } catch (e) {
    dirty = true
    console.error('[store] 持久化失败', e)
    return
  }
  syncPersistedState()
}

/**
 * 取消待落盘的节流定时器。
 * 仅供测试使用：清 require 缓存会让上一个 store 实例的定时器成为孤儿，
 * 它随后触发时会用当前用例的 wx mock 发请求，从而污染断言。
 */
function __clearFlushTimer() {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
}

/* ============================================================
 * 云端同步（MVP）：本地为主、云端备份，换设备可延续学习进度。
 * - 同步派生/聚合数据（records/daily/settings/practiceSession/aiMessages）到 studyStats 单文档。
 * - 同步不可变作答到独立 attempts 集合（文档 ID 按账号/代次隔离），
 *   由持久 outbox 按 ID 发送/确认，重放不能改写已接受的事实。
 * - 双向合并：pull 时与云端按时间戳 / 日期 / id 并集合并（见 mergeStats），多端作答不互丢；
 *   合并结果回写本地并上传云端，最终两端收敛一致。
 * - 测试沙箱无 wx.cloud，hasCloud() 为 false，以下逻辑全部安全跳过。
 * ============================================================ */

function hasCloud() {
  // 仅在 wx.cloud 存在、callFunction 可用且已完成 wx.cloud.init() 时才视为可调用，
  // 避免在小程序端 init 之前误触发云端调用而报 "Cloud API isn't enabled"。
  return !!wx.__cloudReady && !!wx.cloud && typeof wx.cloud.callFunction === 'function'
}

/**
 * 调用云函数并以回调方式处理结果。
 * wx.cloud.callFunction 在支持回调的同时还会返回一个 Promise；我们只用回调消费结果，
 * 若不处理该 Promise 的拒绝，会产生「未处理的 Promise 拒绝」——真实运行可能崩溃，
 * 测试中会被判定为用例失败。这里统一吞掉拒绝（失败已由 fail 回调处理）。
 */
function callCloud(opts) {
  const p = wx.cloud.callFunction(opts)
  if (p && typeof p.then === 'function') p.then(null, () => {})
  return p
}

function getToken() {
  try {
    const s = wx.getStorageSync(SESSION_KEY)
    return (s && s.token) || ''
  } catch (e) {
    return ''
  }
}

/** 当前会话绑定的 openid；未登录或会话已清空时返回 '' */
function getSessionOpenid() {
  try {
    const s = wx.getStorageSync(SESSION_KEY)
    return (s && s.openid) || ''
  } catch (e) {
    return ''
  }
}

function isLogged() {
  try {
    const s = wx.getStorageSync(SESSION_KEY)
    return !!(s && s.logged && s.token)
  } catch (e) {
    return false
  }
}

/** 默认启动拉取只执行一次；协调器可强制发起后续恢复。 */
let bootPulled = false

/** 首次上云也要备份本地有效数据；创建时间和未修改的默认设置不算历史。 */
function hasLocalSyncData(snapshot) {
  const s = snapshot || {}
  if (Object.keys(s.records || {}).length || Object.keys(s.daily || {}).length ||
    (s.attempts || []).length || (s.aiMessages || []).length || s.practiceSession || Number(s.aiEpoch || 0) > 0) return true
  if (Object.keys(s.settingsVersions || {}).some((field) => Number(s.settingsVersions[field]) > 0)) return true
  const defaults = getDefaultState().settings
  return Object.keys(s.settings || {}).some((field) => s.settings[field] !== defaults[field])
}

/**
 * 捕获当前账号上下文快照。
 *
 * 云端请求与它的完成回调之间可能隔着一次账号切换 / 登出 / 清空数据。
 * 回调里若直接读当前全局 userScope，就会把 A 的结果写到 B 名下。
 * 因此所有云端调用统一：发起时 capture，回包时先 isStaleContext 再落地。
 *
 * @returns {{gen: Number, scope: String, token: String}}
 */
function captureSyncContext() {
  return { gen: cloudSyncGeneration, scope: userScope, token: getToken(), dataEpoch: Number(state && state.dataEpoch || 0), aiEpoch: Number(state && state.aiEpoch || 0) }
}

/**
 * 判断回包是否已过期（发起环境不再有效）。
 * 代次覆盖 A→B→A，作用域覆盖切号，令牌覆盖登出 / 重登换新令牌。
 * @param {{gen: Number, scope: String, token: String}} ctx
 * @returns {Boolean}
 */
function isStaleContext(ctx) {
  return ctx.gen !== cloudSyncGeneration || ctx.scope !== userScope || getToken() !== ctx.token
}

/**
 * 初次按修订号校验全量基线，之后按服务端序号拉取新增事实。
 * 任一页失败、上下文失效或检查点写盘失败均不发布半批数据/游标。
 * force 绕过启动一次性标记；同一有效上下文的并发拉取共享 Promise。
 * @param {Function} [onDone] 成功落盘后回调 true，否则 false
 * @param {Object} [options] {force: Boolean}
 * @returns {Promise<Boolean>}
 */
let activePull = null
const syncRestoredListeners = new Set()

function onSyncRestored(listener) {
  syncRestoredListeners.add(listener)
  return () => syncRestoredListeners.delete(listener)
}

function savedCursor(snapshot) {
  const c = snapshot && snapshot.syncCursor
  return c && c.version === 2 && c.dataEpoch === Number(snapshot.dataEpoch || 0) &&
    Number.isSafeInteger(c.sequence) && c.sequence >= 0 && Number.isSafeInteger(c.generation) && c.generation >= 0
    ? { dataEpoch: c.dataEpoch, sequence: c.sequence, generation: c.generation } : null
}

function pullFromCloud(onDone, options = {}) {
  if (!hasCloud() || !isLogged()) return Promise.resolve(false)
  if (!state) load()
  if (getSessionOpenid() !== userScope) return Promise.resolve(false)
  if (getPendingDelete(userScope)) {
    deleteCloud()
    if (typeof onDone === 'function') onDone(false)
    return Promise.resolve(false)
  }
  if ((state.aiClearQueue || []).length) {
    clearAiFromCloud()
    if (typeof onDone === 'function') onDone(false)
    return Promise.resolve(false)
  }
  const ctx = captureSyncContext()
  const conversationVersion = aiConversationVersion
  if (activePull && !isStaleContext(activePull.ctx) && activePull.conversationVersion === conversationVersion) {
    if (typeof onDone === 'function') activePull.promise.then(onDone)
    return activePull.promise
  }
  if (bootPulled && !options.force) return Promise.resolve(true)
  let resolveRun
  const run = { ctx, conversationVersion, promise: new Promise(resolve => { resolveRun = resolve }) }
  activePull = run
  bootPulled = true
  let cursor = savedCursor(state)
  let afterSequence = cursor ? cursor.sequence : 0
  let skip = 0
  let stats = null
  let dataEpoch = null
  let syncRevision
  let aiEpoch
  let protocol = null
  let checkpoint = null
  let resetTried = false
  let pages = 0
  let completed = false
  const allAttempts = []
  const current = () => !isStaleContext(ctx) && conversationVersion === aiConversationVersion
  const done = ok => {
    if (completed) return
    completed = true
    if (activePull === run) { activePull = null; bootPulled = ok }
    resolveRun(ok)
    if (typeof onDone === 'function') onDone(ok)
  }
  const finish = () => {
    if (!current()) { done(false); return }
    const before = state
    if (dataEpoch < Number(before.dataEpoch || 0)) { done(false); return }
    const reset = dataEpoch > Number(before.dataEpoch || 0)
    const base = JSON.parse(JSON.stringify(reset ? getDefaultState() : before))
    try { attemptOutbox.ensure(base) } catch (e) { done(false); return }
    const needsPush = !reset && (dirty || getPendingPush(ctx.scope) || attemptOutbox.pending(base).length ||
      (!cursor && hasLocalSyncData(before)))
    attemptDomain.resolveRestored(base, allAttempts)
    const localOutbox = base.attemptOutbox
    const local = aiEpoch !== undefined && aiEpoch !== Number(base.aiEpoch || 0)
      ? Object.assign({}, base, { aiEpoch, aiMessages: [] }) : base
    const remote = Object.assign({}, stats || {}, { attempts: allAttempts })
    if (aiEpoch !== undefined) remote.aiEpoch = aiEpoch
    const next = mergeStats(local, remote)
    next.attemptOutbox = localOutbox
    next.dataEpoch = dataEpoch
    if (checkpoint) next.syncCursor = { version: 2, ...checkpoint }
    else delete next.syncCursor // 旧服务端只作全量恢复，不能凭猜测推进增量游标。
    try { localRepository.write(userScope, next) } catch (e) { done(false); return }
    state = next
    dirty = false
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
    const practiceChanged = reset || JSON.stringify(before.practiceSession) !== JSON.stringify(next.practiceSession)
    if (reset) { cloudSyncGeneration += 1; setPendingPush(ctx.scope, false) }
    if (practiceChanged) practiceGeneration += 1
    if (reset || JSON.stringify(before.aiMessages || []) + '|' + Number(before.aiEpoch || 0) !==
      JSON.stringify(next.aiMessages || []) + '|' + Number(next.aiEpoch || 0)) aiConversationVersion += 1
    // 拉取写盘与上传分开：增量恢复不能制造无意义的快照回声和新修订。
    if (needsPush) syncPersistedState()
    if (practiceChanged) practiceRestoredListeners.forEach(listener => {
      try { listener() } catch (e) { console.error('[store] 练习恢复通知失败', e) }
    })
    const visibleFields = ['records', 'daily', 'settings', 'settingsVersions', 'practiceSession', 'aiMessages', 'aiEpoch', 'dataEpoch']
    const changed = visibleFields.some(field => JSON.stringify(before[field]) !== JSON.stringify(next[field]))
    if (changed) syncRestoredListeners.forEach(listener => {
      try { listener() } catch (e) { console.error('[store] 同步恢复通知失败', e) }
    })
    done(true)
  }
  const fetchPage = () => {
    if (!current() || ++pages > 1000) { done(false); return }
    const data = { token: ctx.token, action: 'get', syncProtocol: 2, skip,
      ...(cursor ? { cursor, afterSequence } : {}),
      ...(syncRevision === undefined ? {} : { syncRevision, dataEpoch }) }
    try {
      callCloud({ name: config.functions.studySync, data,
        success: res => {
          if (!current()) { done(false); return }
          const r = res && res.result
          if (!r || !r.ok) {
            if (r && r.error === 'CURSOR_RESET_REQUIRED' && cursor && !resetTried) {
              cursor = null; afterSequence = 0; skip = 0; stats = null; dataEpoch = null
              syncRevision = undefined; aiEpoch = undefined; protocol = null; checkpoint = null
              allAttempts.length = 0; resetTried = true
              fetchPage()
            } else done(false)
            return
          }
          const pageEpoch = r.dataEpoch === undefined ? 0 : r.dataEpoch
          if (!Number.isSafeInteger(pageEpoch) || pageEpoch < 0 || !Array.isArray(r.attempts) ||
            (dataEpoch !== null && (dataEpoch !== pageEpoch || syncRevision !== r.syncRevision))) { done(false); return }
          if (r.syncProtocol === 2) {
            const c = r.cursor
            if (protocol === 0 || !Number.isSafeInteger(r.syncRevision) || r.syncRevision < 0 || !c || c.dataEpoch !== pageEpoch || !Number.isSafeInteger(c.sequence) || c.sequence < 0 || !Number.isSafeInteger(c.generation) || c.generation < 0 ||
              r.mode !== (cursor ? 'delta' : 'bootstrap') || (checkpoint && (checkpoint.sequence !== c.sequence || checkpoint.generation !== c.generation))) { done(false); return }
            if (cursor && (!Number.isSafeInteger(r.nextSequence) || r.nextSequence < afterSequence || r.nextSequence > c.sequence ||
              (r.hasMore ? r.nextSequence <= afterSequence : r.nextSequence !== c.sequence))) { done(false); return }
            protocol = 2
            checkpoint = { dataEpoch: c.dataEpoch, sequence: c.sequence, generation: c.generation }
          } else {
            if (protocol === 2 || r.syncProtocol !== undefined) { done(false); return }
            protocol = 0; cursor = null; checkpoint = null
          }
          dataEpoch = pageEpoch
          syncRevision = r.syncRevision
          if (Number.isSafeInteger(r.aiEpoch)) aiEpoch = r.aiEpoch
          else if (r.stats && Number.isSafeInteger(r.stats.aiEpoch)) aiEpoch = r.stats.aiEpoch
          if (r.stats) stats = r.stats
          allAttempts.push(...r.attempts)
          if (!r.hasMore) { finish(); return }
          if (cursor) afterSequence = r.nextSequence
          else {
            const nextSkip = typeof r.nextSkip === 'number' ? r.nextSkip : skip + r.attempts.length
            if (!Number.isSafeInteger(nextSkip) || nextSkip <= skip) { done(false); return }
            skip = nextSkip
          }
          fetchPage()
        },
        fail: () => done(false)
      })
    } catch (e) { done(false) }
  }
  fetchPage()
  return run.promise
}

/** 待重试的云端删除标记（按作用域隔离） */
const PENDING_DELETE_KEY = 'exam_quiz_pending_delete_v1'

function getPendingDelete(scope) {
  try {
    return !!wx.getStorageSync(`${PENDING_DELETE_KEY}__${scope || userScope}`)
  } catch (e) {
    // 标记暂时不可读时禁止恢复/上传，不能把访问失败当成「没有删除意图」。
    return true
  }
}

function setPendingDelete(scope, on, resetLocal = true) {
  const key = `${PENDING_DELETE_KEY}__${scope || userScope}`
  if (on) {
    const existing = wx.getStorageSync(key)
    const operation = existing && typeof existing.deleteId === 'string' && Number.isSafeInteger(existing.dataEpoch)
      ? Object.assign({}, existing) : { deleteId: newId('reset'), dataEpoch: Number(state && state.dataEpoch || 0) }
    // 每次显式清空均先提交本地重置 ID；云端重试仍复用 deleteId。
    if (resetLocal) operation.localResetId = newId('local_reset')
    wx.setStorageSync(key, operation)
    return operation
  }
  try {
    wx.removeStorageSync(key)
    return true
  } catch (e) {
    return false // ACK 清理失败保留标记，后续重试同一操作。
  }
}

function getDeleteOperation(scope, migrateLegacy) {
  try {
    const operation = wx.getStorageSync(`${PENDING_DELETE_KEY}__${scope}`)
    if (operation === true && migrateLegacy) return setPendingDelete(scope, true, false)
    return operation && typeof operation.deleteId === 'string' && Number.isSafeInteger(operation.dataEpoch) ? operation : null
  } catch (e) { return null }
}

/** 待重试的云端上传标记（按作用域隔离） */
const PENDING_PUSH_KEY = 'exam_quiz_pending_push_v1'

function getPendingPush(scope) {
  try {
    return wx.getStorageSync(`${PENDING_PUSH_KEY}__${scope || userScope}`) === true
  } catch (e) {
    return false
  }
}

function setPendingPush(scope, on) {
  try {
    const key = `${PENDING_PUSH_KEY}__${scope || userScope}`
    if (on) wx.setStorageSync(key, true)
    else wx.removeStorageSync(key)
  } catch (e) {
    /* ignore */
  }
}

/**
 * 发起一次云端删除；仅当应用层确认成功后才清除待重试标记。
 *
 * 为什么需要这个标记：update 改成「合并」而非整doc覆盖之后，
 * 本地清空之后上传的空快照删不掉服务端已有的 records / attempts
 * （并集会保留它们）。此时若删除请求失败（例如离线）就把这次意图丢掉，
 * 下次启动拉取会把「已清空」的数据又并回本地——
 * 用户看到被删除的数据复活，比没清空更糟（评审 P2 4425593448）。
 *
 * 因此：标记存在期间不发起上传，每次 flush 重试，直到删除被确认。
 *
 * ctx 必须是**入队时**捕获的那一个，不能在这里重新捕获：
 * 删除请求可能要在队列里等前面的上传，这期间用户完全可能切号（评审 P1 4425820628）。
 */
function deleteCloudRequest(ctx) {
  return new Promise((resolve) => {
    callCloud({
      name: config.functions.studySync,
      // 用发起时的令牌：回包到达前若已登出/换号，这次删除不应以新身份执行
      data: { token: ctx.token, action: 'delete', dataEpoch: ctx.deleteOperation.dataEpoch, deleteId: ctx.deleteOperation.deleteId },
      success: (res) => {
        const r = res && res.result
        // 只有应用层确认删除成功、且上下文仍然有效，才清除标记
        if (r && r.ok && !isStaleContext(ctx)) {
          if (r.superseded && Number(state.dataEpoch || 0) !== r.dataEpoch) {
            // 其他设备的更新清空已经取代本次意图。尚未获得新代次的本地数据也作废。
            state = getDefaultState()
            cloudSyncGeneration += 1
            practiceGeneration += 1
            aiConversationVersion += 1
          }
          state.dataEpoch = Number.isSafeInteger(r.dataEpoch) ? r.dataEpoch : ctx.dataEpoch
          if (ctx.deleteOperation.localResetId) state.pendingDeleteId = ctx.deleteOperation.localResetId
          try { localRepository.write(userScope, state) } catch (e) {
            dirty = true
            resolve()
            return
          }
          if (!setPendingDelete(ctx.scope, false)) {
            dirty = true
            resolve()
            return
          }
          if (r.superseded) {
            bootPulled = false
            pullFromCloud()
            practiceRestoredListeners.forEach((listener) => {
              try { listener() } catch (e) { console.error('[store] 练习恢复通知失败', e) }
            })
          }
          // 补上被这次删除拦下的上传，否则本地新数据要等到下次变更才同步
          dirty = true
          flush()
        }
        resolve()
      },
      fail: () => { resolve() } // 保留标记，下次 flush 继续重试
    })
  })
}

/**
 * 云端写操作串行队列。
 *
 * 为什么需要：push / delete 都是 fire-and-forget 的异步请求。若「清空」时
 * 还有上传在途，那个上传可能在删除之后才落到服务端，把用户刚删掉的数据又写回去。
 * 递增 cloudSyncGeneration 只能作废本地的拉取回调，既拦不住已经发出去的写请求，
 * 也没有把「删除代次」告知服务端（评审 P1 4422339092）。
 *
 * 做法：所有云端写操作排队，后发起的写一定在前一个写完成之后才发出。
 * 于是「在途上传 → 清空删除 → 新上传」的到达顺序与发起顺序一致。
 */
let cloudWriteChain = Promise.resolve()

function enqueueCloudWrite(task) {
  const run = cloudWriteChain.then(task)
  // 前一个写无论成功或失败都不能卡住队列
  cloudWriteChain = run.then(() => {}, () => {})
  return run
}

/** 传输只从已落盘的快照读取，队列确认也与档案一起落盘。 */
function syncPersistedState() {
  if (!state) return
  if (getPendingDelete(userScope)) deleteCloud()
  else if ((state.aiClearQueue || []).length) clearAiFromCloud()
  else pushToCloud()
}

const queuedPushes = new Set()
// 只服务于本进程已经捕获的旧快照；磁盘上的事实/标记在确认检查点中已归一化。
const confirmedAliases = new Map()
let lastPushFailure = null

function pushToCloud() {
  if (!hasCloud() || !isLogged() || !state) return
  const openid = getSessionOpenid()
  if (!openid || userScope !== openid) return
  if (getPendingDelete(openid) || (state.aiClearQueue || []).length) {
    setPendingPush(openid, true)
    dirty = true
    return
  }
  const ctx = captureSyncContext()
  const keepPending = (error = 'SYNC_WRITE_FAILED') => {
    if (!isStaleContext(ctx)) { lastPushFailure = { ctx, error }; setPendingPush(ctx.scope, true); dirty = true }
  }
  let snapshot
  try {
    snapshot = localRepository.read(userScope)
    if (!snapshot || typeof snapshot !== 'object' || !snapshot.attemptOutbox || Number(snapshot.dataEpoch || 0) !== ctx.dataEpoch) throw new Error('NO_DURABLE_SNAPSHOT')
    attemptOutbox.ensure(snapshot)
  } catch (e) { keepPending(); return }
  const payload = {
    records: snapshot.records, daily: snapshot.daily, settings: snapshot.settings,
    settingsVersions: settingsFieldVersions(snapshot), practiceSession: snapshot.practiceSession,
    aiMessages: snapshot.aiMessages, aiEpoch: snapshot.aiEpoch, version: snapshot.version
  }
  const payloadForSend = () => {
    const normalized = JSON.parse(JSON.stringify(snapshot))
    for (const fact of (normalized.attempts || []).slice()) {
      const accepted = confirmedAliases.get(JSON.stringify([ctx.gen, ctx.scope, ctx.token, fact.id]))
      if (accepted && attemptDomain.sameOperation(fact, accepted)) attemptDomain.resolveAttempt(normalized, fact, accepted)
    }
    const pendingIds = new Set(attemptOutbox.pending(state).map(a => a.id))
    attemptDomain.resolveRestored(normalized, state.attempts.filter(a => !pendingIds.has(a.id)))
    return { records: normalized.records, daily: normalized.daily, settings: normalized.settings,
      settingsVersions: settingsFieldVersions(normalized), practiceSession: normalized.practiceSession,
      aiMessages: normalized.aiMessages, aiEpoch: normalized.aiEpoch, version: normalized.version }
  }
  const operations = attemptOutbox.pending(snapshot)
  const signature = JSON.stringify([ctx, payload, operations.map(a => a.id)])
  if (queuedPushes.has(signature)) return
  queuedPushes.add(signature)
  enqueueCloudWrite(async () => {
    try {
      if (isStaleContext(ctx)) return
      // 排队期间前一请求可能已确认其中部分 ID；不依赖流水数组的位置。
      const currentOperations = new Map(attemptOutbox.pending(state).map(a => [a.id, a]))
      const unsent = operations.filter(a => currentOperations.has(a.id) && attemptDomain.canonical(a) === attemptDomain.canonical(currentOperations.get(a.id)))
      const batches = []
      const batchSize = unsent.some(grading.isVersioned) ? grading.MAX_VERSIONED_BATCH : 32
      for (let i = 0; i < unsent.length; i += batchSize) batches.push(unsent.slice(i, i + batchSize))
      if (!batches.length) batches.push([])
      for (let index = 0; index < batches.length; index++) {
        if (isStaleContext(ctx)) return
        const sent = batches[index]
        const result = await new Promise(resolve => {
          try {
            callCloud({ name: config.functions.studySync,
              data: { token: ctx.token, action: sent.some(grading.isVersioned) ? 'commitVersionedAttempts' : 'commitAttempts',
                  ...(sent.some(grading.isVersioned) ? { questionProtocol: grading.QUESTION_PROTOCOL } : {}), attemptProtocol: 2, dataEpoch: ctx.dataEpoch,
                ...(index === batches.length - 1 ? { stats: payloadForSend() } : {}), attempts: sent },
              success: res => resolve(res && res.result), fail: () => resolve(null) })
          } catch (e) { resolve(null) }
        })
        if (isStaleContext(ctx)) return
        const accepted = attemptOutbox.acknowledged(result, sent, ctx.dataEpoch)
        const receipts = accepted === null ? null : attemptDomain.validateReceipts(result, sent, accepted, state)
        if (receipts === null) {
          keepPending(result && result.error || (result ? 'INVALID_ATTEMPT_ACK' : 'NETWORK_ERROR'))
          if (result && result.error === 'STALE_EPOCH') { bootPulled = false; pullFromCloud() }
          return
        }
        let next = JSON.parse(JSON.stringify(state))
        for (const receipt of receipts) attemptDomain.resolveAttempt(next, sent.find(a => a.id === receipt.submittedId), receipt.attempt)
        const localOutbox = next.attemptOutbox
        next = mergeStats(next, { records: result.stats.records, daily: result.stats.daily })
        next.attemptOutbox = localOutbox
        attemptOutbox.remove(next, accepted)
        try { localRepository.write(userScope, next) } catch (e) { keepPending('PERSIST_ACK_FAILED'); return }
        state = next
        for (const receipt of receipts) confirmedAliases.set(JSON.stringify([ctx.gen, ctx.scope, ctx.token, receipt.submittedId]), receipt.attempt)
        syncRestoredListeners.forEach(listener => {
          try { listener() } catch (e) { console.error('[store] 提交确认通知失败', e) }
        })
        if (accepted.length !== sent.length) { keepPending('PARTIAL_ACK'); return }
        if (result.aiStale && Number.isSafeInteger(result.aiEpoch) &&
          Number(state.aiEpoch || 0) === ctx.aiEpoch && !(state.aiClearQueue || []).length) {
          state.aiMessages = []
          state.aiEpoch = result.aiEpoch
          aiConversationVersion += 1
          persist()
          bootPulled = false
          pullFromCloud()
        }
      }
      if (attemptOutbox.pending(state).length) keepPending()
      else if (!getPendingDelete(ctx.scope)) { setPendingPush(ctx.scope, false); lastPushFailure = null }
    } catch (e) { keepPending() } finally { queuedPushes.delete(signature); if (!queuedPushes.size) confirmedAliases.clear() }
  })
}

/** 前台/网络/登录触发只走同一个协调器，补传完成后再增量恢复。 */
const runSync = createSyncCoordinator({
  ready: () => hasCloud() && isLogged() && getSessionOpenid() === userScope,
  context: captureSyncContext,
  isCurrent: ctx => !isStaleContext(ctx),
  push: async () => {
    flush()
    for (let i = 0; i < 4; i++) {
      const tail = cloudWriteChain
      await tail
      if (tail === cloudWriteChain) break
    }
    const failure = lastPushFailure && !isStaleContext(lastPushFailure.ctx) ? lastPushFailure.error : null
    if (['OPERATION_CONFLICT', 'LEGACY_OPERATION_CONFLICT', 'ATTEMPT_ID_CONFLICT', 'BAD_FACT_METADATA', 'BAD_QUESTION_VERSION', 'QUESTION_PROTOCOL_REQUIRED', 'ATTEMPT_PROTOCOL_REQUIRED', 'BAD_ACTION'].includes(failure)) {
      throw Object.assign(new Error(failure), { code: failure, retryable: false })
    }
    return !dirty && !getPendingDelete(userScope) && !(state.aiClearQueue || []).length &&
      !attemptOutbox.pending(state).length && !getPendingPush(userScope)
  },
  pull: () => pullFromCloud(undefined, { force: true })
})

function syncNow() {
  load()
  return runSync()
}

/** 删除云端学习档案与全部作答流水（对应「清空学习数据」）；本地已清空，无需回写 */
/** 是否已有删除请求排在云端写队列中（避免每次 flush 重复入队） */
let pendingDeleteQueued = false

function deleteCloud() {
  // 只传输已持久化的意图；读失败或不存在都不能凭空创建删除操作。
  if (userScope === 'anon') return
  const operation = getDeleteOperation(userScope, true)
  if (!operation || !hasCloud() || !isLogged() || getSessionOpenid() !== userScope) return
  // 上下文必须在**入队时**捕获，而不是等队列排到它才捕获：
  // 删除要排在前面的在途上传之后才执行，这期间用户可能已经切到 B 账号。
  // 若在执行时才捕获，这次删除就会拿着 B 的令牌发出，删掉 B 的云端数据；
  // 其成功回包还会因为通过了 B 的过期校验，反过来清掉 A 的待删除标记
  // ——即「删错账号 + 标记误清」双重后果（评审 P1 4425820628）。
  // 执行与确认都必须绑定发起时的账号。
  const ctx = captureSyncContext()
  ctx.deleteOperation = operation
  if (pendingDeleteQueued) return
  pendingDeleteQueued = true
  // 与 push 共用一个队列：保证「清空」排在它之前发起的在途上传之后落地，
  // 否则那个上传会把刚删掉的数据重新写回服务端。
  enqueueCloudWrite(() =>
    deleteCloudRequest(ctx).then(() => {
      pendingDeleteQueued = false
    })
  )
}

// 每个清空操作单独确认；不复用最后一次清空的 ID，避免交错重试重复删除。
const queuedAiClears = new Set()

function clearAiFromCloud() {
  if (!hasCloud() || !isLogged() || !state || getPendingDelete(userScope) || getSessionOpenid() !== userScope) return
  const operation = (state.aiClearQueue || [])[0]
  if (!operation) return
  // 旧写盘回调可能晚于下一次清空。只有已落盘的操作 ID 才能发送，重启才能幂等重试。
  try {
    const saved = localRepository.read(userScope)
    if (!saved || !Array.isArray(saved.aiClearQueue) || !saved.aiClearQueue.some(op =>
      op.clearId === operation.clearId && op.dataEpoch === operation.dataEpoch)) return
  } catch (e) { return }
  const ctx = captureSyncContext()
  const key = JSON.stringify([ctx.gen, ctx.scope, ctx.token, operation.clearId])
  if (queuedAiClears.has(key)) return
  queuedAiClears.add(key)
  enqueueCloudWrite(async () => {
    if (isStaleContext(ctx) || !(state.aiClearQueue || []).some(op => op.clearId === operation.clearId)) {
      queuedAiClears.delete(key)
      return
    }
    const result = await new Promise(resolve => {
      try {
        callCloud({
          name: config.functions.studySync,
          data: { token: ctx.token, action: 'clearAI', ...operation },
          success: res => resolve(res && res.result), fail: () => resolve(null)
        })
      } catch (e) { resolve(null) }
    })
    queuedAiClears.delete(key)
    if (isStaleContext(ctx) || !(state.aiClearQueue || []).length || state.aiClearQueue[0].clearId !== operation.clearId) return
    if (result && result.ok && Number.isSafeInteger(result.aiEpoch) && result.dataEpoch === operation.dataEpoch) {
      state.aiClearQueue.shift()
      if (!state.aiClearQueue.length) {
        state.aiEpoch = result.aiEpoch
        if (result.superseded) {
          state.aiMessages = []
          aiConversationVersion += 1
          bootPulled = false
          pullFromCloud()
        }
      }
      dirty = true
      flush()
    } else if (result && result.error === 'STALE_EPOCH') {
      // 学习档案已经整体清空，此处的 AI 操作及消息不得跨 dataEpoch 重放。
      state.aiClearQueue = []
      persist()
      bootPulled = false
      pullFromCloud()
    }
    // 失败保留持久队列；下一次 flush / 重启重试同一 clearId。
  })
}

/**
 * 标记数据已变更并安排落盘，节流到至多每 FLUSH_INTERVAL 一次。
 * 页面进入后台时应调用 flush() 强制落盘，避免丢掉窗口内最后一次作答。
 */
function persist() {
  if (!state) return
  dirty = true
  if (flushTimer) return
  flushTimer = setTimeout(flush, Math.max(0, FLUSH_INTERVAL - (Date.now() - lastFlushAt)))
}

function getSettings() {
  return load().settings
}

function saveSettings(patch) {
  const s = load()
  const values = Object.assign({}, s.settings)
  const versions = settingsFieldVersions(s)
  const next = nextFieldVersion(versions)
  Object.keys(patch || {}).forEach((field) => {
    if (values[field] === patch[field]) return
    values[field] = patch[field]
    versions[field] = next
  })
  s.settings = values
  s.settingsVersions = versions
  persist()
  return s.settings
}

/**
 * 当前科目：全应用统一口径（刷题 / 错题 / 学情 / AI 都只统计该科目）。
 * 未设置或值不在题库中时，回落到题库首个科目，保证「始终处于某个具体科目下」。
 */
function getCurrentSubject() {
  const saved = load().settings.currentSubject
  const subjects = bank.getSubjects()
  if (subjects.some((s) => s.name === saved)) return saved
  return subjects.length ? subjects[0].name : ''
}

/** 切换当前科目；传入题库中不存在的科目时忽略，返回实际生效的科目 */
function setCurrentSubject(name) {
  const subjects = bank.getSubjects()
  if (!subjects.some((s) => s.name === name)) return getCurrentSubject()
  saveSettings({ currentSubject: name })
  flush() // 切换是显式操作，立即落盘
  return name
}

function getRecords() {
  return load().records
}

function getRecord(id) {
  if (!id) return null
  return load().records[id] || null
}

/**
 * 记录一次作答
 * @param {Object} question 题目对象（至少含 id / subject / chapter）
 * @param {Boolean} isCorrect 是否正确
 * @param {Number} costMs 本题耗时（毫秒）
 * @returns {{record: Object, today: Object}}
 */
function recordAnswer(question, isCorrect, costMs) {
  const result = recordAnswerInto(load(), question, isCorrect, costMs)
  persist()
  return result
}

function recordAnswerInto(s, question, isCorrect, costMs, attempt) {
  if (!question || !question.id) {
    throw new TypeError('recordAnswer: question 非法')
  }
  const now = attempt ? attempt.createdAt : Date.now()
  const key = todayKey(new Date(now))

  const prev = s.records[question.id]
  const r = prev || {
    id: question.id,
    subject: question.subject,
    chapter: question.chapter,
    attempts: 0,
    wrong: 0,
    right: 0,
    streak: 0,
    bestStreak: 0,
    level: 0, // 掌握等级 0-5
    starred: false,
    firstAt: now,
    lastAt: 0,
    lastWrongAt: 0,
    nextReviewAt: 0,
    rightDays: [],
    wrongLogs: []
  }
  r.fieldVersions = recordFieldVersions(r)
  const changedFields = ['lastAt', 'streak', 'level', 'rightDays', 'nextReviewAt']

  r.answerBy = Object.assign({}, recordCountsBy(r))
  if (attempt) {
    s.records[question.id] = r
    attemptDomain.projectCounts(s, attempt)
  } else {
    const writer = getWriterId()
    const own = Object.assign({ attempts: 0, right: 0, wrong: 0 }, r.answerBy[writer])
    own.attempts += 1
    if (isCorrect) own.right += 1
    else own.wrong += 1
    r.answerBy[writer] = own
    sumRecordCounts(r)
  }
  r.lastAt = now
  if (isCorrect) {
    r.streak = (Number(r.streak) || 0) + 1
    r.bestStreak = Math.max(r.bestStreak || 0, r.streak)
    r.level = Math.min(5, (r.level || 0) + 1)
    // 连续 MASTER_DAYS 天答对的错题，自动移出错题本
    r.rightDays = nextRightDays(r.rightDays || [], key)
    changedFields.push('bestStreak')
    if (r.wrong > 0 && r.rightDays.length >= MASTER_DAYS) {
      r.mastered = true
      changedFields.push('mastered')
    }
  } else {
    r.streak = 0
    r.level = Math.max(0, (r.level || 0) - 2)
    r.lastWrongAt = now
    r.mastered = false // 再次答错则重新回到错题本
    r.rightDays = []
    r.wrongLogs = (r.wrongLogs || []).concat([now]).slice(-20)
    changedFields.push('lastWrongAt', 'mastered', 'wrongLogs')
  }
  r.nextReviewAt = now + REVIEW_INTERVALS[r.level] * DAY
  advanceRecordFields(r, changedFields)
  s.records[question.id] = r

  if (attempt) return { record: r, today: s.daily[attempt.projection.date] }

  const d = s.daily[key] || {
    date: key,
    total: 0,
    correct: 0,
    timeMs: 0,
    by: {},
    chapters: {},
    subjects: {}
  }
  bumpCounter(d, isCorrect, costMs)
  const c = d.chapters[question.chapter] || { total: 0, correct: 0, by: {} }
  bumpCounter(c, isCorrect, 0)
  d.chapters[question.chapter] = c
  // 科目维度：供「当前科目」口径统计（今日进度 / 趋势）
  const sj = d.subjects[question.subject] || { total: 0, correct: 0, timeMs: 0, by: {} }
  bumpCounter(sj, isCorrect, costMs)
  d.subjects[question.subject] = sj
  s.daily[key] = d

  return { record: r, today: d }
}

/** 确保某题存在记录（不计入作答统计，仅用于收藏等场景） */
function ensureRecord(question) {
  if (!question || !question.id) {
    throw new TypeError('ensureRecord: question 非法')
  }
  const s = load()
  const now = Date.now()
  if (!s.records[question.id]) {
    s.records[question.id] = {
      id: question.id,
      subject: question.subject,
      chapter: question.chapter,
      attempts: 0,
      wrong: 0,
      right: 0,
      streak: 0,
      bestStreak: 0,
      level: 0,
      starred: false,
      firstAt: now,
      lastAt: 0,
      lastWrongAt: 0,
      nextReviewAt: 0,
      rightDays: [],
      wrongLogs: []
    }
    persist()
  }
  return s.records[question.id]
}

/** 收藏 / 取消收藏 */
function toggleStar(id) {
  const s = load()
  const r = s.records[id]
  if (!r) return false
  r.fieldVersions = recordFieldVersions(r)
  r.starred = !r.starred
  advanceRecordFields(r, ['starred'])
  persist()
  return r.starred
}

/** 掌握某道错题后可手动「移出错题本」（重置为已掌握） */
function resetWrong(id) {
  const s = load()
  const r = s.records[id]
  if (!r) return null
  r.fieldVersions = recordFieldVersions(r)
  r.level = 5
  r.streak = Math.max(r.streak || 0, 1)
  r.mastered = true
  r.nextReviewAt = Date.now() + REVIEW_INTERVALS[5] * DAY
  advanceRecordFields(r, ['level', 'streak', 'mastered', 'nextReviewAt'])
  persist()
  return r
}

/** 按当前科目口径取某天统计；该科目当天无记录时返回 0 值 */
function _subjectDaily(key) {
  const d = load().daily[key]
  const sub = d ? (d.subjects || {})[getCurrentSubject()] : null
  return {
    date: key,
    total: sub ? sub.total : 0,
    correct: sub ? sub.correct : 0,
    timeMs: sub ? sub.timeMs : 0
  }
}

function getToday() {
  return _subjectDaily(todayKey())
}

/** 最近 n 天的日统计（按日期升序，无数据的天补 0），按当前科目口径 */
function getDailyRange(days) {
  const list = []
  const now = new Date()
  for (let i = days - 1; i >= 0; i--) {
    list.push(_subjectDaily(todayKey(new Date(now.getTime() - i * DAY))))
  }
  return list
}

/** 连续打卡天数 */
/** 累计学习天数与总时长：只遍历有记录的日期，无需构造整年占位对象 */
function getStudySummary() {
  const s = load()
  let days = 0
  let timeMs = 0
  Object.keys(s.daily).forEach((key) => {
    const d = s.daily[key]
    if (!d) return
    if (d.total > 0) days += 1
    timeMs += d.timeMs || 0
  })
  return { days: days, timeMs: timeMs }
}

function getStreakDays() {
  const s = load()
  let streak = 0
  const now = new Date()
  for (let i = 0; i < 365; i++) {
    const d = new Date(now.getTime() - i * DAY)
    const key = todayKey(d)
    const item = s.daily[key]
    if (item && item.total > 0) {
      streak += 1
    } else if (i > 0) {
      break
    }
  }
  return streak
}

/**
 * 到期待复习记录（按当前科目口径）。
 * 与错题本「待复习」页共用同一套筛选口径，避免两处定义不一致：
 * 排除 已掌握 / 从未作答 / 高掌握且无错记录 / 未到期且错<2。
 * 排序：错得多的优先，其次掌握等级低的，最后到期早的。
 */
function getDueRecords(limit) {
  const s = load()
  const now = Date.now()
  const subject = getCurrentSubject()
  const list = []
  Object.keys(s.records).forEach((id) => {
    const r = s.records[id]
    if (!r || r.subject !== subject) return
    if (r.mastered || !(r.attempts > 0)) return
    if (r.level >= 5 && !r.lastWrongAt) return
    if ((r.nextReviewAt || 0) > now && r.wrong < 2) return
    list.push(r)
  })
  list.sort((a, b) => {
    if (b.wrong !== a.wrong) return b.wrong - a.wrong
    if (a.level !== b.level) return a.level - b.level
    return (a.nextReviewAt || 0) - (b.nextReviewAt || 0)
  })
  return typeof limit === 'number' ? list.slice(0, limit) : list
}

/** 今日待复习 id 列表（与 getDueRecords 同一口径） */
function getDueIds(limit) {
  return getDueRecords(limit).map((r) => r.id)
}

function getWrongRecords() {
  const s = load()
  const subject = getCurrentSubject()
  return Object.keys(s.records)
    .map((id) => s.records[id])
    .filter((r) => r && r.subject === subject && r.wrong > 0 && !r.mastered)
    .sort((a, b) => {
      if (b.wrong !== a.wrong) return b.wrong - a.wrong
      return (b.lastWrongAt || 0) - (a.lastWrongAt || 0)
    })
}

function getAiMessages() {
  return load().aiMessages
}

function pushAiMessage(msg) {
  const s = load()
  s.aiMessages = s.aiMessages.concat([Object.assign({ time: Date.now() }, msg)]).slice(-60)
  persist()
  return s.aiMessages
}

function clearAiMessages() {
  const s = load()
  s.aiMessages = []
  if (userScope !== 'anon') {
    if (!Array.isArray(s.aiClearQueue)) s.aiClearQueue = []
    s.aiClearQueue.push({ clearId: newId('ai_clear'), dataEpoch: Number(s.dataEpoch || 0) })
  }
  aiConversationVersion += 1 // 进程内：作废缓存页面与在途异步回复
  persist()
  flush() // 清空是不可逆操作，立即落盘
}

function clearAll() {
  const dataEpoch = Number(load().dataEpoch || 0)
  let deletion = null
  if (userScope !== 'anon') {
    try { deletion = setPendingDelete(userScope, true) } catch (e) {
      return { ok: false, error: 'PERSIST_DELETE_FAILED' }
    }
  }
  state = getDefaultState()
  state.dataEpoch = dataEpoch
  if (deletion) state.pendingDeleteId = deletion.localResetId
  aiConversationVersion += 1
  // 在途的云端拉取若回来，会把刚清空的档案再并回来
  cloudSyncGeneration += 1
  deleteCloud() // 同步删除云端学习档案与作答流水，保证本地与云端一并清空
  persist()
  flush() // 清空当前作用域（不可逆）
  const localStatus = localRepository.status(userScope)
  if (localStatus.state !== 'ready') return deletion ? { ok: true, pendingLocalReset: true, cleanupPending: true } : { ok: false, error: 'PERSIST_CLEAR_FAILED' }
  return { ok: true, cleanupPending: localStatus.cleanupPending }
}

/** 清空指定（或当前）作用域的全部本地数据；用于「安全删除/切换账号」场景 */
function clearScope(openid) {
  const target = openid ? String(openid) : userScope
  if (target === userScope) {
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = null
    dirty = false
    state = null
    aiConversationVersion += 1
    cloudSyncGeneration += 1
  }
  try { localRepository.clear(target) } catch (e) { return { ok: false, error: 'PERSIST_SCOPE_CLEAR_FAILED' } }
  try { wx.removeStorageSync(`${LEGACY_ATTEMPT_CURSOR_KEY}__${target}`) } catch (e) { /* Historical cursor is not an authority. */ }
  return { ok: true, cleanupPending: localRepository.status(target).cleanupPending }
}

function rollbackLocalStorage() {
  if (hasCloud() || dirty || activePull || queuedPushes.size || queuedAiClears.size || pendingDeleteQueued) return { ok: false, error: 'ROLLBACK_REQUIRES_OFFLINE_QUIESCENCE' }
  __clearFlushTimer()
  try { return { ...localRepository.rollback(userScope), restartRequired: true } } catch (e) { return { ok: false, error: e.code || 'LOCAL_ROLLBACK_FAILED' } }
}

/** Retry local persistence only. Never manufacture a failed answer or roll an ambiguous root back from memory. */
function retryLocalStorage() {
  const before = localRepository.status(userScope)
  if (before.commitUncertain) return { ok: false, error: 'LOCAL_RESTART_REQUIRED' }
  if (!scopeMigrationError && before.state === 'write_error' && !dirty) return { ok: false, error: 'RETRY_ORIGINAL_OPERATION' }
  try {
    localRepository.release(userScope)
    const saved = localRepository.read(userScope) // Verify all referenced evidence before reusing in-memory state.
    if (scopeMigrationError) {
      if (!saved) {
        const legacy = wx.getStorageSync(STORAGE_KEY)
        if (!legacy || typeof legacy !== 'object') throw Object.assign(new Error('LOCAL_LEGACY_MIGRATION_FAILED'), { code: 'LOCAL_LEGACY_MIGRATION_FAILED' })
        localRepository.write(userScope, legacy)
      }
      wx.removeStorageSync(STORAGE_KEY)
      scopeMigrationError = null
      notifyLocalStatus(localRepository.status(userScope))
    }
    if (!state) load({ localOnly: true })
    localRepository.retryMigration(userScope)
    localRepository.write(userScope, state)
    dirty = false
    __clearFlushTimer()
    const status = localRepository.status(userScope)
    return { ok: !status.migrationDeferred && !status.cleanupPending, deferred: !!status.migrationDeferred, cleanupPending: status.cleanupPending }
  } catch (e) { return { ok: false, error: e.code || 'LOCAL_RETRY_FAILED' } }
}

function onLocalStorageChange(listener) {
  localStorageListeners.add(listener)
  return () => localStorageListeners.delete(listener)
}

/* ============================================================
 * 练习 Session 状态机 + AnswerAttempt 不可变流水（Issue 2 / Issue 3）
 * ============================================================
 * Session 状态：created -> in_progress -> completed
 *   - 每道题有独立 attemptId；同一 clientOpId 重复提交只会落库一次（幂等）
 *   - 已提交的题在会话内回看为只读，不允许再次提交
 *   - 主动重练会创建新 Session（新 attemptId 序列）
 */

/** 当前/最新一次练习 Session；无则返回 null */
function getPracticeSession() {
  return load().practiceSession || null
}

/**
 * 创建一次练习 Session（created/in_progress）。
 * @param {Object} opt { mode, subject, questionIds }
 */
function createPracticeSession(opt) {
  const s = load()
  const questions = (opt && opt.questions) || (typeof bank.findQuestion === 'function' ? ((opt && opt.questionIds) || []).map(id => bank.findQuestion(id)).filter(Boolean) : [])
  const session = {
    id: newId('ps'),
    mode: (opt && opt.mode) || 'all',
    subject: (opt && opt.subject) || '',
    questionIds: (opt && opt.questionIds) || [],
    questionSnapshots: questions.length ? Object.fromEntries(questions.map(q => [q.id, bank.snapshotQuestion(q)])) : null,
    params: (opt && opt.params) || null, // 用于「重进页面恢复未完成会话」时比对参数
    status: 'in_progress',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    completedAt: 0,
    currentIndex: 0,
    submitted: {} // qid -> { attemptId, clientOpId, score, createdAt }
  }
  s.practiceSession = session
  practiceGeneration += 1
  persist()
  return session
}

/** 更新会话当前进度（前后翻页/自动下一题/暂停恢复） */
function updatePracticeSession(patch, context) {
  const s = load()
  if (context && !isPracticeContextCurrent(context)) return null
  if (!s.practiceSession) return null
  s.practiceSession = Object.assign({}, s.practiceSession, patch || {}, { updatedAt: bumpVersion(s.practiceSession) })
  persist()
  return s.practiceSession
}

/** 将会话标记为 completed */
function completePracticeSession(context) {
  return updatePracticeSession({ status: 'completed', completedAt: Date.now() }, context)
}

/** 主动重练：作废当前会话并新建（生成新 attemptId 序列） */
function restartPracticeSession(opt) {
  return createPracticeSession(opt)
}

/** 读取不可变作答流水（AnswerAttempt 列表） */
function getAttempts() {
  return (load().attempts || []).slice()
}

/**
 * 幂等提交一次作答。
 * @param {Object} question 题目对象
 * @param {Array} selected 用户作答
 * @param {Boolean} isCorrect 判分结果
 * @param {Number} costMs 用时
 * @param {String} clientOpId 客户端操作 ID（同一操作的重复提交用同一 ID 实现幂等）
 * @param {Object} [context] 发起页面绑定的练习上下文，失效时拒绝写入
 * @returns {{ok: Boolean, record: Object|null, attempt: Object|null, dup: Boolean, error?: String}}
 */
function submitAttempt(question, selected, isCorrect, costMs, clientOpId, context) {
  if (!question || !question.id) {
    throw new TypeError('submitAttempt: question 非法')
  }
  const original = load()
  const s = JSON.parse(JSON.stringify({ ...original, attempts: [], aiMessages: [] }))
  s.attempts = (original.attempts || []).slice() // Existing facts are immutable; do not clone confirmed history for each answer.
  s.aiMessages = (original.aiMessages || []).slice() // Repository pages freeze messages; new/cleared conversations replace the array.
  const session = s.practiceSession
  if (context && !isPracticeContextCurrent(context)) {
    return { ok: false, error: 'STALE_PRACTICE_CONTEXT', record: null, attempt: null, dup: false }
  }
  if (session && (context || (session.questionIds || []).length) &&
    (session.questionIds || []).indexOf(question.id) === -1) {
    return { ok: false, error: 'QUESTION_OUTSIDE_SESSION', record: null, attempt: null, dup: false }
  }
  const opId = clientOpId || newId('op')

  // submitted 只保留本题最后一次答案，不能作为历史操作的去重索引。
  // 以持久化流水查找业务幂等键，one→two→重试 one 也不会再落库或覆盖最新答案。
  const existing = session && (s.attempts || []).find((a) =>
    a.sessionId === session.id && a.questionId === question.id && a.clientOpId === opId
  )
  const latest = session && session.submitted && session.submitted[question.id]
  if (existing || (latest && latest.clientOpId === opId)) {
    return { ok: true, record: getRecord(question.id), attempt: existing || null, dup: true }
  }

  const pinned = session && session.questionSnapshots && session.questionSnapshots[question.id]
  if (session && session.questionSnapshots && Object.prototype.hasOwnProperty.call(session.questionSnapshots, question.id) &&
      (!pinned || pinned.versionId !== question.versionId)) return { ok: false, error: 'QUESTION_VERSION_MISMATCH', record: null, attempt: null, dup: false }
  const attemptId = newId('at')
  const attempt = {
    id: attemptId,
    sessionId: session ? session.id : '',
    questionId: question.id,
    questionVersionId: question.versionId || question.version || 'v1',
    selected: Array.isArray(selected) ? selected.slice() : selected,
    answer: JSON.parse(JSON.stringify(question.answer || [])),
    score: isCorrect ? 1 : 0,
    costMs: Number.isSafeInteger(costMs) ? Math.max(0, costMs) : 0,
    clientOpId: opId,
    createdAt: Date.now()
  }
  if (question.versionId && typeof bank.snapshotQuestion === 'function') {
    try {
      attempt.questionSnapshot = bank.snapshotQuestion(question)
      if (question.bankReleaseId) attempt.bankReleaseId = question.bankReleaseId
    } catch (e) { return { ok: false, error: 'BAD_QUESTION_VERSION', record: null, attempt: null, dup: false } }
  }
  const projection = { version: 1, subject: question.subject, chapter: question.chapter, date: todayKey(new Date(attempt.createdAt)) }
  if (attemptDomain.validProjection({ ...attempt, projection })) attempt.projection = projection
  // 未确认流水本地 ID 在确认后收敛为服务端业务 ID；已确认事实不改写。
  if (!s.attempts) s.attempts = []
  s.attempts.push(attempt)

  // 派生聚合统计（保持与旧 recordAnswer 一致的口径）
  const agg = recordAnswerInto(s, question, isCorrect, attempt.costMs, attempt.projection ? attempt : undefined)

  // 标记本题本会话已提交
  if (!s.practiceSession) s.practiceSession = null
  if (s.practiceSession) {
    if (!s.practiceSession.submitted) s.practiceSession.submitted = {}
    s.practiceSession.submitted[question.id] = { attemptId, clientOpId: opId, score: attempt.score, createdAt: attempt.createdAt }
    // 同步派生聚合统计，保证「重进页面恢复会话」时进度/正确率/错题与实时一致（评审 P2）
    const stats = recomputeSessionStats(s.practiceSession, s.attempts)
    Object.assign(s.practiceSession, stats)
    s.practiceSession.updatedAt = bumpVersion(s.practiceSession)
  }
  try {
    attemptOutbox.add(s, attempt)
    localRepository.write(userScope, s)
  } catch (e) { return { ok: false, error: 'PERSIST_ATTEMPT_FAILED', record: null, attempt: null, dup: false } }
  state = s
  dirty = false
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
  syncPersistedState()
  return { ok: true, record: agg.record, attempt: attempt, dup: false }
}

module.exports = {
  REVIEW_INTERVALS,
  todayKey,
  shortDate,
  getUserScope,
  getLocalStorageStatus: () => effectiveLocalStatus(localRepository.status(userScope)),
  onLocalStorageChange,
  retryLocalStorage,
  exportLocalSnapshot: () => localRepository.read(userScope),
  rollbackLocalStorage,
  getPracticeContext,
  isPracticeContextCurrent,
  onPracticeRestored,
  onSyncRestored,
  syncNow,
  setUserScope,
  clearScope,
  load,
  flush,
  mergeStats,
  getSettings,
  saveSettings,
  getCurrentSubject,
  setCurrentSubject,
  getRecords,
  getRecord,
  ensureRecord,
  recordAnswer,
  toggleStar,
  resetWrong,
  getToday,
  getDailyRange,
  getStudySummary,
  getStreakDays,
  getDueRecords,
  getDueIds,
  getWrongRecords,
  getAiMessages,
  getAiConversationVersion,
  pushAiMessage,
  clearAiMessages,
  clearAll,
  // Issue 2/3：练习 Session 状态机 + AnswerAttempt 不可变流水
  getPracticeSession,
  createPracticeSession,
  updatePracticeSession,
  completePracticeSession,
  restartPracticeSession,
  getAttempts,
  submitAttempt,
  pullFromCloud,
  // 仅供测试：取消待落盘的节流定时器，避免跨用例泄漏
  __clearFlushTimer
  }
