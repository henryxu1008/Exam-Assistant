# ADR 0005：动态题库、题目版本与内容审核发布流程（Issue 5）

- 状态：Proposed
- 关联：Issue 5（依赖 Issue 3 的 QuestionVersion；后端契约与 Issue 6 协同）
- 范围：题库从「内置 mock 51 题」演进为可运营的动态题库

## 背景与目标

当前题库 `utils/bank/*` 为前端硬编码 mock；发布新题需发版小程序。目标：无需更新小程序即可发布新题；
旧答题记录仍指向原题版本；未审核题不出现在练习中；导入失败有错误报告与部分失败策略；最小管理员权限与审计。

## 决策

1. **领域模型**：`Exam`、`Subject`、`Chapter`、`KnowledgePoint`、`Question`、`QuestionVersion`、
   `QuestionBank`、`QuestionBankRelease`、`SourceLicense`。
2. **题目不可变 + 版本化**：`Question` 为稳定标识（含 `externalId`）；任何编辑生成新的 `QuestionVersion`
   （`version` 递增，`content` 快照）。沿用 Issue 3 的 `questionVersionId` 占位。
3. **发布快照**：`QuestionBankRelease` 记录某次发布包含的 `(questionId, versionId)` 集合与 `releaseTag`；
   客户端按 `releaseTag` 分页拉取并缓存，未发布/草稿版本不会进入练习。
4. **导入校验**：JSON/CSV 批量导入，强制字段与答案校验、按 `externalId` 去重；逐行错误报告 + 部分失败策略
   （失败行跳过、成功行入库，返回失败清单）。
5. **审核流**：`draft → review → approved → released`；未 `released` 不出现。`SourceLicense` 区分真题/模拟题/AI 生成与合法来源。
6. **权限与审计**：最小管理员角色（如 `role=editor/reviewer`），每次发布/导入写 `auditLog`（who/when/what）。

## ERD（文本）

```
Exam 1 ──< Subject >──< Chapter >──< KnowledgePoint
Subject 1 ──< Question >──< QuestionVersion (version 递增, content 快照)
QuestionBank 1 ──< QuestionBankRelease (releaseTag)
QuestionBankRelease *──* (QuestionVersion)
SourceLicense 1 ──< Question(或版本)
auditLog: { actor, action, target, at }
```

## 字段 / 唯一约束 / 索引（云库）

| 实体 | 字段 | 约束 / 索引 |
| --- | --- | --- |
| Question | `externalId` | 唯一（导入去重键） |
| QuestionVersion | `(questionId, version)` | 唯一 |
| QuestionBankRelease | `releaseTag` | 唯一；`status` 索引 |
| QuestionBankReleaseItem | `(releaseId, questionVersionId)` | 唯一 |

## API 契约（OpenAPI 摘要）

```yaml
# 客户端拉题（按已发布版本分页）
GET /catalog/questions?release={tag}&subject={s}&cursor={c}&limit=50
  -> 200 { items: [{ id, versionId, type, stem, options, answer, chapter, knowledgePoint }], nextCursor }
# 管理端导入
POST /admin/questions/import  { format: json|csv, items: [...] }
  -> 200 { accepted: N, failed: M, errors: [{ row, reason }] }
# 管理端发布
POST /admin/releases  { tag, items: [{ questionId, versionId }] }
  -> 201 { releaseId, tag, status: released }
```

## 迁移（本地 → 云）

- 本地 v1 题目 `utils/bank/*` 映射为 `Question(externalId=gk-1) + QuestionVersion(version=1)`；
  旧 `attempts.questionVersionId='v1'` 升级为真实 `questionId@1`。迁移幂等：已存在 `externalId` 则跳过。
- 客户端缓存按 `releaseTag` 失效重建。

## 回滚

- `QuestionBankRelease` 不可变；回滚即让客户端切回上一 `releaseTag`。
- 题目版本只增不删；撤回某版本只从新 release 中剔除，历史答题可追溯。

## 不在本 Issue 范围

- 复杂 CMS / 富文本编辑器（首期仅 JSON/CSV 导入 + 审核开关）。
- 真实大模型判分（见 Issue 8）。
