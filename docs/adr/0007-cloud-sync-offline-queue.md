# ADR 0007：学习记录云端同步、离线队列与多设备一致性（Issue 7）

- 状态：Proposed
- 关联：Issue 7（依赖 Issue 1、3、6）
- 范围：`utils/store.js`、`utils/user.js`；新增 sync API（后端见 ADR 0006）

## 背景与目标

当前作答仅存本地（按 openid 命名空间，见 Issue 1）。目标：云端权威、离线提交队列、idempotency key、
增量同步游标；设备 A 作答设备 B 可见；断网恢复自动补传且不重复；同一题跨设备操作不丢事件；
切换用户无串号；冲突规则与数据保留政策写入文档。

## 决策

1. **边界**：本地缓存为「待同步来源」，云端为「权威」。每个 `AnswerAttempt`（Issue 3）带 `clientOpId`
   作为 `idempotency key`，云端按 `(userId, clientOpId)` 去重。
2. **离线队列**：本地维护 `syncQueue`（未确认推送的 attempts）；网络恢复自动批量 `POST /learning/sync`（push）。
3. **增量拉取**：`GET /learning/sync?cursor={syncedAt}` 返回 `cursor` 之后云端新事件；客户端以 `cursor` 推进。
4. **追加语义**：作答/错题只追加不覆盖；收藏（star）、设置（settings）用事件或带版本号的 last-write-wins 冲突规则。
5. **账号切换**：切换/登出时清空本地内存态并切作用域（Issue 1）；云端数据按 `openid` 隔离，无串号。
6. **安全删除/导出**：提供导出（JSON）与按用户删除（服务端 `DELETE /users/{id}` + 本地 `clearScope`）。

## API 契约（OpenAPI 摘要）

```yaml
POST /learning/sync:
  body: { pushes: [ { clientOpId, questionVersionId, selected, score, costMs, createdAt } ] }
  -> 200 { accepted: [{ clientOpId }], rejected: [{ clientOpId, reason }] }
GET  /learning/sync?cursor=1761700000000:
  -> 200 { events: [ ...attempts/star/settings ], nextCursor }
```

## 冲突规则（写入文档）

- **作答/错题（attempt）**：append-only，幂等键 `clientOpId` 去重；绝不直接覆盖历史。
- **收藏 star**：建模为 toggle 事件流，最终状态由各端重放决定；跨设备以最后事件为准。
- **设置 settings**：带 `version` 的 last-write-wins；UI 提示「以最近修改为准」。
- **数据保留**：作答流水默认保留 N 天（可配置）；删除遵循最小必要原则。

## 验收对照（Issue 7）

- 设备 A 作答、设备 B 可见（拉取游标推进）。
- 断网后恢复自动补传且不重复（`clientOpId` 幂等）。
- 同一题跨设备操作不丢事件（追加语义 + 游标）。
- 切换用户无串号（openid 命名空间 + 服务端隔离）。
- 冲突规则与数据保留政策写入本文档。

## 不在本 Issue 范围

- 实时协同编辑（题目/作答非协作场景）。
- 自建冲突合并 CRDT（超出当前需求，采用追加 + LWW 即可）。
