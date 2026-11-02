const questions = require('../../shared/question-domain.js')
const grading = require('../../shared/grading-domain.js')
const options = ['A', 'B', 'C'].map(key => ({ key, text: key }))
function release(suffix = '') {
  return questions.buildRelease({ manifest: { subjects: [{ key: 'gk', name: '公基', chapters: [{ key: 'law', name: '法律' }] }] },
    questions: { gk: ['single', 'multiple', 'judge', 'uncertain', 'fill', 'sort'].map(type => ({
      id: type + suffix, subject: '公基', chapter: '法律', stem: '合成测试 ' + type + suffix, type,
      options, answer: type === 'fill' ? [['北京', 'Beijing'], '协议'] : ['multiple', 'uncertain'].includes(type) ? ['A', 'C'] : type === 'sort' ? ['C', 'B', 'A'] : ['A']
    })) } })
}
function question(bank, type = 'single') { return { ...bank.questions.gk.find(q => q.type === type), bankReleaseId: bank.releaseId } }
function fact(q, selected = q.type === 'fill' ? ['北京', '协议'] : q.answer, extra = {}) {
  return { id: 'local-' + q.id, sessionId: 'session', clientOpId: 'operation', questionId: q.id, questionVersionId: q.versionId,
    bankReleaseId: q.bankReleaseId, questionSnapshot: questions.snapshotQuestion(q), answer: q.answer, selected,
    score: grading.judge(q.type, selected, q.answer) ? 1 : 0, costMs: 10, createdAt: 1,
    projection: { version: 1, subject: q.subject, chapter: q.chapter, date: '2026-11-01' }, ...extra }
}
function seed(h, bank) { h.questions.set(bank.releaseId, { kind: 'questionBankRelease', bank, publishedAt: 1, publishedBy: 'synthetic-admin' }); return bank }
const commit = (h, attempts, extra = {}) => h.main({ token: 'tokA', action: 'commitVersionedAttempts', attemptProtocol: 2, questionProtocol: 2, dataEpoch: 0, attempts, ...extra })
module.exports = { release, question, fact, seed, commit }
