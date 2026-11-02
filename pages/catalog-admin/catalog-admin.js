const user = require('../../utils/user.js')
const { runtimeClient } = require('../../utils/catalog-admin.js')
const utf8Bytes = value => encodeURIComponent(value).replace(/%[A-F0-9]{2}/g, 'x').length
const blank = () => ({ roles: [], canEdit: false, canReview: false, canPublish: false, roleText: '', allowed: false, busy: false, inputText: '', format: 'json', report: '', ready: false,
  rightsConfirmed: false, sourceVerified: false, submissionId: '', draftId: '', note: '', revision: '', removeIds: '', preview: '', result: '', error: '' })
Page({
  data: blank(),
  onLoad() { this._client = runtimeClient(); this._generation = 0 },
  onShow() {
    this._active = true
    this._generation += 1
    this.setData({ allowed: false, busy: false })
    const generation = this._generation
    user.requireLogin(() => {
      if (!this._active || generation !== this._generation) return
      let ctx
      try { ctx = this._client.capture() } catch (e) { this.setData(blank()); return }
      if (!this._context || this._context.openid !== ctx.openid || this._context.token !== ctx.token) { this._prepared = null; this._draft = null; this.setData(blank()) }
      this._context = ctx
      this.setData({ busy: false, allowed: false })
      this._run(() => this._client.access(), result => {
        const roles = Array.isArray(result.roles) ? result.roles : []
        this.setData({ roles, roleText: roles.join(' / '), allowed: roles.length > 0, canEdit: roles.includes('editors'), canReview: roles.includes('reviewers'), canPublish: roles.includes('publishers') })
      })
    })
  },
  onHide() { this._active = false; this._generation += 1 },
  onUnload() { this.onHide(); this._prepared = null; this._draft = null; this._context = null },
  async _run(task, apply) {
    if (this.data.busy || !this._active || !this._context || !this._client.current(this._context)) return
    const generation = this._generation, ctx = this._context
    const live = () => this._active && generation === this._generation && ctx && this._client.current(ctx)
    this.setData({ busy: true, error: '', result: '' })
    try {
      const result = await task()
      if (live()) { if (apply) apply(result); else this.setData({ result: JSON.stringify(result, null, 2) }) }
    } catch (e) { if (live()) this.setData({ error: /^[A-Z_]+$/.test(e.code || '') ? e.code : 'OPERATION_FAILED' }) }
    finally { if (live()) this.setData({ busy: false }) }
  },
  onInput(e) {
    if (this.data.busy) return
    const field = e.currentTarget.dataset.field
    if (!['inputText', 'submissionId', 'draftId', 'note', 'revision', 'removeIds'].includes(field)) return
    if (field === 'inputText' && utf8Bytes(e.detail.value) > 200000) {
      this._prepared = null; this.setData({ inputText: '', ready: false, report: '', rightsConfirmed: false, error: 'INPUT_TOO_LARGE_FOR_PAGE' }); return
    }
    this.setData({ [field]: e.detail.value })
    if (field === 'inputText') { this._prepared = null; this.setData({ ready: false, report: '', rightsConfirmed: false }) }
    if (field === 'draftId') { this._draft = null; this.setData({ preview: '', sourceVerified: false, revision: '' }) }
  },
  onFormat(e) { if (this.data.busy) return; this._prepared = null; this.setData({ format: e.currentTarget.dataset.format, ready: false, report: '', rightsConfirmed: false }) },
  onConfirm(e) {
    if (this.data.busy) return
    const values = e.detail.value || []
    const field = e.currentTarget && e.currentTarget.dataset.field
    if (field === 'rights') this.setData({ rightsConfirmed: values.includes('rights') })
    else if (field === 'sources') this.setData({ sourceVerified: values.includes('sources') })
    else this.setData({ rightsConfirmed: values.includes('rights'), sourceVerified: values.includes('sources') })
  },
  onCheck() {
    if (this.data.busy) return
    const { prepared, ...report } = this._client.preflight(this.data.inputText, this.data.format)
    this._prepared = prepared || null
    this.setData({ ready: report.ok, report: JSON.stringify(report, null, 2) })
  },
  onSubmit() {
    if (!this._prepared) { this.setData({ error: 'PREFLIGHT_REQUIRED' }); return }
    this._run(() => this._client.submitDraft(this._prepared, { submissionId: this.data.submissionId, rightsConfirmed: this.data.rightsConfirmed }), result => {
      this._draft = null; this.setData({ draftId: result.draftId, preview: '', sourceVerified: false, result: JSON.stringify(result, null, 2) })
    })
  },
  onReadDraft() { this._run(() => this._client.getDraft(this.data.draftId), result => {
    const preview = JSON.stringify(result.draft)
    if (utf8Bytes(preview) > 400000) { this._draft = null; this.setData({ preview: '', sourceVerified: false, error: 'DRAFT_TOO_LARGE_FOR_PAGE' }); return }
    this._draft = result.draft; this.setData({ preview, sourceVerified: false })
  }) },
  onReview(e) {
    if (!this._draft || this._draft.draftId !== this.data.draftId) { this.setData({ error: 'READ_DRAFT_REQUIRED' }); return }
    this._run(() => this._client.review({ draftId: this.data.draftId, decision: e.currentTarget.dataset.decision, note: this.data.note, sourceVerified: this.data.sourceVerified })) },
  onReadRevision() { this._run(() => this._client.published(), result => this.setData({ revision: String(result.publicationRevision) })) },
  onPublish() {
    if (!this._draft || this._draft.draftId !== this.data.draftId) { this.setData({ error: 'READ_DRAFT_REQUIRED' }); return }
    if (!/^\d+$/.test(this.data.revision)) { this.setData({ error: 'BAD_REVISION' }); return }
    this._run(() => this._client.publish({ draftId: this.data.draftId, expectedRevision: Number(this.data.revision) }))
  },
  onWithdraw() {
    this._run(() => this._client.withdraw({ draftId: this.data.draftId, questionIds: this.data.removeIds.split(/[,，\s]+/).filter(Boolean),
      submissionId: this.data.submissionId, rightsConfirmed: this.data.rightsConfirmed }), result => { this._draft = null; this.setData({ draftId: result.draftId, preview: '', sourceVerified: false, result: JSON.stringify(result, null, 2) }) })
  }
})
