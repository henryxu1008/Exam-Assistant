/**
 * shared/db-error.js
 * 云数据库「确认单文档不存在」的统一判定。
 *
 * 为什么要单独抽成一个共享模块：
 * 多个云函数都要把「文档不存在」归一化为「没有数据」，但**只有确认不存在
 * 才等价于不存在**。过去各函数各自内联 try/catch，于是「读取超时 / 权限错误」
 * 也被当成不存在，紧接着的 set() 就用默认值覆盖了服务端真实存在的数据——
 * 这一轮评审在运维配置、题库、答题流水三处分别中招。
 *
 * 收敛到一个实现，并由 scripts/check-shared-sync.js 强制各部署副本逐字节一致：
 * initConfig 正是因为照抄了 studySync 的旧实现才带着同一个缺陷，
 * 靠「人工记得同步」挡不住这条传播链。
 *
 * 统一原则：只有 true 时才允许把读取结果当作「没有数据」继续执行（幂等成功）；
 * 其余一律视为真失败并向上冒泡。宁可本次操作报错重试，
 * 也不能让后面的写入覆盖掉读不到的真实数据。
 */

/** 只接受明确的单文档缺失；集合/数据库/索引缺失均是访问失败。 */
const NOT_FOUND_CODES = ['DOCUMENT_NOT_FOUND']

/** 旧版 wx SDK 可能只给单文档缺失文本或通用 -1；不能匹配任意 not exist。 */
const NOT_FOUND_TEXT = /^(?:document\.get:fail\s*)?(?:document(?: with _id [^\r\n]+)? does not exist|文档不存在)[.!。]?$/i

/**
 * 该错误是否表示「目标确认不存在」。
 * @param {*} e 捕获到的异常
 * @returns {Boolean}
 */
function isNotFound(e) {
  if (!e) return false
  const codes = [e.errorCode, e.errCode, e.code].filter((code) => code != null && code !== '')
  if (codes.length && codes.every((code) => NOT_FOUND_CODES.indexOf(code) !== -1)) return true
  // 有明确的失败码时不得再用消息文本推翻它；未知码也不能凭猜测放行。
  if (codes.some((code) => code !== -1 && code !== '-1')) return false
  return NOT_FOUND_TEXT.test(String(e.message || e.errMsg || '').trim())
}

/**
 * 读取一个可能不存在的文档：确认不存在时返回 null，其余错误原样抛出。
 *
 * 所有「读了再写」的场景都必须走这里，不要自己写 try/catch——
 * 自己写就会漏掉 isNotFound 判断，本轮三条 P1/P2 都是这么来的。
 *
 * @param {Function} getDoc 无参、返回 Promise 的读取动作
 * @returns {Promise<Object|null>}
 */
async function readOptionalDoc(getDoc) {
  try {
    const got = await getDoc()
    // 成功响应必须带 data；缺字段/结构异常也不构成「确认不存在」。
    if (!got || !Object.prototype.hasOwnProperty.call(got, 'data') ||
      (got.data !== null && (typeof got.data !== 'object' || Array.isArray(got.data)))) {
      throw new Error('INVALID_DOCUMENT_RESPONSE')
    }
    return got.data
  } catch (e) {
    if (isNotFound(e)) return null
    throw e
  }
}

module.exports = { isNotFound, readOptionalDoc, NOT_FOUND_CODES, NOT_FOUND_TEXT }
