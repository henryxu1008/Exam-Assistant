const domain = require('../../shared/attempt-domain.js')
const grading = require('../../shared/grading-domain.js')
/** 正常新提交协议的传输替身；非法确认测试直接使用真实服务或原始响应。 */
function withCommit(opts, result) {
  if (!result || !result.ok || !['commitAttempts', 'commitVersionedAttempts'].includes(opts.data.action)) return result
  const attempts = opts.data.attempts || []
  const stats = JSON.parse(JSON.stringify(result.stats || { records: (opts.data.stats || {}).records || {}, daily: (opts.data.stats || {}).daily || {} }))
  const receipts = attempts.map(a => ({ submittedId: a.id, gradingStatus: grading.isVersioned(a) ? 'graded' : 'legacy_unverified',
    attempt: { ...a, ...(a.projection ? { projection: { ...a.projection, confirmed: true } } : {}),
      ...(grading.isVersioned(a) ? { serverReceivedAt: 1, grading: { version: 1, judgeVersion: 1, source: 'published_archive',
        releaseId: a.bankReleaseId, questionVersionId: a.questionVersionId, score: a.score } } : {}) } }))
  for (const receipt of receipts) {
    domain.resolveAttempt(stats, attempts.find(a => a.id === receipt.submittedId), receipt.attempt)
    domain.addServerCounts(stats, receipt.attempt)
  }
  delete stats.attempts
  return { dataEpoch: opts.data.dataEpoch || 0, attemptProtocol: 2, questionProtocol: grading.QUESTION_PROTOCOL, gradingProtocol: 1,
    acceptedAttemptIds: attempts.map(a => a.id), attemptReceipts: receipts,
    ...result, stats }
}
module.exports = { withCommit }
