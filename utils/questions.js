/**
 * utils/questions.js
 * 题库入口：统一从 manifest 驱动的加载器导出，保持对外 API 不变。
 *
 * 科目与章节定义见 utils/bank/manifest.js；题目按科目拆分到 utils/bank/<key>.js 分片。
 * 需要新增科目时：① 在 manifest.js 追加一项；② 创建对应的 utils/bank/<key>.js
 *   （module.exports = [题目...]）；其余查询函数无需改动。
 */

module.exports = require('./bank/index.js')
