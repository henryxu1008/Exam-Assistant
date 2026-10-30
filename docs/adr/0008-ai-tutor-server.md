# ADR 0008：AI Tutor 服务端模型适配、分级提示与评测机制（Issue 8）

- 状态：Proposed
- 关联：Issue 8（依赖 Issue 5、6；结合 Issue 3 获取学情上下文）
- 范围：`utils/ai.js`、`pages/ai/ai.js`；新增服务端 AI adapter/worker（后端见 ADR 0006）

## 背景与目标

当前 `utils/ai.js` 为本地规则引擎（离线 fallback）。目标：服务端接 OpenAI-compatible 模型适配，
绝不在小程序存 API key；分级提示、基于题目版本与知识点的检索/解释、主观题结构化 rubric 评分；
配额/限流/超时重试/敏感信息最小化；prompt/模型版本与评测数据记录，错误答案支持纠错与人工复核。

## 决策

1. **密钥不出端**：API key 仅存服务端环境变量；小程序通过 `POST /ai-tutor/*` 调用，绝不持有密钥。
2. **降级**：服务端不可用时，端上回落本地规则引擎（保留为 offline fallback）。
3. **分级提示（tiered prompting）**：诊断 → 制定计划 → 讲解单题 → 举一反三，按场景选择 prompt 模板与上下文。
4. **检索/解释**：基于 `questionVersionId`（Issue 5）与 `knowledgePoint` 取题面与解析上下文，不泄露无关 PII。
5. **主观题评分 rubric**：结构化评分量表（要点 + 分值），输出可追溯到题目版本与评分规则。
6. **护栏**：每用户配额/限流、超时重试（指数退避）、敏感信息最小化（仅传必要学情聚合，不下发姓名等 PII）。
7. **可观测与评测**：记录 `promptVersion`、`modelVersion`、评测数据；保留至少一组人工标注评测样例与回归评测；
   错误答案支持纠错 + 人工复核闭环。
8. **安全边界**：AI 建议**不直接篡改标准答案**；展示时明确标注「AI 生成，仅供参考」。

## API 契约（OpenAPI 摘要）

```yaml
POST /ai-tutor/chat:    { sessionId, message, context:{ knowledgePoint, wrongQuestionIds } }
  -> 200 { reply, promptVersion, modelVersion }
POST /ai-tutor/explain: { questionVersionId, userAnswer }
  -> 200 { explanation, rubric? , trace:{ questionVersionId } }
POST /ai-tutor/grade:   { questionVersionId, answer }   # 主观题结构化评分
  -> 200 { score, breakdown:[{ point, hit }], rubricVersion }
```

## 评测样例（最小集，至少一组人工标注）

- 输入：某判断题 + 用户错误答案；期望：指出错误点 + 关联知识点 + 正确结论。
- 回归评测：固定 `promptVersion`/`modelVersion`，对标注集计算命中率，低于阈值阻断发布。

## 验收对照（Issue 8）

- 模型失败可降级（端上规则引擎兜底）。
- 密钥不出服务端。
- 输出可追溯到题目版本与评分规则（`trace` 字段）。
- 至少一组人工标注评测 + 回归评测。
- 每用户成本可统计/限制（用量表 + 配额）。
- AI 建议不直接篡改标准答案（前端展示隔离 + 标注）。

## 不在本 Issue 范围

- 端上本地大模型推理（受限于小程序运行时，采用服务端 + 端上规则回落）。
- 全自动批改替代教师（保留人工复核闭环）。
