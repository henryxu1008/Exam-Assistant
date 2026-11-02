const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createService } = require('../cloudfunctions/aiQuestionGen/service.js')
const domain = require('../shared/ai-question-domain.js')
const { createAiQuestionGenerator } = require('../utils/ai-question-generator.js')
const { createTransport } = require('../cloudfunctions/aiQuestionGen/transport.js')
const https = require('node:https')
const { EventEmitter } = require('node:events')
const clone = x => JSON.parse(JSON.stringify(x))
const spec = { requestId: 'batch1', examName: '系统架构师', subjectKey: 'it', subjectName: '基础知识', chapterKey: 'arch', chapterName: '软件架构', topic: 'CAP 定理', type: 'single', level: 1, count: 2 }
const response = request => ({ questions: Array.from({ length: request.count }, (_, i) => ({ type: request.type, level: request.level,
  stem: '合成问题 ' + i, options: [{ key: 'A', text: '甲' }, { key: 'B', text: '乙' }], answer: ['A'], explain: '合成测试解析' })) })
function harness() {
  const maps = { users: new Map([['u1', { _id: 'u1', openid: 'alice', token: 'token', tokenAt: Date.now() }], ['u2', { _id: 'u2', openid: 'bob', token: 'other', tokenAt: Date.now() }]]),
    appConfig: new Map([['bankRoles', { editors: ['alice'], reviewers: ['bob'], publishers: [] }]]), aiQuestionUsage: new Map() }
  const fail = { get: false, write: false }, control = { calls: 0, model: response }
  function collection(name, stores) {
    return { where(filter) { return { limit() { return this }, async get() { if (fail.get) throw new Error('read'); return { data: [...stores[name].values()].filter(row => Object.keys(filter).every(k => row[k] === filter[k])).map(clone) } } } },
      doc(id) { return { async get() { if (fail.get) throw new Error('read'); if (!stores[name].has(id)) throw new Error('document does not exist'); return { data: clone(stores[name].get(id)) } },
        async set({ data }) { if (fail.write) throw new Error('write'); stores[name].set(id, clone(data)) } } } }
  }
  let queue = Promise.resolve()
  const db = { collection: name => collection(name, maps), runTransaction(fn) {
    const next = queue.then(async () => {
      const draft = Object.fromEntries(Object.entries(maps).map(([name, m]) => [name, new Map([...m].map(([k,v]) => [k, clone(v)]))]))
      const value = await fn({ collection: name => collection(name, draft) })
      for (const name of Object.keys(maps)) { maps[name].clear(); for (const [k,v] of draft[name]) maps[name].set(k,v) }
      return value
    }); queue = next.catch(() => {}); return next
  } }
  const service = createService({ db, config: { enabled: true, configured: true, globalCap: 2, userCap: 2, model: 'synthetic-model' },
    callModel: async req => { control.calls++; return control.model(req) } })
  return { maps, fail, control, service }
}

test('仅编辑角色可生成完整候选，题号和章节由服务端确定，题库不被写入', async () => {
  const h = harness()
  assert.equal((await h.service({ ...spec, count: 6, token: 'token' })).error, 'BAD_AI_REQUEST')
  assert.equal((await h.service({ ...spec, token: 'other' })).error, 'NOT_CATALOG_ROLE')
  assert.equal((await h.service({ ...spec, token: 'wrong' })).error, 'INVALID_TOKEN')
  assert.equal(h.control.calls, 0)
  const result = await h.service({ ...spec, token: 'token' })
  assert.equal(result.ok, true); assert.equal(result.questions.length, 2)
  assert.deepEqual(domain.validateCandidates(result, spec, 'alice').questions, result.questions)
  assert.equal(result.questions[0].subject, 'it'); assert.ok(result.questions[0].id.startsWith('AI_'))
  assert.equal(result.generator, 'synthetic-model'); assert.equal(Object.keys(h.maps).includes('questions'), false)
})

test('并发调用受事务配额约束；权限或存储异常不会调用上游', async () => {
  const h = harness(), results = await Promise.all(Array.from({ length: 8 }, (_, i) => h.service({ ...spec, requestId: 'batch' + i, token: 'token' })))
  assert.equal(h.control.calls, 2); assert.equal(results.filter(x => x.ok).length, 2)
  assert.equal(results.filter(x => x.error === 'AI_QUOTA_EXCEEDED').length, 6)
  const bad = harness(); bad.fail.get = true
  assert.equal((await bad.service({ ...spec, token: 'token' })).ok, false); assert.equal(bad.control.calls, 0)
  bad.fail.get = false; bad.fail.write = true
  assert.equal((await bad.service({ ...spec, token: 'token' })).ok, false); assert.equal(bad.control.calls, 0)
})

test('默认关闭时不访问上游或数据库', async () => {
  let called = false
  const service = createService({ db: {}, config: { enabled: false, configured: false }, callModel: () => { called = true } })
  assert.equal((await service({ ...spec, token: 'token' })).error, 'AI_GENERATION_DISABLED')
  assert.equal(called, false)
})

test('模型错误、重复题、错误答案和生成中撤权不能变成候选题', async () => {
  for (const mode of ['duplicate', 'answer', 'type', 'count', 'revoke']) {
    const h = harness()
    h.control.model = req => {
      const out = response(req)
      if (mode === 'duplicate') out.questions[1].stem = out.questions[0].stem
      if (mode === 'answer') out.questions[0].answer = ['Z']
      if (mode === 'type') out.questions[0].type = 'multiple'
      if (mode === 'count') out.questions.pop()
      if (mode === 'revoke') h.maps.appConfig.get('bankRoles').editors = []
      return out
    }
    const result = await h.service({ ...spec, token: 'token' })
    assert.equal(result.ok, false, mode); assert.equal(result.questions, undefined)
  }
})

test('客户端拒绝伪造题号和迟到的跨账号结果', async () => {
  let session = { logged: true, token: 'token', openid: 'alice' }, release
  const gate = new Promise(resolve => { release = resolve })
  const client = createAiQuestionGenerator({ getSession: () => session, call: async request => { await gate; return { ok: true, generator: 'test', questions: domain.normalize(response(request).questions, request, 'alice') } } })
  const pending = client.generate(spec); session = { logged: true, token: 'other', openid: 'bob' }; release()
  await assert.rejects(pending, /STALE_OPERATOR_CONTEXT/)
  const forged = createAiQuestionGenerator({ getSession: () => ({ logged: true, token: 'token', openid: 'alice' }), call: async request => {
    const qs = domain.normalize(response(request).questions, request, 'alice'); qs[0].id = 'forged'; return { ok: true, generator: 'test', questions: qs }
  } })
  await assert.rejects(forged.generate(spec), /BAD_AI_RESPONSE/)
})

test('模型传输使用服务端配置的 HTTPS 地址，异常或非 JSON 内容明确失败', async t => {
  let mode = 'ok', captured
  t.mock.method(https, 'request', (options, handler) => {
    captured = options
    const req = new EventEmitter(); req.setTimeout = () => {}; req.write = () => {}; req.destroy = () => {}
    req.end = () => queueMicrotask(() => {
      const res = new EventEmitter(); res.statusCode = mode === 'status' ? 503 : 200; handler(res)
      res.emit('data', mode === 'invalid' ? 'invalid' : JSON.stringify({ choices: [{ message: { content: JSON.stringify(response(spec)) } }] }))
      res.emit('end')
    })
    return req
  })
  const request = createTransport({ endpoint: 'https://model.example.test/v1/chat/completions', apiKey: 'synthetic', model: 'fake' })
  assert.equal((await request(spec)).questions.length, 2); assert.equal(captured.hostname, 'model.example.test')
  mode = 'invalid'; await assert.rejects(request(spec), /BAD_AI_RESPONSE/)
  mode = 'status'; await assert.rejects(request(spec), /AI_UPSTREAM_FAILED/)
  assert.throws(() => createTransport({ endpoint: 'http://model.example.test', apiKey: 'synthetic', model: 'fake' }), /AI_GENERATION_CONFIG_INVALID/)
})
