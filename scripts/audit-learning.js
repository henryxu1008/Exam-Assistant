/** 只读取指定离线快照，输出脱敏对账结果；不访问云或改写输入。 */
const fs = require('node:fs')
const { auditLearning } = require('../shared/learning-audit.js')
const args = process.argv.slice(2)
if (args.length !== 2 || args[0] !== '--input') {
  process.stderr.write('Usage: node scripts/audit-learning.js --input <offline-snapshot.json>\n')
  process.exitCode = 1
} else {
  try {
    const snapshot = JSON.parse(fs.readFileSync(args[1], 'utf8'))
    const report = auditLearning(snapshot)
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
    process.exitCode = report.status === 'consistent' ? 0 : report.status === 'issues' ? 2 : 3
  } catch (e) {
    process.stderr.write('INPUT_INVALID: cannot read or parse the offline snapshot\n')
    process.exitCode = 1
  }
}
