const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
function setup(client) {
  let definition, navigated = ''
  const file = path.join(__dirname, '../pages/profile/profile.js')
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    Page: value => { definition = value }, getApp: () => ({}), wx: { navigateTo: opt => { navigated = opt.url } },
    require: name => name === '../../utils/catalog-admin.js' ? { runtimeClient: () => client }
      : name === '../../utils/storage-status.js' ? { storageStatusView: () => ({}), isStorageReadable: () => true } : {}
  })
  definition.setData = patch => Object.assign(definition.data, patch)
  definition._visible = true
  return { page: definition, navigated: () => navigated }
}
test('管理入口仅在当前身份确有角色时显示并导航', async () => {
  const client = { capture: () => ({ token: 'test' }), current: () => true, access: async () => ({ roles: ['editors'] }) }
  const p = setup(client); await p.page.refreshCatalogAccess()
  assert.equal(p.page.data.catalogAccess, true)
  p.page.goCatalogAdmin(); assert.equal(p.navigated(), '/pages/catalog-admin/catalog-admin')
  client.access = async () => ({ roles: [] }); await p.page.refreshCatalogAccess()
  assert.equal(p.page.data.catalogAccess, false)
  client.access = async () => { throw new Error('network') }; await p.page.refreshCatalogAccess()
  assert.equal(p.page.data.catalogAccess, false)
})
test('退出页面或切换身份后迟到的角色响应不能重新显示入口', async () => {
  let release, current = true
  const gate = new Promise(resolve => { release = resolve })
  const p = setup({ capture: () => ({}), current: () => current, access: () => gate })
  const pending = p.page.refreshCatalogAccess()
  p.page.onHide(); current = false; release({ roles: ['editors'] }); await pending
  assert.equal(p.page.data.catalogAccess, false)
})
