/**
 * utils/chart.js
 * Canvas 2D 图表工具：雷达图（知识点掌握度）、折线图（正确率趋势）
 * 用法：chart.renderRadar(page, '#canvasId', data)
 */

function getPixelRatio() {
  try {
    if (wx.getWindowInfo && typeof wx.getWindowInfo === 'function') {
      return wx.getWindowInfo().pixelRatio || 2
    }
  } catch (e) {
    // ignore
  }
  return wx.getSystemInfoSync().pixelRatio || 2
}

/** 获取画布上下文 */
function getCanvas(ctxInstance, selector) {
  return new Promise((resolve) => {
    const q = wx.createSelectorQuery()
    if (ctxInstance) q.in(ctxInstance)
    q.select(selector)
      .fields({ node: true, size: true })
      .exec((res) => {
        const item = res && res[0]
        if (!item || !item.node) {
          resolve(null)
          return
        }
        const canvas = item.node
        const ctx = canvas.getContext('2d')
        const dpr = getPixelRatio()
        const width = item.width
        const height = item.height
        canvas.width = width * dpr
        canvas.height = height * dpr
        ctx.scale(dpr, dpr)
        resolve({ ctx: ctx, width: width, height: height })
      })
  })
}

const COLOR_PRIMARY = '#3d6bff'
const COLOR_RED = '#e5484d'
const COLOR_GRID = '#e8ecf4'
const COLOR_TEXT = '#8a93a6'

/* ---------------- 雷达图 ---------------- */

function renderRadar(ctxInstance, selector, data) {
  const items = (data && data.labels ? data.labels : []).map((label, i) => ({
    label: label,
    value: data.values[i] || 0
  }))
  return getCanvas(ctxInstance, selector).then((canvas) => {
    if (!canvas || !items.length) return false
    const { ctx, width, height } = canvas
    ctx.clearRect(0, 0, width, height)

    const cx = width / 2
    const cy = height / 2 + 2
    const radius = Math.min(width, height) / 2 - 38
    const n = items.length
    const max = 100

    // 背景网格
    for (let ring = 1; ring <= 4; ring++) {
      const r = (radius * ring) / 4
      ctx.beginPath()
      for (let i = 0; i < n; i++) {
        const angle = (Math.PI * 2 * i) / n - Math.PI / 2
        const x = cx + Math.cos(angle) * r
        const y = cy + Math.sin(angle) * r
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.closePath()
      ctx.setStrokeStyle(COLOR_GRID)
      ctx.setLineWidth(1)
      ctx.stroke()
    }

    // 轴线
    ctx.setStrokeStyle(COLOR_GRID)
    for (let i = 0; i < n; i++) {
      const angle = (Math.PI * 2 * i) / n - Math.PI / 2
      ctx.beginPath()
      ctx.moveTo(cx, cy)
      ctx.lineTo(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius)
      ctx.stroke()
    }

    // 数据多边形
    ctx.beginPath()
    items.forEach((it, i) => {
      const angle = (Math.PI * 2 * i) / n - Math.PI / 2
      const r = (Math.max(0, Math.min(it.value, max)) / max) * radius
      const x = cx + Math.cos(angle) * r
      const y = cy + Math.sin(angle) * r
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.closePath()
    ctx.setFillStyle('rgba(61, 107, 255, 0.20)')
    ctx.fill()
    ctx.setStrokeStyle(COLOR_PRIMARY)
    ctx.setLineWidth(2)
    ctx.stroke()

    // 顶点
    items.forEach((it, i) => {
      const angle = (Math.PI * 2 * i) / n - Math.PI / 2
      const r = (Math.max(0, Math.min(it.value, max)) / max) * radius
      const x = cx + Math.cos(angle) * r
      const y = cy + Math.sin(angle) * r
      ctx.beginPath()
      ctx.arc(x, y, 3, 0, Math.PI * 2)
      ctx.setFillStyle('#ffffff')
      ctx.fill()
      ctx.setStrokeStyle(COLOR_PRIMARY)
      ctx.setLineWidth(2)
      ctx.stroke()
    })

    // 标签
    ctx.setFontSize(11)
    ctx.setTextAlign('center')
    items.forEach((it, i) => {
      const angle = (Math.PI * 2 * i) / n - Math.PI / 2
      const lx = cx + Math.cos(angle) * (radius + 20)
      const ly = cy + Math.sin(angle) * (radius + 20)
      ctx.setFillStyle(COLOR_TEXT)
      ctx.fillText(it.label, lx, ly + 3)
      ctx.setFillStyle('#5a6478')
      ctx.fillText(`${Math.round(it.value)}`, lx, ly + 16)
    })
    return true
  })
}

/* ---------------- 折线图 ---------------- */

function renderLine(ctxInstance, selector, data) {
  const labels = (data && data.labels) || []
  const values = (data && data.values) || []
  return getCanvas(ctxInstance, selector).then((canvas) => {
    if (!canvas || !labels.length) return false
    const { ctx, width, height } = canvas
    ctx.clearRect(0, 0, width, height)

    const padLeft = 26
    const padRight = 12
    const padTop = 14
    const padBottom = 24
    const chartW = width - padLeft - padRight
    const chartH = height - padTop - padBottom

    // 网格
    ctx.setFontSize(9)
    ctx.setTextAlign('right')
    ctx.setTextBaseline('middle')
    for (let i = 0; i <= 4; i++) {
      const y = padTop + (chartH * i) / 4
      ctx.beginPath()
      ctx.moveTo(padLeft, y)
      ctx.lineTo(width - padRight, y)
      ctx.setStrokeStyle(COLOR_GRID)
      ctx.setLineWidth(1)
      ctx.stroke()
      ctx.setFillStyle(COLOR_TEXT)
      ctx.fillText(`${100 - i * 25}`, padLeft - 4, y)
    }

    const stepX = labels.length > 1 ? chartW / (labels.length - 1) : 0
    const points = values.map((v, i) => ({
      x: padLeft + (labels.length > 1 ? stepX * i : chartW / 2),
      y: padTop + chartH * (1 - Math.max(0, Math.min(v, 100)) / 100),
      v: v
    }))

    // 面积
    ctx.beginPath()
    ctx.moveTo(points[0].x, padTop + chartH)
    points.forEach((p) => ctx.lineTo(p.x, p.y))
    ctx.lineTo(points[points.length - 1].x, padTop + chartH)
    ctx.closePath()
    const grad = ctx.createLinearGradient(0, padTop, 0, padTop + chartH)
    grad.addColorStop(0, 'rgba(61, 107, 255, 0.28)')
    grad.addColorStop(1, 'rgba(61, 107, 255, 0.02)')
    ctx.setFillStyle(grad)
    ctx.fill()

    // 折线
    ctx.beginPath()
    points.forEach((p, i) => {
      if (i === 0) ctx.moveTo(p.x, p.y)
      else ctx.lineTo(p.x, p.y)
    })
    ctx.setStrokeStyle(COLOR_PRIMARY)
    ctx.setLineWidth(2)
    ctx.stroke()

    // 点 + 数值
    points.forEach((p) => {
      ctx.beginPath()
      ctx.arc(p.x, p.y, 3, 0, Math.PI * 2)
      ctx.setFillStyle('#ffffff')
      ctx.fill()
      ctx.setStrokeStyle(COLOR_PRIMARY)
      ctx.setLineWidth(2)
      ctx.stroke()
      ctx.setFontSize(9)
      ctx.setTextAlign('center')
      ctx.setTextBaseline('bottom')
      ctx.setFillStyle(p.v < 60 ? COLOR_RED : COLOR_PRIMARY)
      ctx.fillText(points.length > 8 ? '' : `${p.v}`, p.x, p.y - 6)
    })

    // X 轴标签
    ctx.setFontSize(9)
    ctx.setTextAlign('center')
    ctx.setTextBaseline('top')
    ctx.setFillStyle(COLOR_TEXT)
    labels.forEach((l, i) => {
      ctx.fillText(l, padLeft + stepX * i, padTop + chartH + 6)
    })
    return true
  })
}

/* ---------------- 横向条形图（知识点掌握度） ---------------- */

function renderBars(ctxInstance, selector, data) {
  const items = (data && data.items) || []
  return getCanvas(ctxInstance, selector).then((canvas) => {
    if (!canvas || !items.length) return false
    const { ctx, width, height } = canvas
    ctx.clearRect(0, 0, width, height)
    const rowH = Math.min(28, height / items.length)
    const labelW = 74
    const valueW = 42
    const barW = width - labelW - valueW
    const top = (height - rowH * items.length) / 2

    items.forEach((it, i) => {
      const y = top + rowH * i + rowH / 2
      ctx.setFontSize(11)
      ctx.setTextAlign('left')
      ctx.setTextBaseline('middle')
      ctx.setFillStyle('#5a6478')
      ctx.fillText(it.label.length > 5 ? `${it.label.slice(0, 5)}…` : it.label, 0, y)

      const h = 10
      const y0 = y - h / 2
      ctx.beginPath()
      ctx.moveTo(labelW, y0 + h / 2)
      ctx.lineTo(labelW + barW, y0 + h / 2)
      ctx.setLineWidth(h)
      ctx.setStrokeStyle('#eef1f6')
      ctx.setLineCap('round')
      ctx.stroke()

      const color = it.value >= 85 ? '#16a34a' : it.value >= 60 ? COLOR_PRIMARY : COLOR_RED
      if (it.value > 0) {
        ctx.beginPath()
        ctx.moveTo(labelW, y0 + h / 2)
        ctx.lineTo(labelW + (barW * it.value) / 100, y0 + h / 2)
        ctx.setStrokeStyle(color)
        ctx.setLineWidth(h)
        ctx.stroke()
      }

      ctx.setTextAlign('right')
      ctx.setFillStyle(color)
      ctx.fillText(`${Math.round(it.value)}%`, width, y)
    })
    return true
  })
}

module.exports = {
  getCanvas,
  renderRadar,
  renderLine,
  renderBars
}
