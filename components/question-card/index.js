// components/question-card/index.js
const bank = require('../../utils/questions.js')

Component({
  options: {
    multipleSlots: true
  },

  properties: {
    question: {
      type: Object,
      value: null
    },
    // 用户已选选项（数组，支持多选）；填空为字符串数组；排序为有序 key 数组
    selected: {
      type: Array,
      value: []
    },
    submitted: {
      type: Boolean,
      value: false
    },
    starred: {
      type: Boolean,
      value: false
    },
    index: {
      type: Number,
      value: 0
    },
    total: {
      type: Number,
      value: 0
    }
  },

  data: {
    type: 'single',
    typeName: '单选题',
    levelText: '',
    resultText: '',
    isRight: false,
    options: [],
    blanks: [],
    sortedList: []
  },

  observers: {
    'question, selected, submitted': function () {
      this._derive()
    }
  },

  lifetimes: {
    attached() {
      this._derive()
    }
  },

  methods: {
    _derive() {
      const q = this.data.question
      if (!q) {
        this.setData({ options: [], blanks: [], sortedList: [] })
        return
      }

      const type = q.type || 'single'
      const selected = Array.isArray(this.data.selected) ? this.data.selected.slice() : []
      const answer = Array.isArray(q.answer) ? q.answer.slice() : []
      const submitted = !!this.data.submitted
      const isRight = bank.judge(type, selected, answer)

      const patch = {
        type,
        typeName: bank.typeName(type),
        levelText: ['', '基础', '进阶', '拔高'][q.level] || '基础',
        isRight,
        resultText: this._resultText(type, selected, answer, submitted, isRight)
      }

      if (type === 'fill') {
        Object.assign(patch, this._deriveFill(answer, selected, submitted))
      } else if (type === 'sort') {
        Object.assign(patch, this._deriveSort(q, answer, selected, submitted))
      } else {
        Object.assign(patch, this._deriveChoice(q, answer, selected, submitted))
      }

      this.setData(patch)
    },

    /** 单选 / 多选 / 判断 / 不定项 */
    _deriveChoice(q, answer, selected, submitted) {
      return {
        blanks: [],
        sortedList: [],
        options: (q.options || []).map((opt) => {
          const isAnswer = answer.indexOf(opt.key) > -1
          const isPicked = selected.indexOf(opt.key) > -1
          let state = ''
          let icon = ''
          if (submitted) {
            if (isAnswer) {
              state = 'correct'
              icon = '✓'
            } else if (isPicked) {
              state = 'wrong'
              icon = '✕'
            }
          } else if (isPicked) {
            state = 'picked'
          }
          return { key: opt.key, text: opt.text, state, icon, order: 0 }
        })
      }
    },

    /** 填空 */
    _deriveFill(answer, selected, submitted) {
      return {
        options: [],
        sortedList: [],
        blanks: answer.map((expect, i) => {
          const expects = Array.isArray(expect) ? expect : [expect]
          const got = selected[i] === undefined || selected[i] === null ? '' : String(selected[i])
          let state = ''
          if (submitted) {
            state = expects.some((e) => bank.normalizeText(e) === bank.normalizeText(got)) ? 'correct' : 'wrong'
          } else if (String(got).trim()) {
            state = 'picked'
          }
          return { index: i, value: got, state, answerText: expects[0] }
        })
      }
    },

    /** 排序 */
    _deriveSort(q, answer, selected, submitted) {
      const pool = q.options || []
      return {
        blanks: [],
        sortedList: selected
          .map((k) => pool.filter((o) => o.key === k)[0])
          .filter(Boolean)
          .map((o, i) => ({ key: o.key, text: o.text, order: i + 1 })),
        options: pool.map((opt) => {
          const userPos = selected.indexOf(opt.key)
          const ansPos = answer.indexOf(opt.key)
          let state = ''
          let icon = ''
          if (submitted) {
            const right = userPos > -1 && userPos === ansPos
            state = right ? 'correct' : 'wrong'
            icon = right ? '✓' : '✕'
          } else if (userPos > -1) {
            state = 'picked'
          }
          return {
            key: opt.key,
            text: opt.text,
            state,
            icon,
            order: userPos > -1 ? userPos + 1 : 0
          }
        })
      }
    },

    _resultText(type, selected, answer, submitted, isRight) {
      if (!submitted) return ''
      if (type === 'fill') {
        const plain = answer.map((a) => (Array.isArray(a) ? a[0] : a)).join('、')
        return isRight ? '填空正确' : `填空错误，正确答案：${plain}`
      }
      if (type === 'sort') {
        return isRight ? `顺序正确（${answer.join(' → ')}）` : `顺序错误，正确顺序 ${answer.join(' → ')}`
      }
      return isRight ? `回答正确（${answer.join('')}）` : `回答错误，正确答案 ${answer.join('、')}`
    },

    onSelect(e) {
      const key = e.currentTarget.dataset.key
      if (!key) return
      this.triggerEvent('select', { key })
    },

    onFillInput(e) {
      const index = Number(e.currentTarget.dataset.index)
      if (isNaN(index)) return
      this.triggerEvent('fill', { index: index, value: e.detail.value })
    },

    onSortMove(e) {
      const index = Number(e.currentTarget.dataset.index)
      const action = e.currentTarget.dataset.action
      if (!action || isNaN(index)) return
      this.triggerEvent('sort', { action: action, index: index })
    },

    onSortClear() {
      this.triggerEvent('sort', { action: 'clear', index: -1 })
    },

    onStar() {
      this.triggerEvent('star', {})
    },

    onAiTap() {
      this.triggerEvent('aiexplain', {})
    }
  }
})
