# ADR 0006：Go 模块化单体业务服务与 API 契约（Architecture V2）

- 状态：Proposed
- 关联：Issue 6（依赖 Issue 3 领域设计；与 Issue 5 配合）
- 范围：新增 `backend/`、`docs/adr/`、`docs/api/`；保持小程序现有 UI

## 背景与目标

微信云开发函数适合轻量读写，但缺少关系查询、批量同步、AI 工作负载的弹性。目标：渐进迁移到自有后端，
核心领域无跨模块直接数据访问，本地可一键启动最小 API+DB，OpenAPI 契约有测试，现有小程序可渐进调用不中断。

## 决策

1. **架构形态**：Go **模块化单体**（非微服务、不先引 Kubernetes）。按 `auth / catalog / practice / learning / analytics`
   分模块，模块间仅通过服务接口/HTTP 内部调用，禁止跨模块直连对方数据库。
2. **持久化**：PostgreSQL（关系型，胜任题目/作答/统计）。`Redis / Asynq` 仅在有实际异步负载（如 AI 批处理、同步队列）时引入。
3. **API 契约**：OpenAPI 3；统一错误码（`code` + `message`）；鉴权（Bearer/JWT 或会话令牌）+ 限流；数据库迁移（`golang-migrate` 或 Atlas）。
4. **可观测性**：结构化日志、`traceId` 透传、健康检查 `/healthz` 与 `/readyz`、基础 metrics。
5. **本地环境**：`docker compose` 启动 `postgres + api`；迁移与回滚可脚本化执行。
6. **渐进迁移**：小程序保留对云开发的兼容；新端点灰度接入，旧版仍可调用，不中断。

## 目录约定（backend/）

```
backend/
  cmd/api/            # 启动入口
  internal/
    auth/  catalog/  practice/  learning/  analytics/   # 模块边界清晰，互不直连 DB
    platform/         # db / http / middleware / observability
  migrations/         # SQL 迁移（up/down）
  Dockerfile  docker-compose.yml  Makefile
docs/api/openapi.yaml # 契约
```

## OpenAPI 摘要（契约骨架）

```yaml
openapi: 3.0
info: { title: Exam-Assistant API, version: v2 }
paths:
  /auth/token:        { post: { summary: 令牌校验/换发 } }
  /catalog/questions: { get:  { summary: 按 release 拉题（见 ADR 0005） } }
  /practice/attempt:  { post: { summary: 幂等提交作答（clientOpId 幂等键，见 ADR 0003/0007） } }
  /learning/sync:     { post: { summary: 增量同步推送 }, get: { summary: 增量同步拉取 } }
  /analytics/overview:{ get:  { summary: 学情概览 } }
  /ai-tutor/chat:     { post: { summary: AI 助教（见 ADR 0008） } }
  /healthz:           { get:  { summary: 存活 } }
  /readyz:            { get:  { summary: 就绪 } }
```

## 验收对照（Issue 6）

- 本地 `docker compose up` 可起最小 API+DB。
- OpenAPI 契约有测试（契约校验 / 冒烟）。
- 健康检查、日志、`traceId`、迁移/回滚可执行。
- 现有小程序可渐进调用，旧版不中断。
- 核心领域无跨模块直接数据访问（模块边界测试/代码评审保障）。

## 不在本 Issue 范围

- 提前拆微服务 / 引入 Kubernetes / Service Mesh。
- 替换现有云函数为后端（采用渐进灰度，而非一次性切换）。
