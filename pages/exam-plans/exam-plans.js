const user = require('../../utils/user.js')
const store = require('../../utils/store.js')
const config = require('../../utils/config.js')
const { runtimeCommerceClient } = require('../../utils/commerce-client.js')
const { createPreview } = require('../../utils/commerce-preview.js')
const dateText = at => {
  if (!Number.isSafeInteger(at)) return ''
  const d = new Date(at), pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const blank = () => ({ available: config.commercePreview === true, busy: false, loaded: false, logged: false, error: '', exam: null, plans: [], subscription: null,
  endText: '', demo: false, demoActive: false, demoEnd: '', selected: 30, answered: false, answerText: '' })
Page({
  data: blank(),
  onLoad() { this._client = runtimeCommerceClient(); this._generation = 0 },
  onShow() {
    this._active = true; const generation = ++this._generation
    this._preview = null; this.setData(blank())
    if (config.commercePreview !== true) return
    user.whenReady(() => {
      if (!this._active || generation !== this._generation) return
      if (!user.isLogged()) return
      this.setData({ logged: true }); this.refresh()
    })
  },
  onHide() { this._active = false; this._generation++; this._preview = null; this.setData(blank()) },
  onUnload() { this.onHide() },
  async refresh() {
    if (!this._active || this.data.busy || config.commercePreview !== true) return
    let ctx, examId
    try { ctx = this._client.capture(); examId = store.getCurrentExam() } catch (e) { this.setData({ error: '无法读取当前账号或考试，请重试。' }); return }
    if (!examId) { this.setData({ error: '请先在首页选择考试。' }); return }
    const generation = this._generation
    this.setData({ busy: true, loaded: false, error: '', plans: [], subscription: null, endText: '' })
    try {
      const result = await this._client.plans(examId, ctx)
      if (!this._active || generation !== this._generation || !this._client.current(ctx) || store.getCurrentExam() !== examId) return
      this.setData({ loaded: true, exam: result.exam, plans: result.plans.map(p => ({ ...p, price: (p.priceFen / 100).toFixed(2) })),
        subscription: result.subscription, endText: dateText(result.subscription.endAt) })
    } catch (e) {
      if (this._active && generation === this._generation && this._client.current(ctx)) this.setData({ error: '套餐或有效期读取失败，请检查网络后重试。' })
    } finally { if (this._active && generation === this._generation) this.setData({ busy: false }) }
  },
  goLogin() { user.promptLogin() },
  startDemo() { if (config.commercePreview !== true || !this._active) return; this._preview = createPreview(); this.setData({ demo: true, demoActive: false, demoEnd: '', selected: 30, answered: false, answerText: '' }) },
  selectTerm(e) { const n = Number(e.currentTarget.dataset.days); if ([30, 90, 365].includes(n)) this.setData({ selected: n }) },
  updateDemo(state) { this.setData({ demoActive: state.active, demoEnd: dateText(state.endAt), answered: false, answerText: '' }) },
  demoBuy() {
    if (!this._active || !this._preview) return
    try { this.updateDemo(this._preview.buy(this.data.selected)) } catch (e) { this.setData({ answerText: '演示次数已达上限，请结束后重新开始。' }) }
  },
  demoExpire() { if (this._active && this._preview) this.updateDemo(this._preview.expire()) },
  demoRefund() { if (this._active && this._preview) this.updateDemo(this._preview.refund()) },
  demoAnswer(e) {
    if (!this._active || !this._preview) return
    try { const result = this._preview.answer(e.currentTarget.dataset.choice); this.setData({ answered: true, answerText: result.correct ? '回答正确：先理解再练习，更有助于巩固。' : '再想一想：学习时先理解知识点，再通过练习巩固。' }) } catch (err) { this.setData({ demoActive: false, answerText: '演示期限已结束，请重新模拟开通。' }) }
  },
  exitDemo() { this._preview = null; this.setData({ demo: false, demoActive: false, demoEnd: '', answered: false, answerText: '' }) }
})
