const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { preflight } = require('../shared/catalog-import.js')
const sample = fs.readFileSync(path.join(__dirname, '../docs/examples/catalog-import.json'), 'utf8')
const csv = fs.readFileSync(path.join(__dirname, '../docs/examples/catalog-import.csv'), 'utf8')

test('JSON/CSV 样例产生同一规范发布，支持 BOM、CRLF、引号、逗号和多行单元格', () => {
  const json = preflight(sample, 'json'), table = preflight('\uFEFF' + csv.replace(/\r?\n/g, '\r\n'), 'csv')
  assert.equal(json.ok, true); assert.equal(table.ok, true)
  assert.equal(json.total, 2); assert.equal(json.releaseId, table.releaseId)
  assert.deepEqual(json.prepared, table.prepared)
  const more = csv.replace('合成样例：请选择甲。', '合成样例：请选择甲，或乙。')
  assert.equal(preflight(more, 'csv').ok, true)
})

test('逐行报告坏答案、来源和重复题号，整批拒绝且不输出题目或证据原值', () => {
  const input = JSON.parse(sample)
  input.bank.questions.it[0].answer = ['unknown-option']
  input.sources['DEMO-2'].permission = ''
  const result = preflight(JSON.stringify(input), 'json')
  assert.equal(result.ok, false); assert.equal(result.prepared, undefined)
  assert.deepEqual(result.errors.map(e => e.row), [1, 2])
  assert.equal(JSON.stringify(result).includes('synthetic:'), false)
  assert.equal(JSON.stringify(result).includes('unknown-option'), false)
  const duplicate = JSON.parse(sample); duplicate.bank.questions.it.push(duplicate.bank.questions.it[0])
  assert.equal(preflight(JSON.stringify(duplicate), 'json').errors[0].code, 'DUPLICATE_ID')
})

test('CSV 语法/列头/单元格错误明确定位，不静默跳过无效行', () => {
  assert.equal(preflight(csv.replace('options,answer', 'options,options'), 'csv').errors[0].code, 'BAD_CSV_HEADER')
  assert.equal(preflight(csv + '\n"unterminated', 'csv').errors[0].code, 'CSV_SYNTAX')
  const bad = csv.split(/\r?\n/)[0] + '\nonly-one-cell\n'
  assert.deepEqual(preflight(bad, 'csv').errors, [{ row: 2, field: 'input', code: 'CSV_COLUMN_COUNT' }])
  const malformed = csv.replace('"[""A""]"', 'broken-json')
  assert.equal(preflight(malformed, 'csv').errors[0].field, 'answer')
})

test('JSON 保留未使用章节/科目，错误分类和多余来源不被规范化掩盖', () => {
  const input = JSON.parse(sample)
  input.bank.manifest.subjects[0].chapters.push({ key: 'empty', name: '空章节' })
  input.bank.manifest.subjects.push({ key: 'empty', name: '空科目', chapters: [] }); input.bank.questions.empty = []
  const result = preflight(JSON.stringify(input), 'json')
  assert.equal(result.ok, true)
  assert.deepEqual(result.prepared.bank.manifest, { version: 1, ...input.bank.manifest })
  input.bank.questions.it[0].subject = '错误科目'
  assert.equal(preflight(JSON.stringify(input), 'json').errors[0].code, 'BAD_QUESTION_SCOPE')
  input.sources.extra = input.sources['DEMO-1']
  assert.equal(preflight(JSON.stringify(input), 'json').ok, false)
})

test('考试 JSON 与 CSV 导入保留考试归属，同名科目按考试分开', () => {
  const input = JSON.parse(sample), first = input.bank.manifest.subjects[0]
  input.bank.schemaVersion = 3; input.bank.manifest.exams = [{ id: 'a', name: '考试甲' }, { id: 'b', name: '考试乙' }]
  first.examId = 'a'; const other = JSON.parse(JSON.stringify(first)); other.key = 'it-b'; other.examId = 'b'
  input.bank.manifest.subjects.push(other)
  const extra = JSON.parse(JSON.stringify(input.bank.questions.it[0])); extra.id = 'DEMO-3'; input.bank.questions['it-b'] = [extra]
  input.sources['DEMO-3'] = input.sources['DEMO-1']
  const result = preflight(JSON.stringify(input), 'json')
  assert.equal(result.ok, true)
  assert.equal(result.prepared.bank.schemaVersion, 3)
  assert.equal(result.prepared.bank.questions.it[0].subject, 'it')
  assert.equal(result.prepared.bank.questions['it-b'][0].subject, 'it-b')
  assert.equal(result.prepared.bank.manifest.subjects[1].examId, 'b')
  const roundtrip = preflight(JSON.stringify(result.prepared), 'json')
  assert.equal(roundtrip.ok, true)
  assert.equal(roundtrip.releaseId, result.releaseId)
  const columns = ['id','subjectKey','subject','chapterKey','chapter','type','stem','options','answer','sourceKind','sourceTitle','sourceReference','sourcePermission','sourceAttribution','examId','examName']
  const cell = value => '"' + String(value).replace(/"/g, '""') + '"'
  const lines = [['Q1','s1','综合知识','c','基础','single','题面','[{"key":"A","text":"甲"},{"key":"B","text":"乙"}]','["A"]','original','来源','synthetic:1','授权','署名','a','考试甲'],
    ['Q2','s2','综合知识','c','基础','single','题面','[{"key":"A","text":"甲"},{"key":"B","text":"乙"}]','["A"]','original','来源','synthetic:2','授权','署名','b','考试乙']]
  const text = columns.join(',') + '\n' + lines.map(row => row.map(cell).join(',')).join('\n')
  const csvResult = preflight(text, 'csv')
  assert.equal(csvResult.ok, true)
  assert.deepEqual(csvResult.prepared.bank.manifest.subjects.map(s => s.examId), ['a', 'b'])
  assert.equal(csvResult.prepared.bank.questions.s2[0].subject, 's2')
  const invalid = preflight(text.replace('"synthetic:2"', '""'), 'csv')
  assert.equal(invalid.ok, false); assert.equal(invalid.prepared, undefined)
  assert.equal(invalid.errors[0].row, 3)
})

test('空导入不能意外清空题库，超大输入、超行数和格式错误拒绝', () => {
  assert.equal(preflight(JSON.stringify({ bank: { manifest: { subjects: [] }, questions: {} }, sources: {} }), 'json').errors[0].code, 'EMPTY_IMPORT')
  assert.equal(preflight('x'.repeat(2000001), 'csv').errors[0].code, 'INPUT_TOO_LARGE')
  assert.equal(preflight(sample, 'xml').errors[0].code, 'BAD_FORMAT')
  assert.equal(preflight(csv.split(/\r?\n/)[0] + '\n' + 'bad\n'.repeat(501), 'csv').errors[0].code, 'TOO_MANY_ROWS')
})

test('离线 CLI 默认只输出报告；准备文件显式新建，输入和已有文件不覆盖', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-preflight-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const input = path.join(dir, 'input.json'), output = path.join(dir, 'prepared.json')
  fs.writeFileSync(input, sample)
  const cli = args => spawnSync(process.execPath, [path.join(__dirname, '../scripts/catalog-preflight.js'), ...args], { encoding: 'utf8' })
  const args = ['--input', input, '--format', 'json']
  const first = cli(args)
  assert.equal(first.status, 0); assert.equal(JSON.parse(first.stdout).prepared, undefined)
  assert.equal(first.stdout.includes('synthetic:'), false); assert.equal(fs.existsSync(output), false)
  assert.equal(cli([...args, '--prepared', output]).status, 0)
  const before = fs.readFileSync(output, 'utf8')
  assert.ok(JSON.parse(before).sources)
  assert.equal(cli([...args, '--prepared', output]).status, 1)
  assert.equal(fs.readFileSync(output, 'utf8'), before); assert.equal(fs.readFileSync(input, 'utf8'), sample)
  fs.writeFileSync(input, '{}')
  assert.equal(cli(args).status, 2)
  assert.equal(cli(['--format', 'json']).status, 1)
  fs.writeFileSync(input, Buffer.from([0xff, 0xfe, 0x41]))
  assert.equal(cli(args).status, 1, '非法 UTF-8 不得静默替换字符后导入')
})
