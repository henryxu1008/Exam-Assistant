/**
 * Issue 4：judge 纯函数边界测试
 * 覆盖 single / multiple / judge / uncertain / fill / sort 六类题型的判分边界与正反例。
 * judge 不依赖任何 wx API，可在无微信运行时直接测试。
 */
const { test } = require('node:test')
const assert = require('node:assert')
const bank = require('../utils/bank/index.js')

const { judge, normalizeText } = bank

// ---- 单选 single：集合相等 ----
test('single 答对', () => assert.strictEqual(judge('single', ['A'], ['A']), true))
test('single 答错', () => assert.strictEqual(judge('single', ['B'], ['A']), false))
test('single 未选 -> 错', () => assert.strictEqual(judge('single', [], ['A']), false))
test('single 多选项 -> 错', () => assert.strictEqual(judge('single', ['A', 'B'], ['A']), false))

// ---- 多选 multiple：集合相等（少选/多选均错） ----
test('multiple 完全正确', () => assert.strictEqual(judge('multiple', ['A', 'B'], ['A', 'B']), true))
test('multiple 顺序无关', () => assert.strictEqual(judge('multiple', ['B', 'A'], ['A', 'B']), true))
test('multiple 少选 -> 错', () => assert.strictEqual(judge('multiple', ['A'], ['A', 'B']), false))
test('multiple 多选 -> 错', () => assert.strictEqual(judge('multiple', ['A', 'B', 'C'], ['A', 'B']), false))

// ---- 判断 judge：集合相等 ----
test('judge 答对', () => assert.strictEqual(judge('judge', ['A'], ['A']), true))
test('judge 答错', () => assert.strictEqual(judge('judge', ['B'], ['A']), false))

// ---- 不定项 uncertain：集合相等（部分选对也错） ----
test('uncertain 全对', () => assert.strictEqual(judge('uncertain', ['A', 'B'], ['A', 'B']), true))
test('uncertain 部分选 -> 错', () => assert.strictEqual(judge('uncertain', ['A'], ['A', 'B']), false))
test('uncertain 多选 -> 错', () => assert.strictEqual(judge('uncertain', ['A', 'B', 'C'], ['A', 'B']), false))

// ---- 填空 fill：逐空比对，支持同义数组、忽略大小写与空白 ----
test('fill 精确', () => assert.strictEqual(judge('fill', ['北京'], ['北京']), true))
test('fill 同义数组命中', () =>
  assert.strictEqual(judge('fill', ['USA'], [['美国', 'USA', '美利坚']]), true))
test('fill 不区分大小写与空白', () =>
  assert.strictEqual(judge('fill', ['  BeiJing '], ['Beijing']), true))
test('fill 空位长度不一致 -> 错', () => assert.strictEqual(judge('fill', ['a'], ['a', 'b']), false))
test('fill 空答案 -> 错', () => assert.strictEqual(judge('fill', ['  '], ['a']), false))
test('fill 多空全部命中', () =>
  assert.strictEqual(judge('fill', ['a', 'b'], ['a', ['B', 'b']]), true))
test('fill 多空有一空错 -> 错', () =>
  assert.strictEqual(judge('fill', ['a', 'x'], ['a', ['B', 'b']]), false))

// ---- 排序 sort：顺序全等 ----
test('sort 顺序正确', () => assert.strictEqual(judge('sort', ['A', 'B', 'C'], ['A', 'B', 'C']), true))
test('sort 顺序错误 -> 错', () => assert.strictEqual(judge('sort', ['B', 'A'], ['A', 'B']), false))
test('sort 长度不一致 -> 错', () => assert.strictEqual(judge('sort', ['A'], ['A', 'B']), false))

// ---- 归一化辅助 ----
test('normalizeText 去空白转小写', () => assert.strictEqual(normalizeText(' A b '), 'ab'))
