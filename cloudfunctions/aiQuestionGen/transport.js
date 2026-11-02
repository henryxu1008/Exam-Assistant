/** Configured server-side provider only; never accepts an endpoint or key from the client. */
const https = require('https')
const fail = code => { throw Object.assign(new Error(code), { code }) }
function createTransport({ endpoint, apiKey, model }) {
  let url
  try { url = new URL(endpoint) } catch (e) { /* swallow: invalid configuration is returned as an explicit failure. */ fail('AI_GENERATION_CONFIG_INVALID') }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname || !apiKey || !model) fail('AI_GENERATION_CONFIG_INVALID')
  return request => new Promise((resolve, reject) => {
    const system = '你是考试题库编辑。只输出 JSON 对象，格式为 {"questions":[{"type":"single|multiple|judge","level":1,"stem":"题干","options":[{"key":"A","text":"选项"}],"answer":["A"],"explain":"解析"}]}。不要输出代码块、来源或版权声明；必须原创练习题，不确定的事实不要编造。单选和判断仅一个答案，多选至少两个答案。所有题目按用户给定题型、难度、数量生成。'
    const payload = JSON.stringify({ model, temperature: 0.5, max_tokens: 5000,
      messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(request) }] })
    const req = https.request({ protocol: url.protocol, hostname: url.hostname, port: url.port || undefined, path: url.pathname + url.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey, 'Content-Length': Buffer.byteLength(payload) } }, res => {
      const chunks = []; let size = 0
      res.on('data', chunk => { const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += part.length; if (size > 150000) { req.destroy(); reject(Object.assign(new Error('AI_RESPONSE_TOO_LARGE'), { code: 'AI_RESPONSE_TOO_LARGE' })); return } chunks.push(part) })
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(Object.assign(new Error('AI_UPSTREAM_FAILED'), { code: 'AI_UPSTREAM_FAILED' }))
        try {
          const bytes = Buffer.concat(chunks, size), body = bytes.toString('utf8')
          if (!Buffer.from(body, 'utf8').equals(bytes)) fail('BAD_AI_RESPONSE')
          const outer = JSON.parse(body), content = outer && outer.choices && outer.choices[0] && outer.choices[0].message && outer.choices[0].message.content
          if (typeof content !== 'string') fail('BAD_AI_RESPONSE')
          resolve(JSON.parse(content))
        } catch (e) { /* swallow: malformed upstream content rejects the entire generated batch. */ reject(Object.assign(new Error('BAD_AI_RESPONSE'), { code: 'BAD_AI_RESPONSE' })) }
      })
      res.on('error', () => reject(Object.assign(new Error('AI_UPSTREAM_FAILED'), { code: 'AI_UPSTREAM_FAILED' })))
    })
    req.on('error', () => reject(Object.assign(new Error('AI_UPSTREAM_FAILED'), { code: 'AI_UPSTREAM_FAILED' })))
    req.setTimeout(30000, () => { req.destroy(); reject(Object.assign(new Error('AI_UPSTREAM_TIMEOUT'), { code: 'AI_UPSTREAM_TIMEOUT' })) })
    req.write(payload); req.end()
  })
}
module.exports = { createTransport }
