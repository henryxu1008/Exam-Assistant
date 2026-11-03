/**
 * utils/config.js
 * 应用配置
 */

module.exports = {
  /** 云开发环境 ID，例如 'cloud1-8gxxxxxx'；留空则使用默认环境（需在开发者工具中指定） */
  cloudEnv: 'cloud1-d4gye2rcib84f0347',

  /** 小程序当前版本号（用于云端强制更新校验） */
  version: '1.3.0',

  /** 仅供受保护题库完成端到端验收后统一启用；服务端目前固定关闭 */
  protectedCatalog: false,

  /** 云函数名称 */
  functions: {
    login: 'userLogin', // 登录：code -> openid/token
    profile: 'userProfile', // 资料：读取/更新/登出
    studySync: 'studySync', // 学习档案：云端读取/更新
    bankSync: 'bankSync', // 题库：云端读取/种子写入
    aiQuestionGen: 'aiQuestionGen', // 管理端候选题生成（默认关闭）
    commerce: 'commerce' // 商品配置；下单功能关闭
  }
}
