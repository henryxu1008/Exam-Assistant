/**
 * utils/config.js
 * 应用配置
 */

module.exports = {
  /** 云开发环境 ID，例如 'cloud1-8gxxxxxx'；留空则使用默认环境（需在开发者工具中指定） */
  cloudEnv: 'cloud1-d4gye2rcib84f0347',

  /** 云函数名称 */
  functions: {
    login: 'userLogin', // 登录：code -> openid/token
    profile: 'userProfile' // 资料：读取/更新/登出
  }
}
