# ADR 0003：AnswerAttempt 领域模型与学习数据迁移（Issue 3）

- 状态：Accepted
- 关联：Issue 3（依赖 Issue 1、2 的设计基础；Issue 5 接入 QuestionVersion）
- 范围：本地 `store.js` 的领域模型与 v2→v3 迁移

## 背景与目标

原 `store.js` 直接维护每题的「聚合记录」（`records[qid]`），缺少不可变作答事实，
无法支持幂等重放、跨版本题目追溯与未来云端同步的事件溯源。Issue 2/3 要求把单次作答
建模为不可变事实，并提供可重复执行的幂等迁移。

## 决策

1. **不可变作答流水 `attempts[]`（AnswerAttempt）**：每次提交追加一条记录，永不覆盖。
   聚合统计（`records`）仍作为派生结果维护，避免一次性重写全部统计逻辑。
2. **练习 Session 状态机**：`practiceSession` 状态为 `created → in_progress → completed`，
   每题绑定 `attemptId`，以 `clientOpId` 实现同一次提交的重试幂等。
3. **迁移 v2→v3**：新增 `attempts[]` 与 `practiceSession` 字段；旧聚合 `records` 保留为派生来源。
   不可变流水无法由聚合反推，明确**不伪造历史**作答。迁移幂等：已为 v3 的数据再次加载不再迁移、不重复计数。
4. **题目版本占位**：`questionVersionId` 暂用 `'v1'`，待 Issue 5 引入 `QuestionVersion` 后填充，
   届时跨版本题目可追溯。

## ERD（文本）

```
User 1 ──< PracticeSession >── 1 Subject/Mode
PracticeSession 1 ──< AnswerAttempt >── 1 QuestionVersion
AnswerAttempt { id, sessionId, questionId, questionVersionId, selected,
                answer, score, costMs, clientOpId, createdAt }
QuestionVersion 1 ──< AnswerAttempt
Record(派生) { id=questionId, attempts, right, wrong, level, ... } 由 attempts 聚合维护
```

## 字段 / 唯一约束 / 索引（本地）

| 实体 | 字段 | 约束 |
| --- | --- | --- |
| AnswerAttempt | `id` | 唯一（主键），`newId('at')` |
| AnswerAttempt | `(sessionId, questionId, clientOpId)` | 业务幂等键：同一会话同题同 clientOpId 仅落库一次 |
| AnswerAttempt | `questionVersionId` | 外键（未来），当前占位 `'v1'` |
| PracticeSession | `id` | 唯一 |
| PracticeSession | `submitted[qid]` | `{ attemptId, clientOpId }` 只读回看依据 |

本地为单文件 JSON；上云后建议索引：`attempts(sessionId)`、`attempts(questionId)`、
`attempts(clientOpId)`、`records(openid, questionId)`。

## 本地 JSON 示例（迁移后单条）

```json
{
  "version": 3,
  "attempts": [
    { "id": "at_xxx", "sessionId": "ps_yyy", "questionId": "gk-1",
      "questionVersionId": "v1", "selected": ["A"], "answer": ["A"],
      "score": 1, "costMs": 123, "clientOpId": "ps_yyy:gk-1", "createdAt": 1761700000000 }
  ],
  "practiceSession": { "id": "ps_yyy", "mode": "all", "status": "in_progress",
                       "submitted": { "gk-1": { "attemptId": "at_xxx", "clientOpId": "ps_yyy:gk-1" } } },
  "records": { "gk-1": { "id": "gk-1", "attempts": 1, "right": 1, "wrong": 0, "level": 1 } }
}
```

## API JSON 示例（未来云端点 POST /practice/attempt）

```json
{ "method": "POST", "path": "/practice/attempt",
  "body": { "questionVersionId": "gk-1@v2", "selected": ["A"], "costMs": 123, "clientOpId": "ps_yyy:gk-1" },
  "idempotencyKey": "clientOpId",
  "response": { "attemptId": "at_zzz", "score": 1, "dedup": false } }
```

## 迁移与回滚

- **幂等**：`migrate()` 仅在 `version < CURRENT_VERSION` 时执行；v3 数据再次加载不二次迁移。
- **无损**：旧 `records` 保留，聚合统计不丢；新增 `attempts` 为空（不伪造历史流水）。
- **回滚**：本地不支持版本降级（降级会丢失 v3 字段）。回滚策略：保留升级前 `exam_quiz_data_v1__<openid>`
  的备份（可经由 `clearScope` 安全删除），代码回滚到 v2 时该备份可恢复为 v2 形态。
- **对账**：`records[qid].attempts` 应等于 `attempts.filter(questionId==qid).length`；不一致即告警（待 Issue 4 补充断言测试）。
