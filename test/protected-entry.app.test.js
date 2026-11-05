require('./wx-shim.js')
const { test } = require('node:test')
const assert = require('node:assert/strict')
const config = require('../utils/config.js')
const protectedCatalog = require('../utils/protected-catalog.js')
let app
global.App = definition => { app = definition }
require('../app.js')
test('统一入口拒绝无考试、无效参数及尚未支持的模式，仅有效科目进入在线练习', t => {
  const original = config.protectedCatalog; config.protectedCatalog = true
  t.after(() => { config.protectedCatalog = original })
  let exam = '', navigated = '', switched = '', message = ''
  t.mock.method(protectedCatalog, 'currentExam', () => exam)
  t.mock.method(app, 'guardEntry', () => false)
  const old = { navigateTo: wx.navigateTo, switchTab: wx.switchTab, showToast: wx.showToast }
  t.after(() => Object.assign(wx, old))
  wx.navigateTo = ({ url }) => { navigated = url }
  wx.switchTab = ({ url }) => { switched = url }
  wx.showToast = ({ title }) => { message = title }
  app.startPractice({ mode: 'all' }); assert.match(message, /选择考试/); assert.match(switched, /index/)
  exam = 'exam_a'; app.startPractice({ mode: 'review' }); assert.match(message, /暂未开放/); assert.equal(navigated, '')
  app.startPractice({ mode: 'all', subject: '../bad' }); assert.match(message, /无效/); assert.equal(navigated, '')
  app.startPractice({ mode: 'all', subject: 'subject_a' }); assert.match(navigated, /subject=subject_a/)
  navigated = ''; app.startPractice({ mode: 'single', ids: ['one', 'two'] }); assert.equal(navigated, '')
  app.startPractice({ mode: 'single', ids: ['one'] }); assert.match(navigated, /questionId=one/)
})
