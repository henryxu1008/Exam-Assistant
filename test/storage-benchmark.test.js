const { test } = require('node:test')
const assert = require('node:assert/strict')
const { run } = require('../scripts/benchmark-learning-storage.js')
test('存储基线运行真实提交路径，保留全部合成历史并记录整档写入，不访问云', () => {
  const result = run({ sizes: [10], runs: 1 })
  assert.equal(result.cloudCalls, 0)
  assert.equal(result.scenarios.length, 2)
  for (const scenario of result.scenarios) {
    assert.equal(scenario.dataWritesPerAnswer, 1)
    assert.equal(scenario.aiWritesPerAnswer, 0)
    assert.ok(scenario.migrationMaxEntryBytes < 900 * 1024)
    assert.ok(scenario.afterBytes > scenario.beforeBytes)
    assert.equal(scenario.writtenBytesPerAnswer, scenario.afterBytes)
    assert.ok(scenario.submitP50Ms >= 0)
  }
  assert.ok(result.scenarios[1].afterBytes > result.scenarios[0].afterBytes)
})
