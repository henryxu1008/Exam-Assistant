// pages/analysis/analysis.js
const app = getApp()
const bank = require('../../utils/questions.js')
const store = require('../../utils/store.js')
const analytics = require('../../utils/analytics.js')
const chart = require('../../utils/chart.js')
const ai = require('../../utils/ai.js')

Page({
  data: {
    overview: {
      total: 0,
      correct: 0,
      rate: 0,
      todayTotal: 0,
      todayCorrect: 0,
      todayRate: 0,
      wrongCount: 0,
      stubbornCount: 0,
      dueCount: 0,
      streakDays: 0,
      chapterCount: 0
    },
    hasData: false,
    radar: { labels: [], values: [] },
    radarList: [],
    trend: { labels: [], values: [] },
    trendTable: [],
    barItems: [],
    chapters: [],
    weak: [],
    strong: [],
    stubborn: [],
    advice: []
  },

  onShow() {
    this.refresh()
  },

  onPullDownRefresh() {
    this.refresh()
    wx.stopPullDownRefresh()
  },

  refresh() {
    const overview = analytics.overview()
    const hasData = overview.total > 0

    const radarRaw = analytics.radarData(6)
    const trendRaw = analytics.trendData(7)
    const chapters = analytics.chapterStats().slice(0, 8)

    const trendTable = trendRaw.map((t) =>
      Object.assign({}, t, {
        barClass: t.total === 0 ? '' : t.rate >= 85 ? 'green' : t.rate >= 60 ? '' : 'red'
      })
    )

    this.setData(
      {
        overview,
        hasData,
        radar: {
          labels: radarRaw.map((i) => i.name),
          values: radarRaw.map((i) => i.value)
        },
        radarList: radarRaw.map((i) => ({
          name: i.fullName,
          value: i.value,
          barClass: i.value >= 85 ? 'green' : i.value >= 60 ? '' : 'red'
        })),
        trend: {
          labels: trendRaw.map((i) => i.date),
          values: trendRaw.map((i) => (i.total ? i.rate : 0))
        },
        trendTable,
        barItems: chapters.map((c) => ({ label: c.chapter, value: c.rate })),
        chapters: chapters.map((c) =>
          Object.assign({}, c, {
            key: `${c.subject}|${c.chapter}`,
            barClass: c.rate >= 85 ? 'green' : c.rate >= 60 ? '' : 'red',
            masteryText: `${c.mastery}%`
          })
        ),
        weak: analytics.weakPoints(5).map((w) => Object.assign({}, w, { key: `${w.subject}|${w.chapter}` })),
        strong: analytics.strongPoints(3).map((s) => Object.assign({}, s, { key: `${s.subject}|${s.chapter}` })),
        stubborn: analytics.stubbornQuestions(5).map((s) => ({
          id: s.question.id,
          stem: s.question.stem,
          chapter: s.question.chapter,
          subject: s.question.subject,
          wrong: s.record.wrong,
          days: s.days
        })),
        advice: ai.studyAdvice()
      },
      () => {
        if (hasData) this.drawCharts()
      }
    )
  },

  drawCharts() {
    if (this.data.radar.values.length >= 3) {
      chart.renderRadar(this, '#radar', this.data.radar)
    }
    chart.renderLine(this, '#trend', this.data.trend)
    if (this.data.barItems.length) {
      chart.renderBars(this, '#bars', { items: this.data.barItems })
    }
  },

  /* ---------------- 事件 ---------------- */

  onChapterPractice(e) {
    const subject = e.currentTarget.dataset.subject || ''
    const chapter = e.currentTarget.dataset.chapter || ''
    if (!chapter) return
    app.startPractice({ mode: 'chapter', subject, chapter })
  },

  onWeakPractice() {
    app.startPractice({ mode: 'weak' })
  },

  onRedo(e) {
    app.startPractice({ mode: 'single', ids: [e.currentTarget.dataset.id] })
  },

  onAi(e) {
    const id = e.currentTarget.dataset.id
    const q = bank.findQuestion(id)
    if (!q) return
    app.globalData.aiPreInput = '这道题怎么解？'
    app.globalData.aiContext = { questionId: q.id, userAnswer: [] }
    wx.switchTab({ url: '/pages/ai/ai' })
  },

  goPractice() {
    app.startPractice({ mode: 'random' })
  },

  goMistakes() {
    wx.switchTab({ url: '/pages/mistakes/mistakes' })
  },

  goReview() {
    app.startPractice({ mode: 'review' })
  }
})
