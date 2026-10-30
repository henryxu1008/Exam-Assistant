/**
 * 轻量语法检查（Issue 4 的「检查项 / lint」）
 * 不引入外部依赖，使用 vm.Script 校验全部工程 JS 文件可被解析。
 * 跳过 node_modules / miniprogram_npm / .git / .github 等目录。
 */
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const ROOT = path.resolve(__dirname, '..')
const SKIP = new Set(['node_modules', 'miniprogram_npm', '.git', '.github'])

const errors = []

function walk(dir) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (e) {
    return
  }
  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full)
    } else if (entry.name.endsWith('.js')) {
      const code = fs.readFileSync(full, 'utf8')
      try {
        // 仅做语法解析，不执行；引用 wx / Page / Component 等运行时全局不影响解析
        new vm.Script(code, { filename: full })
      } catch (err) {
        errors.push(`${full}: ${err.message}`)
      }
    }
  }
}

walk(ROOT)

if (errors.length) {
  console.error('Lint failed:\n' + errors.join('\n'))
  process.exit(1)
}
console.log('Lint OK: 所有 JS 文件语法校验通过')
