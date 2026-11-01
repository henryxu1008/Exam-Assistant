/** 学习档案同步：档案/流水原子提交；dataEpoch 拦截清空前的旧设备写入。
 * 清空保留不含学习内容的服务端墓碑，物理清理只匹配旧代次。
 * get 返回 syncRevision，客户端必须在全部分页成功后才发布恢复结果。
 */
const cloud = require('wx-server-sdk')
const crypto = require('crypto')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const USERS = db.collection('users')
const STATS = db.collection('studyStats')
const ATTEMPTS = db.collection('attempts')

/** 与端上 utils/store.js 相同的合并语义；部署副本随本函数一起上传 */
const { mergeStats } = require('./stats-merge.js')
/** 令牌校验（与 userProfile 保持一致）；部署副本随本函数一起上传 */
const { findByToken } = require('./auth.js')
/** 「读失败不得当成不存在」的统一判定；部署副本随本函数一起上传 */
const { isNotFound, readOptionalDoc } = require('./db-error.js')

/** studyStats 文档允许写入的字段（其余一律丢弃，防越权/脏数据） */
const ALLOWED = ['records', 'daily', 'settings', 'settingsVersions', 'practiceSession', 'aiMessages', 'aiEpoch', 'version']

/** 作答流水允许写入的字段（防止把大对象/无关字段塞进库） */
const ATTEMPT_FIELDS = [
  'id', 'sessionId', 'questionId', 'questionVersionId',
  'selected', 'answer', 'score', 'costMs', 'clientOpId', 'createdAt'
]

/**
 * 只放行白名单字段；云函数之间不共享本地模块，令牌查找逻辑需与 userProfile 保持一致。
 */
function sanitizeStats(payload) {
  const src = payload && typeof payload === 'object' ? payload : {}
  const out = {}
  ALLOWED.forEach((k) => {
    if (src[k] !== undefined) out[k] = src[k]
  })
  return out
}

/**
 * 清洗单条作答；无 id 的丢弃。
 *
 * 文档 _id 必须按账号隔离（openid 前缀）：attempts 的 get / delete 都按 openid
 * 过滤，但写入若是「谁的 id 都能写」，调用方只要知道别人的 attempt id
 * 就能整doc覆盖那条流水、并把 openid 改成自己的——账号隔离被绕过
 * （评审 P1 4422339084）。加上前缀后，任何写入都只能落进自己的命名空间。
 */
function sanitizeAttempt(a, openid, dataEpoch) {
  if (!a || !a.id) return null
  // 新代次用无分隔符的哈希 ID，与必含 __ 的历史 ID 命名空间不相交。
  const id = dataEpoch ? crypto.createHash('sha256').update(JSON.stringify([openid, dataEpoch, a.id])).digest('hex')
    : `${openid}__${String(a.id)}`
  const out = { _id: id, openid, dataEpoch }
  ATTEMPT_FIELDS.forEach((k) => {
    if (a[k] !== undefined) out[k] = a[k]
  })
  return out
}

/**
 * 读取服务端已有档案快照；确认不存在时返回 null。
 *
 * 只有「确认不存在」才等价于 null。其余错误（超时 / 权限 / 配额……）必须向上冒泡：
 * 若把读取失败也当成「没有云端数据」，update 就会拿调用方这一份不完整的快照
 * 去覆盖服务端文档并报告成功——一次读超时就抹掉了账号备份（评审 P1 4429855402）。
 */
async function readExisting(getDoc) {
  return readOptionalDoc(getDoc)
}

// 两次档案读写 + 最多 48 条流水各读写一次，低于 CloudBase 每事务 100 次操作限制。
const MAX_ATTEMPTS = 48
const epochOf = (doc) => Number(doc && doc.dataEpoch || 0)
const aiEpochOf = (doc) => Number(doc && doc.aiEpoch || 0)
function revisionOf(doc) {
  const n = doc && doc.syncRevision !== undefined ? doc.syncRevision : 0
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('INVALID_SYNC_REVISION')
  return n
}
function nextRevision(doc) {
  const n = revisionOf(doc) + 1
  if (!Number.isSafeInteger(n)) throw new Error('SYNC_REVISION_EXHAUSTED')
  return n
}
// 新事实在同一事务中分配严格递增序号；不使用客户端时间，也不改写历史事实。
function sequenceOf(doc) {
  const n = doc && doc.attemptSequence !== undefined ? doc.attemptSequence : 0
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('INVALID_ATTEMPT_SEQUENCE')
  return n
}
// 旧处理器会保留未知字段，但只推进 syncRevision。检测这种写入并使旧游标失效，
// 避免滚动升级/回滚期间无序号的新事实被增量查询永久跳过。
function generationOf(doc) {
  const n = doc && doc.sequenceGeneration !== undefined ? doc.sequenceGeneration : 0
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('INVALID_SEQUENCE_GENERATION')
  return n
}
const legacySequenceWrite = doc => doc && doc.sequenceRevision !== undefined && doc.sequenceRevision !== revisionOf(doc)
function nextGeneration(doc) {
  const n = generationOf(doc) + (legacySequenceWrite(doc) ? 1 : 0)
  if (!Number.isSafeInteger(n)) throw new Error('SEQUENCE_GENERATION_EXHAUSTED')
  return n
}
const sameRevision = (a, b) => epochOf(a) === epochOf(b) && revisionOf(a) === revisionOf(b)

// 清理只匹配旧代次；新代次使用不同文档 ID，清理与新作答并发也不会误删。
async function purgeRows(collection, filter) {
  for (;;) {
    const res = await collection.where(filter).limit(100).get()
    if (!res || !Array.isArray(res.data)) throw new Error('INVALID_CLEANUP_RESPONSE')
    if (!res.data.length) break
    for (const row of res.data) {
      try { await collection.doc(row._id).remove() } catch (e) { if (!isNotFound(e)) throw e }
    }
  }
}

async function purgeBefore(openid, dataEpoch) {
  for (const condition of [db.command.lt(dataEpoch), db.command.exists(false)]) {
    await purgeRows(ATTEMPTS, { openid, dataEpoch: condition })
  }
  await purgeRows(STATS, { kind: 'aiClearReceipt', openid, dataEpoch: db.command.lt(dataEpoch) })
}

exports.main = async (event = {}) => {
  if (!event.token) return { ok: false, error: 'NO_TOKEN' }
  const user = await findByToken(USERS, event.token)
  if (!user) return { ok: false, error: 'INVALID_TOKEN' }
  const openid = user.openid
  const action = event.action || 'get'

  if (action === 'get') {
    let stats
    try { stats = await readExisting(() => STATS.doc(openid).get()) } catch (e) {
      return { ok: false, error: 'READ_STATS_FAILED' }
    }
    const dataEpoch = epochOf(stats)
    const protocol = event.syncProtocol === 2
    let sequence, generation, syncRevision
    try { sequence = sequenceOf(stats); generation = generationOf(stats); syncRevision = revisionOf(stats) } catch (e) { return { ok: false, error: 'READ_STATS_FAILED' } }
    const cursor = protocol && event.cursor
    const delta = !!cursor
    let afterSequence = 0
    if (delta) {
      afterSequence = event.afterSequence === undefined ? cursor.sequence : event.afterSequence
      const cursorGeneration = cursor.generation === undefined ? 0 : cursor.generation
      if (legacySequenceWrite(stats) || cursorGeneration !== generation || cursor.dataEpoch !== dataEpoch || !Number.isSafeInteger(cursor.sequence) || cursor.sequence < 0 ||
        !Number.isSafeInteger(afterSequence) || afterSequence < cursor.sequence || afterSequence > sequence) {
        return { ok: false, error: 'CURSOR_RESET_REQUIRED', dataEpoch }
      }
    }
    if (event.syncRevision !== undefined && (event.syncRevision !== syncRevision || event.dataEpoch !== dataEpoch)) {
      return { ok: false, error: 'SNAPSHOT_CHANGED' }
    }
    const limit = Math.max(1, Math.min(parseInt(event.limit, 10) || 100, 100))
    const skip = Math.max(parseInt(event.skip, 10) || 0, 0)
    let list
    try {
      // 代次 0 兼容升级前没有 dataEpoch 的流水；清空后只读当前代次。
      const filter = dataEpoch ? { openid, dataEpoch } : { openid }
      let query
      if (delta) {
        query = ATTEMPTS.where({ ...filter, serverSequence: db.command.gt(afterSequence) }).orderBy('serverSequence', 'asc')
      } else query = ATTEMPTS.where(filter).orderBy('createdAt', 'asc').orderBy('_id', 'asc').skip(skip)
      const res = await query.limit(limit).get()
      if (!res || !Array.isArray(res.data)) throw new Error('INVALID_ATTEMPTS_RESPONSE')
      list = res.data
      if (delta) {
        let previous = afterSequence
        for (const row of list) {
          if (!Number.isSafeInteger(row.serverSequence) || row.serverSequence <= previous || row.serverSequence > sequence) throw new Error('INVALID_INCREMENTAL_PAGE')
          previous = row.serverSequence
        }
      }
    } catch (e) { return { ok: false, error: 'READ_ATTEMPTS_FAILED' } }
    try {
      // where 不能放入事务。前后读修订号并跨页携带，整批恢复才是同一快照。
      const after = await readExisting(() => STATS.doc(openid).get())
      if (!sameRevision(stats, after)) return { ok: false, error: 'SNAPSHOT_CHANGED' }
    } catch (e) { return { ok: false, error: 'READ_STATS_FAILED' } }
    const attempts = list.map(({ _id, openid: _owner, dataEpoch: _epoch, serverSequence: _sequence, ...rest }) => rest)
    const hasMore = list.length >= limit
    const includeStats = !protocol || (delta ? afterSequence === cursor.sequence : skip === 0)
    return { ok: true, stats: includeStats && stats && !stats.deleted ? sanitizeStats(stats) : null,
      attempts, hasMore, nextSkip: hasMore ? skip + list.length : null, dataEpoch, syncRevision, aiEpoch: aiEpochOf(stats),
      ...(protocol ? { syncProtocol: 2, mode: delta ? 'delta' : 'bootstrap', cursor: { dataEpoch, sequence, generation },
        nextSequence: delta && list.length ? list[list.length - 1].serverSequence : afterSequence } : {}) }
  }

  if (action === 'clearAI') {
    if (typeof db.runTransaction !== 'function') return { ok: false, error: 'TRANSACTION_REQUIRED' }
    if (!Number.isSafeInteger(event.dataEpoch) || event.dataEpoch < 0 ||
      typeof event.clearId !== 'string' || !event.clearId || event.clearId.length > 120) {
      return { ok: false, error: 'BAD_CLEAR_OPERATION' }
    }
    try {
      return await db.runTransaction(async (tx) => {
        const stats = tx.collection('studyStats')
        const ref = stats.doc(openid)
        const existing = await readExisting(() => ref.get())
        if (epochOf(existing) !== event.dataEpoch) return { ok: false, error: 'STALE_EPOCH', dataEpoch: epochOf(existing) }
        // 每个清空保留回执。A 的 ACK 丢失、B 又清空后，A 重试不能再次删除 B 的新消息。
        const id = 'aiClear_' + crypto.createHash('sha256')
          .update(JSON.stringify([openid, event.dataEpoch, event.clearId])).digest('hex')
        const receiptRef = stats.doc(id)
        const receipt = await readExisting(() => receiptRef.get())
        const current = aiEpochOf(existing)
        if (!Number.isSafeInteger(current) || current < 0 || current >= Number.MAX_SAFE_INTEGER) throw new Error('INVALID_AI_EPOCH')
        if (receipt) {
          if (receipt.kind !== 'aiClearReceipt' || receipt.openid !== openid || receipt.dataEpoch !== event.dataEpoch ||
            !Number.isSafeInteger(receipt.aiEpoch) || receipt.aiEpoch < 1 || receipt.aiEpoch > current) throw new Error('INVALID_CLEAR_RECEIPT')
          return { ok: true, dataEpoch: event.dataEpoch, aiEpoch: current, superseded: receipt.aiEpoch < current }
        }
        const aiEpoch = current + 1
        const data = Object.assign({}, existing || mergeStats(null, {}), {
          _id: openid, openid, dataEpoch: event.dataEpoch, aiEpoch, aiMessages: [],
          syncRevision: nextRevision(existing), sequenceRevision: nextRevision(existing),
          sequenceGeneration: nextGeneration(existing), updatedAt: Date.now()
        })
        await ref.set({ data })
        await receiptRef.set({ data: { _id: id, kind: 'aiClearReceipt', openid,
          dataEpoch: event.dataEpoch, aiEpoch, createdAt: Date.now() } })
        return { ok: true, dataEpoch: event.dataEpoch, aiEpoch }
      })
    } catch (e) { return { ok: false, error: 'CLEAR_AI_FAILED' } }
  }

  if (action === 'update') {
    if (typeof db.runTransaction !== 'function') return { ok: false, error: 'TRANSACTION_REQUIRED' }
    const dataEpoch = event.dataEpoch === undefined ? 0 : event.dataEpoch
    if (!Number.isSafeInteger(dataEpoch) || dataEpoch < 0) return { ok: false, error: 'BAD_EPOCH' }
    const raw = Array.isArray(event.attempts) ? event.attempts : []
    if (raw.length > MAX_ATTEMPTS) return { ok: false, error: 'BATCH_TOO_LARGE' }
    if (raw.some((a) => !a || typeof a.id !== 'string' || !a.id)) return { ok: false, error: 'BAD_ATTEMPT' }
    const attempts = raw.map((a) => sanitizeAttempt(a, openid, dataEpoch))
    try {
      return await db.runTransaction(async (tx) => {
        const ref = tx.collection('studyStats').doc(openid)
        const existing = await readExisting(() => ref.get())
        if (epochOf(existing) !== dataEpoch) return { ok: false, error: 'STALE_EPOCH', dataEpoch: epochOf(existing) }
        let attemptSequence = sequenceOf(existing)
        const incoming = sanitizeStats(event.stats)
        const aiStale = (incoming.aiEpoch !== undefined || incoming.aiMessages !== undefined) &&
          Number(incoming.aiEpoch || 0) !== aiEpochOf(existing)
        if (aiStale) {
          // 普通快照不能生成清空代次；只忽略旧/伪造 AI 片段，其他学习数据仍正常提交。
          delete incoming.aiEpoch
          delete incoming.aiMessages
        }
        incoming.attempts = attempts
        const merged = mergeStats(existing, incoming)
        delete merged.attempts
        Object.assign(merged, { _id: openid, openid, dataEpoch, syncRevision: nextRevision(existing),
          sequenceRevision: nextRevision(existing), sequenceGeneration: nextGeneration(existing),
          deleted: !event.stats && !!(existing && existing.deleted),
          lastDeleteId: existing && existing.lastDeleteId || null, updatedAt: Date.now() })
        // 流水和派生档案一起提交。任一流水写失败会回滚整个事务。
        for (const attempt of attempts) {
          const attemptRef = tx.collection('attempts').doc(attempt._id)
          const accepted = await readExisting(() => attemptRef.get())
          if (accepted) {
            // 重试只能重放同一事实，不允许同 ID 修改已接受的答案/得分。
            if (JSON.stringify(sanitizeAttempt(accepted, openid, dataEpoch)) !== JSON.stringify(attempt)) {
              const error = new Error('ATTEMPT_CONFLICT')
              error.code = 'ATTEMPT_CONFLICT'
              throw error
            }
          } else {
            if (attemptSequence >= Number.MAX_SAFE_INTEGER) throw new Error('ATTEMPT_SEQUENCE_EXHAUSTED')
            attemptSequence += 1
            await attemptRef.set({ data: { ...attempt, serverSequence: attemptSequence } })
          }
        }
        merged.attemptSequence = attemptSequence
        await ref.set({ data: merged })
        return { ok: true, dataEpoch, aiEpoch: aiEpochOf(merged), aiStale, acceptedAttemptIds: attempts.map(a => a.id) }
      })
    } catch (e) { return { ok: false, error: e.code === 'ATTEMPT_CONFLICT' ? e.code : 'TX_FAILED' } }
  }

  if (action === 'delete') {
    if (typeof db.runTransaction !== 'function') return { ok: false, error: 'TRANSACTION_REQUIRED' }
    if (!Number.isSafeInteger(event.dataEpoch) || event.dataEpoch < 0 ||
      typeof event.deleteId !== 'string' || !event.deleteId || event.deleteId.length > 120) {
      return { ok: false, error: 'RESET_PROTOCOL_REQUIRED' }
    }
    let result
    try {
      result = await db.runTransaction(async (tx) => {
        const ref = tx.collection('studyStats').doc(openid)
        const existing = await readExisting(() => ref.get())
        const current = epochOf(existing)
        // 丢失 ACK / 旧设备重试不得再清空新作答；旧清空已被更新的清空取代。
        if (existing && existing.lastDeleteId === event.deleteId) {
          return { ok: true, dataEpoch: current }
        }
        if (event.dataEpoch < current) return { ok: true, dataEpoch: current, superseded: true }
        if (event.dataEpoch !== current) return { ok: false, error: 'STALE_EPOCH', dataEpoch: current }
        await ref.set({ data: { _id: openid, openid, dataEpoch: current + 1,
          syncRevision: nextRevision(existing), sequenceRevision: nextRevision(existing),
          sequenceGeneration: 0, attemptSequence: 0, deleted: true, lastDeleteId: event.deleteId, updatedAt: Date.now() } })
        return { ok: true, dataEpoch: current + 1 }
      })
    } catch (e) { return { ok: false, error: 'DELETE_STATS_FAILED' } }
    if (!result.ok) return result
    try { await purgeBefore(openid, result.dataEpoch) } catch (e) {
      // 墓碑已经生效，但尚未完成物理清理。保留同一 deleteId 重试。
      return { ok: false, error: 'DELETE_ATTEMPTS_FAILED', dataEpoch: result.dataEpoch }
    }
    return result
  }
  return { ok: false, error: 'BAD_ACTION' }
}
