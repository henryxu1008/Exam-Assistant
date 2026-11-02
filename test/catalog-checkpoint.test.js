const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createCatalogCheckpoint } = require('../utils/catalog-checkpoint.js')
function storage() {
  const data = new Map(), fail = { read: false, write: false, afterWrite: false, remove: false }
  return { data, fail, getStorageSync: key => { if (fail.read) throw new Error('read'); return data.has(key) ? JSON.parse(JSON.stringify(data.get(key))) : '' },
    setStorageSync: (key, value) => { if (fail.write) throw new Error('write'); data.set(key, JSON.parse(JSON.stringify(value))); if (fail.afterWrite) throw new Error('after write') },
    removeStorageSync: key => { if (fail.remove) throw new Error('remove'); data.delete(key) } }
}
const ui = value => ({ form: { stem: value }, editorDirty: true, questionFormDirty: true })
const workspace = value => ({ bank: { schemaVersion: 3, manifest: { exams: [], subjects: [] }, questions: {} }, sources: { value }, basePublication: null })

test('表单与完整工作区分开保存，重启恢复最新内容且账号隔离', () => {
  const wx = storage(), a = createCatalogCheckpoint(wx, 'alice'), b = createCatalogCheckpoint(wx, 'bob')
  let token = a.create(workspace('original'), ui('first'))
  token = a.saveForm(token, ui('second'))
  assert.equal(a.read().ui.form.stem, 'second')
  assert.equal(b.read(), null)
  token = a.saveWorkspace(token, workspace('new'), ui('third'))
  const again = createCatalogCheckpoint(wx, 'alice').read()
  assert.equal(again.workspace.sources.value, 'new'); assert.equal(again.ui.form.stem, 'third')
  assert.deepEqual(again.token, token)
})

test('过时页面不能覆盖最新表单或工作区，读写故障不变成空白数据', () => {
  const wx = storage(), a = createCatalogCheckpoint(wx, 'alice'), b = createCatalogCheckpoint(wx, 'alice')
  let token = a.create(workspace('kept'), ui('before')), stale = b.read().token
  token = a.saveForm(token, ui('new'))
  assert.throws(() => b.saveWorkspace(stale, workspace('lost'), ui('stale')), /LOCAL_DRAFT_CHANGED/)
  wx.fail.write = true
  assert.throws(() => a.saveWorkspace(token, workspace('lost'), ui('lost')), /LOCAL_DRAFT_WRITE_FAILED/)
  wx.fail.write = false
  assert.equal(a.read().workspace.sources.value, 'kept'); assert.equal(a.read().ui.form.stem, 'new')
  wx.fail.read = true; assert.throws(() => a.read(), /LOCAL_DRAFT_READ_FAILED/)
})

test('写后报错通过读回识别已提交；损坏数据与超限均明确拒绝', () => {
  const wx = storage(), a = createCatalogCheckpoint(wx, 'alice')
  wx.fail.afterWrite = true
  const token = a.create(workspace('kept'), ui('before'))
  wx.fail.afterWrite = false
  assert.deepEqual(a.read().token, token)
  assert.throws(() => a.saveForm(token, ui('x'.repeat(100001))), /LOCAL_DRAFT_TOO_LARGE/)
  const rootKey = [...wx.data.keys()][0]; wx.data.get(rootKey).revision = 'broken'
  assert.throws(() => a.read(), /LOCAL_DRAFT_INVALID/)
})

test('结构看似正确但内容损坏的工作区和表单不能恢复', () => {
  const wx = storage(), a = createCatalogCheckpoint(wx, 'alice')
  const token = a.create(workspace('before'), ui('before'))
  a.saveForm(token, ui('new'))
  const keys = [...wx.data.keys()], root = wx.data.get(keys[0]), overlay = wx.data.get(keys[1])
  root.workspace.sources.value = 'corrupted'
  assert.throws(() => a.read(), /LOCAL_DRAFT_INVALID/)
  root.workspace.sources.value = 'before'; overlay.ui.form.stem = 'corrupted'
  assert.throws(() => a.read(), /LOCAL_DRAFT_INVALID/)
})
