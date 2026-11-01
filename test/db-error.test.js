/**
 * shared/db-error.js 的判定表（PR #10 评审根因收敛）
 *
 * 「读失败不得当成不存在」这一条规则，现在由全云函数共用的
 * shared/db-error.js 单点承载。这里锁定它的判定边界：
 * 只有「确认不存在」才允许被当作没有数据，其余一律视为真失败。
 *
 * 为什么要为这么小的模块单独立测试：所有 read-then-write 路径（运维配置、
 * 题库、答题流水）都依赖这一个判断，判错一次就会用默认值覆盖真实数据。
 */

const { test } = require('node:test')
const assert = require('node:assert/strict')

const { isNotFound, readOptionalDoc } = require('../shared/db-error.js')

test('isNotFound：只有「确认不存在」为真', () => {
  // 确认不存在：允许下游视为「没有数据」
  assert.equal(isNotFound(new Error('document does not exist')), true, '文档不存在')
  assert.equal(isNotFound({ code: 'DOCUMENT_NOT_FOUND' }), true, '明确的单文档不存在')
  assert.equal(isNotFound({ errCode: -1, errMsg: 'document.get:fail document with _id runtime does not exist' }), true)
  assert.equal(isNotFound(new Error('文档不存在')), true, '中文「不存在」')

  // 其余一律为假：绝不把「读失败」当成「不存在」
  assert.equal(isNotFound(new Error('read timeout')), false, '读超时')
  assert.equal(isNotFound({ errCode: -502001, message: 'network error' }), false, '网络错误')
  assert.equal(
    isNotFound({ errCode: -502003, message: 'permission denied' }),
    false,
    '权限错误不得当成不存在'
  )
  assert.equal(isNotFound(new Error()), false, '无信息异常')
  assert.equal(isNotFound({}), false, '空对象')
  assert.equal(isNotFound(null), false, 'null')
  assert.equal(isNotFound(undefined), false, 'undefined')

  // 方向性约束：判定只能窄、不能宽。
  // 把「读失败」误判成「不存在」会让后面用默认值覆盖真实数据，
  // 因此不扫描消息里夹带的数字错误码——宁可判为真失败，也不能放宽。
  assert.equal(
    isNotFound(new Error('ERR: [-502005] internal')),
    false,
    '消息里夹带的错误码不得放宽判定'
  )
})

test('readOptionalDoc：确认不存在返回 null，其余错误原样抛出', async () => {
  assert.equal(
    await readOptionalDoc(async () => {
      throw new Error('document does not exist')
    }),
    null,
    '不存在应归一化为 null'
  )

  // 读失败必须冒泡，否则调用方会拿默认值去覆盖真实存在的数据
  await assert.rejects(
    readOptionalDoc(async () => {
      throw new Error('read timeout')
    }),
    /read timeout/,
    '读失败必须原样抛出'
  )

  assert.deepEqual(
    await readOptionalDoc(async () => ({ data: { a: 1 } })),
    { a: 1 },
    '正常读取返回 data'
  )
  assert.equal(await readOptionalDoc(async () => ({ data: null })), null)
})

test('基础设施缺失或错误码冲突不得当成文档不存在', () => {
  for (const error of [
    new Error('collection not exists'),
    new Error('index does not exist'),
    new Error('database does not exist'),
    { errCode: -502005 },
    { errorCode: -502004 },
    { code: 'DATABASE_COLLECTION_NOT_EXIST' },
    { code: 'DATABASE_PERMISSION_DENIED', message: 'document does not exist' },
    { errCode: -502001, message: 'document does not exist' },
    { errorCode: 'UNKNOWN', errCode: 'DOCUMENT_NOT_FOUND' },
    new Error('permission denied: document does not exist')
  ]) assert.equal(isNotFound(error), false, JSON.stringify(error))
})

test('可选文档读取缺少有效 data 时必须失败', async () => {
  for (const result of [undefined, null, {}, { data: undefined }, { data: [] }, { data: false }]) {
    await assert.rejects(readOptionalDoc(async () => result), /INVALID_DOCUMENT_RESPONSE/)
  }
})
