/**
 * 一次性初始化云函数 initConfig
 * 用途：把云端运营所需的默认数据写入云数据库 appConfig 集合：
 *   - _id = 'examOptions'：目标考试可选项默认列表
 *   - _id = 'runtime'   ：运营配置（公告 / 功能开关 / 强制更新 / 隐私版本等）
 *
 * 部署后，在云开发「云函数」面板对该函数右键「运行」一次即可；预置完成后可保留也可删除，
 * 日常运行不依赖本函数（选项与配置完全由后台在 appConfig 中维护）。
 *
 * 若将来要改默认值，直接改下面的 DEFAULT_* 重新运行一次即可（会整体覆盖对应文档）。
 */

const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const CONFIG = db.collection('appConfig')

/** 目标考试默认可选项（仅作为云端集合尚未配置时的初始种子） */
const DEFAULT_EXAM_OPTIONS = [
  '事业单位 · 公共基础知识',
  '事业单位 · 职业能力测验',
  '事业单位 · 综合知识（公基+职测）',
  '公务员 · 行政职业能力测验',
  '公务员 · 申论',
  '教师招聘 · 教育综合知识',
  '社区工作者 · 综合能力'
]

/**
 * 运营配置默认种子
 *  - notice / noticeEnabled：首页公告横幅
 *  - features：功能开关（灰度用，前端按需读取）
 *  - minVersion / forceUpdate：低于 minVersion 且 forceUpdate=true 时强制更新
 *  - privacyVersion：隐私政策版本号（前端可据此重新要求用户同意）
 */
const DEFAULT_RUNTIME = {
  _id: 'runtime',
  notice: '',
  noticeEnabled: false,
  features: { aiAdvice: true },
  minVersion: '1.0.0',
  forceUpdate: false,
  privacyVersion: 20261030
}

exports.main = async () => {
  const a = await CONFIG.doc('examOptions').set({
    data: {
      _id: 'examOptions',
      options: DEFAULT_EXAM_OPTIONS,
      updatedAt: Date.now()
    }
  })
  const b = await CONFIG.doc('runtime').set({ data: DEFAULT_RUNTIME })
  return { ok: true, examOptions: DEFAULT_EXAM_OPTIONS, runtime: DEFAULT_RUNTIME, res: { a: a, b: b } }
}
