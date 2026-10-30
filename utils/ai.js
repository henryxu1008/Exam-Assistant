/**
 * utils/ai.js
 * AI 助教引擎
 *
 * 说明：当前为「本地规则 + 题库数据驱动」的离线智能引擎，已实现：
 *   1. 单题结构化讲解（考点 / 思路 / 易错点 / 记忆口诀 / 举一反三）
 *   2. 对话式答疑（意图识别：薄弱项诊断、学习规划、错题复盘、成绩查询、方法指导）
 *   3. 基于真实答题数据生成个性化学习建议
 *
 * 接入真实大模型（可选）：把 REMOTE_LLM.enabled 改为 true，并在 requestLLM 中
 * 调用你自己的云函数 / 服务端接口即可，页面逻辑无需改动。
 */

const bank = require('./questions.js')
const store = require('./store.js')
const analytics = require('./analytics.js')

const REMOTE_LLM = {
  enabled: false, // 置为 true 后走真实大模型
  cloudFunction: 'aiTutor' // 云函数名（需自行开通云开发并部署）
}

/**
 * 生成学习者当前数据快照（文本），供远端大模型回答个性化查询时使用。
 * 注入后，远程调用也能基于真实答题数据作答；同时本地引擎对这些查询走专属路径（见 ai.chat）。
 * （评审 P2：Include learning statistics in personalized remote AI requests）
 */
function learningSnapshot() {
  const ov = analytics.overview()
  const weak = analytics.weakPoints(3)
  const lines = [
    `累计答题 ${ov.total} 题，总正确率 ${ov.rate}%`,
    `今日已完成 ${ov.todayTotal} 题（目标 ${store.getSettings().dailyGoal} 题），今日正确率 ${ov.todayRate}%`,
    `连续打卡 ${ov.streakDays} 天，待复习 ${ov.dueCount} 题，覆盖 ${ov.chapterCount} 个知识点模块`,
    `顽固错题 ${ov.stubbornCount} 道`
  ]
  if (weak.length) {
    lines.push('最薄弱知识点：' + weak.map((w) => `${w.chapter}(${w.rate}%, 错${w.wrong})`).join('，'))
  } else {
    lines.push('暂无明显薄弱知识点')
  }
  return lines.join('\n')
}

/** 判断查询是否依赖真实答题数据（正确率/薄弱/计划/错题/记忆方法），这类必须走本地引擎以保证数据准确（评审 P2） */
function isPersonalizedQuery(text) {
  const words = [
    '薄弱', '哪方面', '不足', '弱项', '需要加强', '缺点', '短板',
    '计划', '安排', '今天学', '怎么学', '备考',
    '成绩', '正确率', '统计', '进度', '打卡', '数据',
    '错题', '复习', '错得多', '再练',
    '口诀', '记忆', '记不住', '背诵', '背'
  ]
  return hasAny(String(text || ''), words)
}

/**
 * 预留：调用真实大模型。未开启时返回 null，页面会自动回落到本地引擎。
 * @param {Array} messages 对话历史（已裁剪为最近若干轮）
 * @param {String} [subject] 当前科目，透传给大模型以约束回答口径；缺省取全局当前科目
 * @param {Object} [context] 可选，当前题目上下文 { questionId, userAnswer }
 * @returns {Promise<string|null>}
 */
function requestLLM(messages, subject, context) {
  if (!REMOTE_LLM.enabled) return Promise.resolve(null)
  return new Promise((resolve) => {
    if (!wx.cloud || typeof wx.cloud.callFunction !== 'function') {
      resolve(null)
      return
    }
    // 透传当前科目，保证大模型回答只讲该科目（与全应用科目口径一致）
    // 端上助手消息 role 用 'ai'，云函数白名单只认 'user'/'assistant'/'system'，
    // 在此归一化，避免大模型侧把助手历史整段丢弃导致多轮上下文丢失
    const payload = (messages || []).map((m) => ({
      role: m.role === 'ai' ? 'assistant' : m.role,
      content: m.content
    }))
    // 题目上下文注入：让远端大模型能看到被讲解的题干/选项/用户作答与标准答案，
    // 否则远端只会收到一句「这道题怎么解？」而看不到题目（评审 P2：Include the selected question in remote explanation requests）
    const ctx = context || {}
    if (ctx.questionId) {
      const q = bank.findQuestion(ctx.questionId)
      if (q) {
        const optText = (q.options || []).map((o) => `${o.key}. ${o.text}`).join('；')
        const ansText = answerText(q, q.answer)
        const userAns = Array.isArray(ctx.userAnswer) && ctx.userAnswer.length ? answerText(q, ctx.userAnswer) : '（未作答）'
        payload.unshift({
          role: 'system',
          content: `【当前正在讲解的题目】科目：${q.subject}｜章节：${q.chapter}\n题干：${q.stem}\n选项：${optText}\n用户作答：${userAns}\n标准答案：${ansText}\n请基于以上题目给出分步解析。`
        })
      }
    }
    // 注入学习者数据快照：让远端大模型也能基于真实答题数据回答正确率/薄弱/计划等个性化查询
    // （评审 P2：Include learning statistics in personalized remote AI requests）
    const snap = learningSnapshot()
    if (snap) {
      payload.unshift({
        role: 'system',
        content: `【学习者当前数据快照】\n${snap}\n若用户询问正确率、薄弱点、学习计划、错题或记忆方法，请严格基于以上真实数据作答。`
      })
    }
    wx.cloud
      .callFunction({
        name: REMOTE_LLM.cloudFunction,
        data: { messages: payload, subject: subject || store.getCurrentSubject() }
      })
      .then((res) => resolve((res && res.result && res.result.content) || null))
      .catch(() => resolve(null))
  })
}

/* ------------------------------------------------------------------ */
/* 一、单题讲解                                                          */
/* ------------------------------------------------------------------ */

function answerText(question, keys) {
  const list = Array.isArray(keys) ? keys : [keys]
  if (question.type === 'fill') return list.map((k) => String(k)).join('；')
  if (question.type === 'sort') return list.join(' → ')
  const options = question.options || []
  return list
    .map((k) => {
      const opt = options.filter((o) => o.key === k)[0]
      return opt ? `${k}. ${opt.text}` : String(k)
    })
    .join('；')
}

/** 干扰项分析：找出与答案同类型但措辞绝对/偷换概念的选项 */
function distractorHint(question) {
  if (question.type === 'fill' || question.type === 'sort') return ''
  const wrong = (question.options || []).filter((o) => question.answer.indexOf(o.key) === -1)
  const absolute = wrong.filter((o) => /全部|所有|一定|必须|一律|根本|唯一/.test(o.text))
  if (absolute.length) {
    return `干扰项 ${absolute.map((o) => o.key).join('、')} 中含有「全部/一定/必须」等绝对化表述，真实性存疑，通常不是答案。`
  }
  if (wrong.length) {
    return `干扰项 ${wrong.map((o) => o.key).join('、')} 多为偷换概念或以偏概全，需回到题干对照关键词排除。`
  }
  return ''
}

/** 生成记忆口诀（按题型给规律，结合考点关键词） */
function buildMnemonic(question) {
  const keyWords = (question.keyPoint || '').replace(/[（(].*?[)）]/g, '').split(/[：:，,、]/)[0]
  const base = []
  if (question.type === 'multiple') {
    base.push('多选题三步走：一判属性、二排绝对、三看并列。')
  } else if (question.type === 'uncertain') {
    base.push('不定项要逐项独立判断，宁可少选也别把「义务/例外」混进来。')
  } else if (question.type === 'judge') {
    base.push('判断题遇到「全部、一律、必须」先打问号。')
  } else if (question.type === 'fill') {
    base.push('填空题先定位空位在句中的位置，再回原文找对应表述。')
  } else if (question.type === 'sort') {
    base.push('排序题先定首尾（起点与终点），再排中间环节。')
  } else {
    base.push('单选题先看设问词（正确的是 / 错误的是 / 意在说明），再排除无关项。')
  }
  if (keyWords) base.push(`本题记住一句：「${keyWords}」。`)
  if (question.tags && question.tags.length) base.push(`同类考点：${question.tags.join('、')}，可横向串记。`)
  return base.join('')
}

/**
 * 结构化讲解
 * @param {Object} question 题目
 * @param {Array} userAnswer 用户作答 key 数组
 * @returns {Object} 讲解对象
 */
function explainQuestion(question, userAnswer) {
  if (!question || !question.id) {
    throw new TypeError('explainQuestion: question 非法')
  }
  const selected = Array.isArray(userAnswer) ? userAnswer.slice() : []
  const answer = Array.isArray(question.answer) ? question.answer.slice() : []
  const isRight = bank.judge(question.type, selected, answer)

  // 排序用箭头、填空取首个同义答案，保证展示可读
  const sep = question.type === 'sort' ? ' → ' : '、'
  const plain = (arr) => arr.map((a) => (Array.isArray(a) ? a[0] : a)).join(sep)

  const steps = [
    {
      title: '锁定考点',
      text: `${question.subject} · ${question.chapter}${question.keyPoint ? ' —— ' + question.keyPoint : ''}`
    },
    {
      title: '分析思路',
      text: question.explain || '暂无解析，建议先回到教材对应章节复习。'
    },
    {
      title: '答案还原',
      text: `正确答案 ${plain(answer)}（${answerText(question, answer)}）。${
        selected.length ? `你的作答 ${plain(selected)}。` : ''
      }`
    }
  ]

  const hint = distractorHint(question)
  if (hint) steps.push({ title: '排除技巧', text: hint })

  return {
    questionId: question.id,
    isRight: isRight,
    headline: isRight ? '答对了，思路很清晰！' : '这题有坑，跟着步骤过一遍就明白了',
    steps: steps,
    pitfall: question.pitfall || '做题时先看设问方向，再逐项比对题干关键词。',
    mnemonic: buildMnemonic(question),
    similar: findSimilar(question, 3)
  }
}

/** 举一反三：同知识点 / 同标签的相似题 */
function findSimilar(question, limit) {
  if (!question) return []
  const n = limit || 3
  const scored = bank
    .getAllQuestions()
    .filter((q) => q.id !== question.id)
    .map((q) => {
      let score = 0
      if (q.chapter === question.chapter) score += 5
      if (q.subject === question.subject) score += 2
      const commonTags = (q.tags || []).filter((t) => (question.tags || []).indexOf(t) > -1).length
      score += commonTags * 3
      if (Math.abs(q.level - question.level) === 0) score += 1
      return { q: q, score: score }
    })
    .filter((i) => i.score > 0)
    .sort((a, b) => b.score - a.score)
  return scored.slice(0, n).map((i) => ({
    id: i.q.id,
    stem: i.q.stem,
    chapter: i.q.chapter,
    type: bank.typeName(i.q.type)
  }))
}

/* ------------------------------------------------------------------ */
/* 二、学习诊断与建议                                                     */
/* ------------------------------------------------------------------ */

/** 个性化学习建议（用于首页 / 学情报告）。snap 为 analytics.snapshot() 结果，复用可避免重复全量扫描 */
function studyAdvice(snap) {
  const ov = analytics.overview(snap)
  const weak = analytics.weakPoints(3)
  const advice = []

  if (ov.total === 0) {
    return [
      '先完成一组 10 题摸底测，系统会据此建立你的知识点画像。',
      '答题后记得看 AI 讲解，尤其是「易错提示」部分。',
      '建议固定每日练习量，连续打卡能显著提升记忆保持率。'
    ]
  }

  if (weak.length) {
    advice.push(
      `当前最薄弱的是「${weak[0].chapter}」（正确率 ${weak[0].rate}%，累计错 ${weak[0].wrong} 题），建议今天优先攻克它。`
    )
  }
  if (ov.stubbornCount > 0) {
    advice.push(`有 ${ov.stubbornCount} 道顽固错题（错 2 次以上），已加入强化复习队列，建议先过一遍再刷新题。`)
  }
  if (ov.dueCount > 0) {
    advice.push(`${ov.dueCount} 道题到了复习节点，间隔复习能把这些题彻底钉牢。`)
  }
  if (ov.rate >= 85) {
    advice.push(`整体正确率 ${ov.rate}%，基础扎实，可提升难度或加快套题节奏。`)
  } else if (ov.rate > 0 && ov.rate < 60) {
    advice.push(`整体正确率 ${ov.rate}%，建议先按知识模块刷题，把每个模块正确率提到 70% 以上再进入限时模式。`)
  }
  const todayLeft = Math.max(0, store.getSettings().dailyGoal - ov.todayTotal)
  advice.push(todayLeft > 0 ? `今日目标还差 ${todayLeft} 题，趁热打铁。 ` : '今日目标已达成，可以复习错题巩固一下。')
  return advice.slice(0, 4)
}

/** 今日学习计划 */
function dailyPlan() {
  const weak = analytics.weakPoints(5)
  const due = store.getDueIds(10)
  const goal = store.getSettings().dailyGoal
  const plan = []
  if (due.length) {
    plan.push(`先用 5 分钟复习 ${Math.min(10, due.length)} 道到期错题，激活记忆。`)
  }
  if (weak.length) {
    const names = weak.slice(0, 2).map((w) => w.chapter).join('、')
    plan.push(`集中攻克薄弱模块：${names}，每个模块 10 题起步。`)
  }
  plan.push(`完成剩余 ${Math.max(0, goal - (due.length || 0) - 10)} 题保持手感（今日目标 ${goal} 题）。`)
  plan.push('错题先点「AI 讲解」定位卡点，再重做一次同类题才算真正过关。')
  return {
    goal: goal,
    items: plan
  }
}

/** 薄弱诊断文本 */
function diagnose() {
  const ov = analytics.overview()
  const weak = analytics.weakPoints(5)
  const strong = analytics.strongPoints(3)
  if (ov.total === 0) {
    return {
      reply: '还没有足够的答题数据，先做一组练习我就能给出准确诊断啦。',
      bullets: [],
      cards: [{ text: '开始摸底练习', action: 'practice-random' }]
    }
  }
  const bullets = []
  if (weak.length) {
    bullets.push(`薄弱知识点 ${weak.length} 个：` + weak.map((w) => `${w.chapter}(${w.rate}%)`).join('，'))
  } else {
    bullets.push('暂时没有明显薄弱知识点，各模块正确率都在 60% 以上，保持住！')
  }
  if (strong.length) {
    bullets.push('掌握较好的模块：' + strong.map((s) => `${s.chapter}(${s.rate}%)`).join('，'))
  }
  bullets.push(`近期的整体表现：累计 ${ov.total} 题，正确率 ${ov.rate}%，顽固错题 ${ov.stubbornCount} 道。`)
  const cards = weak.length
    ? [{ text: `去练「${weak[0].chapter}」`, action: 'practice-weak' }, { text: '查看学情报告', action: 'goto-analysis' }]
    : [{ text: '随机刷一组题', action: 'practice-random' }]
  return {
    reply: '我结合了你的答题记录做了次体检，重点如下：',
    bullets: bullets,
    cards: cards
  }
}

/* ------------------------------------------------------------------ */
/* 三、对话答疑                                                          */
/* ------------------------------------------------------------------ */

function hasAny(text, words) {
  return words.some((w) => text.indexOf(w) > -1)
}

/**
 * 对话接口
 * @param {String} text 用户输入
 * @param {Object} context { questionId } 可选，当前正在看的题目
 * @returns {Object} {reply, bullets, cards}
 */
function chat(text, context) {
  const input = String(text || '').trim()
  if (!input) {
    return { reply: '想问点什么呢？可以直接说：我哪里最薄弱 / 帮我制定计划 / 这题怎么解。', bullets: [], cards: [] }
  }
  const ctx = context || {}
  const q = ctx.questionId ? bank.findQuestion(ctx.questionId) : null

  // 1. 题目相关讲解：需要来源页传入当前题目，且用户确实在问这道题
  if (q && /这题|这道题|怎么解|讲一下|解析|为什么选/.test(input)) {
    const explained = explainQuestion(q, ctx.userAnswer || [])
    return {
      reply: `${explained.headline}（${bank.typeName(q.type)}｜${q.chapter}）`,
      bullets: explained.steps.map((s) => `${s.title}：${s.text}`),
      cards: [
        { text: '看记忆口诀', action: 'mnemonic' },
        { text: '来道同类题', action: 'similar' }
      ],
      extra: explained
    }
  }

  // 1.1 用户在 AI 页直接问「这道题」，但并未从某题跳转过来（无上下文）
  if (!q && /这题|这道题|怎么解|讲一下|解析|为什么选/.test(input)) {
    return {
      reply: '请先在题目页面点「AI 讲解」，或在错题本 / 学情报告里点某题的「交给 AI 助教」，我才能针对这道题为你讲解哦。',
      bullets: [],
      cards: [{ text: '去刷题', action: 'practice-random' }]
    }
  }

  // 2. 薄弱诊断
  if (hasAny(input, ['薄弱', '哪方面', '不足', '弱项', '需要加强', '缺点', '短板'])) {
    return diagnose()
  }

  // 3. 学习计划
  if (hasAny(input, ['计划', '安排', '今天学', '怎么学', '备考'])) {
    const plan = dailyPlan()
    return {
      reply: `结合你的薄弱项和复习队列，今天的建议这样安排（目标 ${plan.goal} 题）：`,
      bullets: plan.items,
      cards: [
        { text: '开始薄弱突破', action: 'practice-weak' },
        { text: '复习到期错题', action: 'review-due' }
      ]
    }
  }

  // 4. 错题复盘
  if (hasAny(input, ['错题', '复习', '错得多', '再练'])) {
    const ov = analytics.overview()
    const stubborn = analytics.stubbornQuestions(3)
    const bullets = [`错题本共 ${ov.wrongCount} 道，其中错 2 次以上的顽固错题 ${ov.stubbornCount} 道。`]
    stubborn.forEach((s) => {
      bullets.push(`「${s.question.chapter}」已错 ${s.record.wrong} 次：${s.question.stem.slice(0, 26)}${s.question.stem.length > 26 ? '…' : ''}`)
    })
    bullets.push('建议每天先清 5 道错题再刷新题，连续 3 天正确即可移出错题本。')
    return {
      reply: '错题是最值钱的提分资源，咱们这样处理：',
      bullets: bullets,
      cards: [
        { text: '打开错题本', action: 'goto-mistakes' },
        { text: '立即重练错题', action: 'review-due' }
      ]
    }
  }

  // 5. 成绩统计
  if (hasAny(input, ['成绩', '正确率', '统计', '进度', '打卡', '数据'])) {
    const ov = analytics.overview()
    return {
      reply: '这是你目前的学习数据：',
      bullets: [
        `累计答题 ${ov.total} 题，总正确率 ${ov.rate}%`,
        `今日已完成 ${ov.todayTotal} 题（${store.getSettings().dailyGoal} 题目标），今日正确率 ${ov.todayRate}%`,
        `连续打卡 ${ov.streakDays} 天，待复习 ${ov.dueCount} 题`,
        `覆盖 ${ov.chapterCount} 个知识点模块`
      ],
      cards: [{ text: '查看完整学情报告', action: 'goto-analysis' }]
    }
  }

  // 6. 记忆方法
  if (hasAny(input, ['口诀', '记忆', '记不住', '背诵', '背'])) {
    const weak = analytics.weakPoints(2)
    const bullets = []
    if (weak.length) {
      weak.forEach((w) => {
        const sample = bank.filterQuestions({ chapter: w.chapter })[0]
        bullets.push(`${w.chapter}：${sample ? buildMnemonic(sample) : '先看教材框架，再刷 10 题巩固。'}`)
      })
    } else {
      bullets.push('建议用「错题三遍法」：当天讲一遍、隔天做一遍、周末总复习一遍。')
    }
    bullets.push('多选题务必总结自己的漏选项，多数情况是漏看了并列信息。')
    return { reply: '记忆这块给几个马上能用的方法：', bullets: bullets, cards: [] }
  }

  // 7. 兜底
  return {
    reply: '我可以基于你的真实答题数据提供帮助，试试这些说法：',
    bullets: [
      '「我哪里最薄弱」—— 生成知识点诊断',
      '「帮我制定今天的学习计划」—— 按薄弱项排优先级',
      '「错题怎么复习」—— 顽固错题清单与复习策略',
      '「我的正确率多少」—— 查看学习数据',
      '在某个题目页面点「AI 讲解」—— 获取分步解析'
    ],
    cards: [
      { text: '薄弱诊断', action: 'diagnose' },
      { text: '今日计划', action: 'plan' }
    ]
  }
}

module.exports = {
  REMOTE_LLM,
  requestLLM,
  learningSnapshot,
  isPersonalizedQuery,
  explainQuestion,
  findSimilar,
  buildMnemonic,
  studyAdvice,
  dailyPlan,
  diagnose,
  chat
}
