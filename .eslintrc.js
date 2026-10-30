/*
 * Eslint config file
 * Documentation: https://eslint.org/docs/user-guide/configuring/
 * Install the Eslint extension before using this feature.
 */
module.exports = {
  env: {
    es6: true,
    browser: true,
    node: true
  },
  parserOptions: {
    ecmaVersion: 2018,
    sourceType: 'script' // 小程序与云函数均为 CommonJS
  },
  globals: {
    wx: true,
    App: true,
    Page: true,
    getCurrentPages: true,
    getApp: true,
    Component: true,
    requirePlugin: true,
    requireMiniProgram: true
  },
  ignorePatterns: ['**/node_modules/**', 'miniprogram_npm/**'],
  /*
   * 暂不上 eslint:recommended 整体推荐集：会一次性涌入大量历史告警，掩盖真正的问题。
   * 这里先启用当前代码库能零报错通过的结构性规则，后续按需逐条打开。
   */
  rules: {
    'no-var': 'error',
    eqeqeq: ['error', 'always'],
    'no-caller': 'error',
    'no-cond-assign': 'error',
    'no-const-assign': 'error',
    'no-constant-condition': 'error',
    'no-dupe-args': 'error',
    'no-dupe-keys': 'error',
    'no-duplicate-case': 'error',
    'no-eval': 'error',
    'no-ex-assign': 'error',
    'no-fallthrough': 'error',
    'no-func-assign': 'error',
    'no-implied-eval': 'error',
    'no-irregular-whitespace': 'error',
    'no-octal': 'error',
    'no-redeclare': 'error',
    'no-self-compare': 'error',
    'no-sparse-arrays': 'error',
    'no-throw-literal': 'error',
    'no-undef': 'error',
    'no-unreachable': 'error',
    'no-unsafe-negation': 'error',
    'no-unused-labels': 'error',
    'no-with': 'error',
    'use-isnan': 'error',
    'valid-typeof': 'error'
  }
}
