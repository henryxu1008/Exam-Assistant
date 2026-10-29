// pages/ai/ai.js
const app = getApp()
const ai = require('../../utils/ai.js')
const store = require('../../utils/store.js')

const QUICK = [
  '我哪里最薄弱',
  '帮我制定今天的学习计划',
  '错题怎么复习',
  '我的正确率多少',
  '有什么记忆口诀'
]

Page({
  data: {
    messages: [],
    quick: QUICK,
    input: '',
    loading: false,
    scrollTo: ''
  },

  onLoad() {
    const list = store.getAiMessages().map((m) => this._decorate(m))
    if (!list.length) {
      list.push(
        this._decorate({
          role: 'ai',
          text: '你好，我是你的 AI 学习助教。我会结合你的真实答题记录给出建议。',
          bullets: ['可以直接问我：哪里最薄弱 / 制定计划 / 错题怎么复习 / 我的正确率'],
          cards: [
            { text: '薄弱诊断', action: 'diagnose' },
            { text: '今日计划', action: 'plan' }
          ],
          time: Date.now()
        })
      )
    }
    this.setData({ messages: list }, () => this._scrollToLast(list.length))
  },

  onShow() {
    // 其他页面（错题本 / 学情报告 / 练习页）携带问题跳转过来
    const pre = app.globalData.aiPreInput
    if (!pre) return
    const context = app.globalData.aiContext || {}
    app.globalData.aiPreInput = ''
    app.globalData.aiContext = null
    this.setData({ input: pre })
    this.send(pre, context)
  },

  /* ---------------- 收发 ---------------- */

  onInput(e) {
    this.setData({ input: e.detail.value })
  },

  onSend() {
    this.send(this.data.input, {})
  },

  onQuick(e) {
    this.send(e.currentTarget.dataset.text, {})
  },

  send(text, context) {
    const content = String(text || '').trim()
    if (!content || this.data.loading) return

    const messages = this.data.messages.concat([
      this._decorate({ role: 'user', text: content, bullets: [], cards: [], time: Date.now() })
    ])
    this.setData({ messages, input: '', loading: true }, () => this._scrollToLast(messages.length))
    store.pushAiMessage({ role: 'user', text: content, bullets: [], cards: [] })

    const self = this
    setTimeout(() => {
      const result = ai.chat(content, context || {})
      const extra = result.extra || null
      const reply = {
        role: 'ai',
        text: result.reply,
        bullets: result.bullets || [],
        cards: result.cards || [],
        mnemonic: extra ? extra.mnemonic : '',
        similar: extra ? extra.similar : [],
        time: Date.now()
      }
      const next = self.data.messages.concat([self._decorate(reply)])
      self.setData({ messages: next, loading: false }, () => self._scrollToLast(next.length))
      store.pushAiMessage(reply)
    }, 420)
  },

  /* ---------------- 卡片动作 ---------------- */

  onCard(e) {
    const action = e.currentTarget.dataset.action
    const self = this
    if (action === 'practice-weak') app.startPractice({ mode: 'weak' })
    else if (action === 'practice-random') app.startPractice({ mode: 'random' })
    else if (action === 'review-due') app.startPractice({ mode: 'review' })
    else if (action === 'goto-analysis') wx.navigateTo({ url: '/pages/analysis/analysis' })
    else if (action === 'goto-mistakes') wx.switchTab({ url: '/pages/mistakes/mistakes' })
    else if (action === 'diagnose') self.send('我哪里最薄弱', {})
    else if (action === 'plan') self.send('帮我制定今天的学习计划', {})
    else if (action === 'mnemonic') wx.showToast({ title: '见上方记忆口诀', icon: 'none' })
    else if (action === 'similar') wx.showToast({ title: '见上方举一反三', icon: 'none' })
  },

  /** 点击「举一反三」中的题目：单题重练 */
  onSimilar(e) {
    app.startPractice({ mode: 'single', ids: [e.currentTarget.dataset.id] })
  },

  onClear() {
    const self = this
    wx.showModal({
      title: '清空对话',
      content: '将删除本机保存的全部对话记录',
      confirmText: '清空',
      confirmColor: '#e5484d',
      success(res) {
        if (!res.confirm) return
        store.clearAiMessages()
        self.setData({ messages: [], loading: false }, () => self.onLoad())
      }
    })
  },

  /* ---------------- 工具 ---------------- */

  _decorate(msg) {
    this._seq = (this._seq || 0) + 1
    return Object.assign({}, msg, {
      mid: msg.mid || `m${this._seq}`,
      bullets: msg.bullets || [],
      cards: msg.cards || [],
      similar: msg.similar || [],
      timeText: this._timeText(msg.time || Date.now())
    })
  },

  _timeText(ts) {
    const d = new Date(ts)
    const h = `${d.getHours()}`.padStart(2, '0')
    const m = `${d.getMinutes()}`.padStart(2, '0')
    return `${h}:${m}`
  },

  _scrollToLast(len) {
    if (!len) return
    this.setData({ scrollTo: `msg-${len - 1}` })
  }
})
