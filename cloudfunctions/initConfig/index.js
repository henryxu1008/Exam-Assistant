/**
 * 一次性初始化云函数 initConfig
 * 用途：把云端运营所需的默认数据写入云数据库 appConfig 集合：
 *   - _id = 'examOptions'：目标考试可选项默认列表
 *   - _id = 'runtime'   ：运营配置（公告 / 功能开关 / 强制更新 / 隐私版本等）
 *
 * 鉴权（评审 P1 4422245843）：本函数会整体覆盖共享的运营配置文档，
 * 任何人可直接调用就意味着任何人都能删掉运营公告、重新打开已关闭的开关、
 * 把 forceUpdate 重置为 false。因此必须持有服务端认可的管理员身份：
 *
 *   运行方式（云开发控制台 → 云函数 → initConfig → 运行）：
 *     { "adminSecret": "<ADMIN_SECRET>" }
 *
 *   - ADMIN_SECRET 需在云函数环境变量中配置；未配置时一律拒绝（fail-closed），
 *     绝不出现「没配密钥就放行」的情况。
 *   - 亦可用管理员账号调用：传 { "token": "<管理员登录令牌>" }，
 *     其 openid 需在 ADMIN_OPENIDS 或 appConfig.admins 名单内。
 *
 * 幂等与不覆盖：默认只补缺失字段，已存在的运营配置保持不动；
 * 需要整体重置为默认值时显式传 { "force": true }。
 */

const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const CONFIG = db.collection('appConfig')

/** 鉴权原语；部署副本随本函数一起上传 */
const { verifyAdminSecret } = require('./auth.js')

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

/** 读取已有文档；不存在返回 null */
async function readDoc(id) {
  try {
    const res = await CONFIG.doc(id).get()
    return (res && res.data) || null
  } catch (e) {
    return null
  }
}

/**
 * 用默认值补齐缺失字段，已存在的字段保持原值（运营在控制台的改动不会被冲掉）。
 * features 逐键补齐，避免新增开关时把运营已关闭的开关重新打开。
 */
function fillDefaults(existing, defaults) {
  const out = Object.assign({}, defaults, existing || {})
  const df = (defaults && defaults.features) || {}
  const ef = (existing && existing.features) || {}
  out.features = Object.assign({}, df, ef)
  out.updatedAt = Date.now()
  return out
}

exports.main = async (event) => {
  const e = event || {}

  // 共享配置的写操作：凭据校验全在服务端，端上无法伪造。
  // 控制台运行没有登录身份，因此这里只认管理员密钥（fail-closed）。
  const auth = verifyAdminSecret(e)
  if (!auth.ok) return auth

  const force = e.force === true

  const existingOptions = await readDoc('examOptions')
  const options = force
    ? { _id: 'examOptions', options: DEFAULT_EXAM_OPTIONS, updatedAt: Date.now() }
    : fillDefaults(existingOptions, { _id: 'examOptions', options: DEFAULT_EXAM_OPTIONS })

  const existingRuntime = await readDoc('runtime')
  const runtime = force
    ? Object.assign({}, DEFAULT_RUNTIME, { updatedAt: Date.now() })
    : fillDefaults(existingRuntime, DEFAULT_RUNTIME)

  const a = await CONFIG.doc('examOptions').set({ data: options })
  const b = await CONFIG.doc('runtime').set({ data: runtime })
  return { ok: true, examOptions: options.options, runtime: runtime, res: { a: a, b: b } }
}
