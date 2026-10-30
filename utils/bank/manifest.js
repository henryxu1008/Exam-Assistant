/**
 * utils/bank/manifest.js
 * 题库清单（manifest）：科目与章节的唯一来源（manifest-driven）。
 *
 * 页面构建科目 / 章节列表、以及统计口径的科目维度，都从这里取，不再扫描题目数组。
 * 新增科目或章节只需改这里；题目数据仍在 utils/questions.js 的 QUESTIONS 中。
 *
 * 后续若要「按科目分片 / 云端下发」：把 QUESTIONS 切到 utils/bank/<key>.js 分片，
 * 并在 questions.js 的读取逻辑里按 manifest.subjects 逐个 require 即可，其余查询逻辑不动。
 *
 * 题目字段：id / subject / chapter / type(single|multiple|judge|uncertain|fill|sort)
 *   / level(1-3) / stem / options([{key,text}]) / answer / explain / pitfall / keyPoint / tags
 */

module.exports = {
  version: 1,
  subjects: [
    {
      key: 'gk',
      name: '公共基础知识',
      chapters: [
        { key: 'gk-law', name: '法律常识' },
        { key: 'gk-gw', name: '公文写作' },
        { key: 'gk-eco', name: '经济管理' },
        { key: 'gk-sci', name: '科技人文' }
      ]
    },
    {
      key: 'nl',
      name: '职业能力测验',
      chapters: [
        { key: 'nl-ver', name: '言语理解' },
        { key: 'nl-num', name: '数量关系' },
        { key: 'nl-log', name: '判断推理' },
        { key: 'nl-dat', name: '资料分析' }
      ]
    },
    {
      key: 'it',
      name: '专业知识',
      chapters: [
        { key: 'it-os', name: '操作系统' },
        { key: 'it-net', name: '网络基础' },
        { key: 'it-db', name: '数据库' },
        { key: 'it-sec', name: '信息安全' }
      ]
    }
  ]
}
