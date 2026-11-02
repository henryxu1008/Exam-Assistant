/** Offline only. Credentials and cloud transports are deliberately absent. */
const fs = require('node:fs')
const { TextDecoder } = require('node:util')
const { preflight } = require('../shared/catalog-import.js')
function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write('Usage: npm run catalog:check -- --input <file> --format json|csv [--prepared <new-file.json>]\n'); return 0
  }
  const options = {}
  for (let i = 0; i < args.length; i += 2) {
    if (!['--input', '--format', '--prepared'].includes(args[i]) || !args[i + 1] || options[args[i]]) throw new Error('BAD_USAGE')
    options[args[i]] = args[i + 1]
  }
  if (!options['--input'] || !['json', 'csv'].includes(options['--format'])) throw new Error('BAD_USAGE')
  const stat = fs.statSync(options['--input'])
  if (!stat.isFile() || stat.size > 2000000) throw new Error('INPUT_TOO_LARGE')
  const result = preflight(new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(options['--input'])), options['--format'])
  if (result.ok && options['--prepared']) fs.writeFileSync(options['--prepared'], JSON.stringify(result.prepared, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  const { prepared, ...report } = result
  process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  return result.ok ? 0 : 2
}
try { process.exitCode = main(process.argv.slice(2)) } catch (e) { process.stderr.write('PREFLIGHT_FAILED: input, usage or output unavailable\n'); process.exitCode = 1 }
