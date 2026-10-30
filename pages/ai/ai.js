// pages/ai/ai.js
const app = getApp()
const ai = require('../../utils/ai.js')
const store = require('../../utils/store.js')
const user = require('../../utils/user.js')

const QUICK = [
  '我哪里最薄弱',
  '帮我制定今天的学习计划',
  '错题怎么复习',
  '我的正确率多少',
  '有什么记忆口诀'
]

/** 本地规则引擎模拟「思考中」的等待耗时（毫秒） */
const REPLY_DELAY = 420

Page({
  data: {
    messages: [],
    quick: QUICK,
    input: '',
    loading: false,
    scrollTo: ''
  },

  onLoad() {
    this._resetMessages()
  },

  /** 载入历史消息（无历史时用欢迎语兜底），供 onLoad 与清空对话后复用 */
  _resetMessages() {
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
    this.setData({ messages: list, loading: false }, () => this._scrollToLast(list.length))
  },

  onShow() {
    // 未登录时先去登录页，回来后再消费其他页面带来的预填内容
    if (!user.requireLogin()) return
    // 其他页面（错题本 / 学情报告 / 练习页）携带问题跳转过来
    const pre = app.globalData.aiPreInput
    if (!pre) return
    const context = app.globalData.aiContext || {}
    app.globalData.aiPreInput = ''
    app.globalData.aiContext = null
    this.setData({ input: pre })
    this.send(pre, context)
  },

  onUnload() {
    this._reqToken = (this._reqToken || 0) + 1 // 作废在途请求，避免回页面后窜改状态
    this._clearReplyTimer()
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

    // 请求令牌：每次发送递增；在途响应若令牌已变化（被清空/新消息）则视为过期，丢弃，避免窜改状态/存储
    this._reqToken = (this._reqToken || 0) + 1
    const token = this._reqToken

    const messages = this.data.messages.concat([
      this._decorate({ role: 'user', text: content, bullets: [], cards: [], time: Date.now() })
    ])
    this.setData({ messages, input: '', loading: true }, () => this._scrollToLast(messages.length))
    store.pushAiMessage({ role: 'user', text: content, bullets: [], cards: [] })

    const self = this
    // 个性化查询（正确率/薄弱/计划/错题/记忆方法）依赖真实答题数据，必须走本地引擎，
    // 否则远程大模型无数据只能泛泛而谈；其余走真实大模型，未开启/失败回落本地规则引擎
    // （评审 P2：Include learning statistics in personalized remote AI requests）
    if (ai.isPersonalizedQuery(content)) {
      self._localReply(token, content, context || {})
      return
    }
    ai
      .requestLLM(
        messages.slice(-6).map((m) => ({ role: m.role, content: m.text })),
        store.getCurrentSubject(),
        context || {} // 含 questionId/userAnswer，供远端大模型看到题目（评审 P2）
      )
      .then((remote) => {
        if (token !== self._reqToken) return // 已过期，丢弃
        if (remote) {
          self._applyReply(token, { reply: remote, bullets: [], cards: [] })
          return
        }
        self._localReply(token, content, context || {}) // 本地引擎回落
      })
      .catch(() => {
        if (token !== self._reqToken) return
        self._localReply(token, content, context || {}) // 远程异常时回落本地
      })
  },

  /** 走本地规则引擎生成回复（带「打字中」等待感），并写入状态/持久化 */
  _localReply(token, content, context) {
    const self = this
    if (token !== self._reqToken) return
    self._replyTimer = setTimeout(() => {
      self._replyTimer = null
      if (token !== self._reqToken) return
      self._applyReply(token, ai.chat(content, context || {}))
    }, REPLY_DELAY)
  },

  /** 把本地/远端回复写入页面状态与持久化 */
  _applyReply(token, result) {
    const self = this
    if (token !== self._reqToken) return // 已过期（被清空/新消息），不更新状态
    if (!result) return
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
        self._reqToken = (self._reqToken || 0) + 1 // 作废在途请求，避免陈旧响应写回已清空对话
        self._clearReplyTimer()
        self._resetMessages()
      }
    })
  },

  /* ---------------- 工具 ---------------- */

  /** 取消尚未触发的本地回复定时器，避免离页后仍执行 setData */
  _clearReplyTimer() {
    if (!this._replyTimer) return
    clearTimeout(this._replyTimer)
    this._replyTimer = null
  },

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
