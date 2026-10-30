/**
 * 云函数 bankSync
 * 入参：{ action: 'get' | 'set', bank? }
 * 出参：{ ok, bank? }
 *
 * action=get：返回云端题库（questions 集合 _id='bank' 文档）；不存在返回 { ok:true, bank:null }。
 * action=set：写入/覆盖云端题库（由小程序端首次运行时把内置静态题库种入；之后在控制台可手动编辑题目）。
 *
 * 云端题库结构：{ _id:'bank', manifest:{subjects:[...]}, questions:{ <key>: [题目...] } }
 * 与 utils/bank 的静态结构保持一致，前端拉到后整体替换数据源，无需改动查询逻辑。
 *
 * 依赖集合：questions
 */

const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const BANK = db.collection('questions')

exports.main = async (event) => {
  const action = event.action || 'get'

  if (action === 'get') {
    try {
      const res = await BANK.doc('bank').get()
      return { ok: true, bank: res.data || null }
    } catch (e) {
      // 文档不存在视为尚未种子化
      return { ok: true, bank: null }
    }
  }

  if (action === 'set') {
    const bank = event.bank
    if (!bank || !bank.manifest || !bank.questions) return { ok: false, error: 'BAD_BANK' }
    await BANK.doc('bank').set({ data: Object.assign({ _id: 'bank' }, bank) })
    return { ok: true }
  }

  return { ok: false, error: 'BAD_ACTION' }
}
