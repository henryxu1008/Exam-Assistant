const user = require('../../utils/user.js')
const { runtimeCommerceAdmin } = require('../../utils/commerce-admin.js')
const { sha256 } = require('../../shared/question-domain.js')
const errors = { NOT_ADMIN: '当前账号没有商品管理权限。', NETWORK_ERROR: '网络或服务暂不可用，请重试。',
  EXAM_NOT_FOUND: '考试已不在当前发布中，请重新载入。', INVALID_PUBLISHED_CATALOG: '已发布题库校验失败，请先核查题库。',
  STALE_PRODUCT: '商品已被修改，请重新载入后核对。', INVALID_PRODUCT: '商品数据异常，请联系管理员核查。',
  BAD_PRODUCT: '请检查名称、价格和使用天数。', UNSAVED_CHANGES: '请先保存或放弃当前修改。', COMMERCE_FAILED: '读取或保存失败，请重试。' }
const blank = () => ({ busy: false, allowed: false, exams: [], selected: '', selectedName: '', loaded: false, dirty: false,
  name: '', price: '', days: '180', active: false, revision: 0, error: '', message: '', errors })
Page({
  data: blank(),
  onLoad() { this._client = runtimeCommerceAdmin(); this._generation = 0 },
  onShow() {
    this._active = true; const generation = ++this._generation
    this.setData(blank())
    user.requireAccount(() => {
      if (!this._active || generation !== this._generation) return
      try { this._context = this._client.capture() } catch (e) { this.setData({ error: 'NO_TOKEN' }); return }
      this._run(() => this._client.catalog(), result => this.setData({ allowed: true, exams: result.exams }))
    })
  },
  onHide() { this._active = false; this._generation++; this._context = null; this.setData(blank()) },
  onUnload() { this.onHide() },
  async _run(task, apply) {
    if (this.data.busy || !this._active || !this._context || !this._client.current(this._context)) return
    const generation = this._generation, ctx = this._context
    const live = () => this._active && this._generation === generation && this._client.current(ctx)
    this.setData({ busy: true, error: '', message: '' })
    try { const result = await task(); if (live()) apply(result) }
    catch (e) { if (live()) this.setData({ error: /^[A-Z_]+$/.test(e.code || '') ? e.code : 'COMMERCE_FAILED' }) }
    finally { if (live()) this.setData({ busy: false }) }
  },
  onSelect(e) {
    if (this.data.busy) return
    const exam = this.data.exams.find(item => item.id === e.currentTarget.dataset.id)
    if (!exam || exam.id === this.data.selected) return
    if (this.data.dirty) { this.setData({ error: 'UNSAVED_CHANGES' }); return }
    this.setData({ selected: exam.id, selectedName: exam.name, loaded: false, name: '', price: '', days: '180', active: false, revision: 0 })
    this._loadProduct(exam)
  },
  _loadProduct(exam) {
    this._run(() => this._client.product(exam.id), result => {
      const p = result.product
      this.setData({ loaded: true, dirty: false, name: p ? p.name : exam.name, price: p ? (p.priceFen / 100).toFixed(2) : '',
        days: p ? String(p.durationDays) : '180', active: !!(p && p.active), revision: p ? p.revision : 0 })
    })
  },
  onDiscard() { if (!this.data.busy && this.data.selected) { const exam = this.data.exams.find(e => e.id === this.data.selected); if (exam) this._loadProduct(exam) } },
  onInput(e) {
    if (this.data.busy || !this.data.loaded || !['name', 'price', 'days'].includes(e.currentTarget.dataset.field)) return
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value, dirty: true, error: '', message: '' })
  },
  onActive(e) { if (!this.data.busy && this.data.loaded) this.setData({ active: !!e.detail.value, dirty: true, error: '', message: '' }) },
  onSave() {
    if (this.data.busy || !this.data.loaded) return
    const price = this.data.price.trim(), days = this.data.days.trim()
    if (!/^(?:0|[1-9]\d{0,5})(?:\.\d{1,2})?$/.test(price) || !/^[1-9]\d{0,3}$/.test(days)) { this.setData({ error: 'BAD_PRODUCT' }); return }
    const parts = price.split('.'), priceFen = Number(parts[0]) * 100 + Number(((parts[1] || '') + '00').slice(0, 2))
    const product = { id: 'exam_' + sha256(this.data.selected).slice(0, 24), examId: this.data.selected,
      name: this.data.name.trim(), priceFen, durationDays: Number(days), active: this.data.active }
    const revision = this.data.revision
    this._run(() => this._client.save(product, revision), result => this.setData({ revision: result.product.revision, dirty: false, message: '商品配置已保存。当前暂未开放购买。' }))
  }
})
