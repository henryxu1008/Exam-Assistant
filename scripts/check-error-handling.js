/**
 * scripts/check-error-handling.js
 * 拦截「吞掉异常却不区分错误类型」的 catch —— 本 PR 系列根因的机器层面拦截。
 *
 * ============ 为什么需要 ============
 * 根因：多处 try/catch 把一切失败归一化为「良性默认值」（null / {} / [] / {ok:true}），
 * 于是「读失败」与「确实不存在」无法区分，后续写入就用默认值覆盖了服务端真实数据。
 *
 * 这一模式在四轮评审里反复以不同文件、不同字段出现一次：
 *   - initConfig  readDoc        → null       → 覆盖运营配置
 *   - bankSync    bankExists     → false      → 跳过 force + 管理员校验覆盖题库
 *   - bankSync    事务内读取      → null       → 覆盖题库
 *   - userProfile config         → {ok:true}  → 清掉版本阻断
 *   - userProfile examOptions    → {ok:true}  → 空列表冒充成功
 *   - studySync   快照读取        → {ok:true}  → 不完整快照覆盖服务端备份
 *   - studySync   流水查询        → []         → 谎报「恢复已完成」
 *
 * 抽一个共享模块不足以根治：下一个新写的云函数仍会照抄旧写法。
 * 因此把它固化成 CI 防线——**模式本身不可再被提交**。
 *
 * ============ 规则 ============
 * 作用于 cloudfunctions/<fn>/*.js（不含 node_modules 与 shared/ 部署副本外的文件）：
 * catch 块必须满足以下任一条件，否则报错：
 *   1. throw                                  —— 向上冒泡让调用方看到失败
 *   2. isNotFound(e)                          —— 显式区分「确认不存在」与「读失败」
 *   3. return { ok: false, ... } / error: '…' —— 明确的失败信号
 *   4. /* swallow: 原因 *\/                      —— 确有理由忽略时，必须留下可核验的说明
 *
 * 已知限制：按花括号配平切分块，能处理引号与行注释内的花括号；
 * 模板字符串 ${} 中的花括号可能误判，届时按报错行微调即可。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const MARKER = 'swallow:'

/** 列出待检查文件：cloudfunctions/<fn>/ 下的 js，跳过 node_modules 与嵌套目录内容 */
function targets() {
  const out = []
  const base = path.join(ROOT, 'cloudfunctions')
  fs.readdirSync(base).forEach((fn) => {
    const dir = path.join(base, fn)
    if (!fs.statSync(dir).isDirectory()) return
    fs.readdirSync(dir).forEach((name) => {
      if (name.endsWith('.js')) out.push(path.join(dir, name))
    })
  })
  return out
}

/** 从 openIdx（指向 '{'）开始配平，返回匹配的 '}' 下标 */
function scanBalanced(code, openIdx) {
  let depth = 0
  let quote = null
  for (let i = openIdx; i < code.length; i++) {
    const ch = code[i]
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
      continue
    }
    if (ch === '/' && code[i + 1] === '/') {
      const nl = code.indexOf('\n', i)
      i = nl === -1 ? code.length - 1 : nl
      continue
    }
    if (ch === '/') {
      if (code[i + 1] === '*') {
        const close = code.indexOf('*/', i)
        if (close !== -1) i = close + 1
      }
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/** 提取所有 catch 块正文。同时覆盖 try/catch 与 Promise .catch(() => {…}) */
function catchBlocks(code) {
  const blocks = []
  const re = /catch\s*\(\s*[^)]*\s*\)\s*(?:=>\s*)?\{/g
  let m
  while ((m = re.exec(code)) !== null) {
    const open = code.indexOf('{', m.index)
    const close = scanBalanced(code, open)
    if (close > open) {
      blocks.push({ body: code.slice(open + 1, close), open: open + 1 })
    }
  }
  return blocks
}

/** 判断是否已正确处理错误传播 */
function handled(body) {
  if (/\bthrow\b/.test(body)) return true
  if (/\bisNotFound\s*\(/.test(body)) return true
  if (/ok\s*:\s*false/.test(body)) return true
  if (/error\s*:/.test(body)) return true
  if (body.indexOf(MARKER) !== -1) return true
  return false
}

const errors = []

targets().forEach((file) => {
  const code = fs.readFileSync(file, 'utf8')
  catchBlocks(code).forEach((blk) => {
    if (handled(blk.body)) return
    const line = code.slice(0, blk.open).split('\n').length
    const first = blk.body.trim().split('\n')[0].trim().slice(0, 60)
    errors.push(
      `${path.relative(ROOT, file)}:${line}\n` +
        `  catch 吞掉了异常却没区分错误类型：\`${first}\`\n` +
        `  读失败与「确实不存在」必须可区分，否则后续写入会用默认值覆盖真实数据。\n` +
        `  请改为：throw / isNotFound(e) 判定 / 返回 ok:false，或标注 /* ${MARKER} 原因 */`
    )
  })
})

if (errors.length) {
  console.error('Error handling check failed:\n\n' + errors.join('\n\n'))
  process.exit(1)
}
console.log('Error handling OK: 云函数 catch 均区分「确认不存在」与「读失败」')
