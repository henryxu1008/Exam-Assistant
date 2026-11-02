#!/usr/bin/env node
/** Read-only preflight: never output question text, answers, sources, credentials or prepared pages. */
const fs = require('node:fs')
const { TextDecoder } = require('node:util')
const { buildPagedCatalog } = require('../shared/paged-catalog-domain.js')
function main(argv) {
  if (argv.length !== 2 || argv[0] !== '--input') { process.stderr.write('Usage: node scripts/catalog-paged-preflight.js --input <file.json>\n'); return 1 }
  let text
  try {
    const data = fs.readFileSync(argv[1])
    if (data.length > 12000000) throw Object.assign(new Error('INPUT_TOO_LARGE'), { code: 'INPUT_TOO_LARGE' })
    text = new TextDecoder('utf-8', { fatal: true }).decode(data).replace(/^\uFEFF/, '')
  } catch (e) {
    process.stderr.write((e.code === 'INPUT_TOO_LARGE' ? e.code : 'FILE_OR_ENCODING_ERROR') + '\n')
    return 1
  }
  try {
    const parsed = JSON.parse(text), bank = parsed && (parsed.bank || parsed)
    const prepared = buildPagedCatalog({ ...bank, sources: parsed && parsed.sources })
    process.stdout.write(JSON.stringify({ ok: true, total: prepared.root.totalQuestions, pages: prepared.root.pages.length, releaseId: prepared.root.releaseId }) + '\n')
    return 0
  } catch (e) {
    const code = /^[A-Z][A-Z0-9_]*$/.test(e.code || '') ? e.code : 'BAD_INPUT'
    process.stdout.write(JSON.stringify({ ok: false, errors: [{ row: Number.isSafeInteger(e.row) ? e.row : 0,
      field: typeof e.field === 'string' ? e.field : 'input', code }] }) + '\n')
    return 2
  }
}
process.exitCode = main(process.argv.slice(2))
