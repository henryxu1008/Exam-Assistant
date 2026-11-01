# ADR 0011：增量作答恢复与生命周期同步（Issue 7 第二阶段）

- 状态：Implemented，待 PR 合并及独立测试环境验收
- 依赖：PR #12 / ADR 0010 的持久 outbox 与明确 ID 确认
- 范围：现有云开发后端、客户端同步协调器及当前页面刷新；不迁移 Go 后端

## 问题与目标

启动一次的全量恢复无法持续看到其他设备的新作答；用客户端时间或数组偏移作为增量位置，不能稳定表达服务端已经接受的事实。分页中途失败或发生并发写入，也不能将半批结果标为恢复完成。

本阶段为不可变作答建立服务端顺序和持久恢复游标，并在登录、应用前台恢复、网络恢复时继续同步。收藏、设置、练习元数据和 AI 对话仍通过既有版本/代次规则合并快照，聚合尚未改成服务端重建。

## 服务端序号与游标

| 位置 | 字段 | 含义 |
| --- | --- | --- |
| attempts | serverSequence | 当前账号、dataEpoch 内新事实的严格递增序号 |
| studyStats | attemptSequence | 已提交事实序号的高水位 |
| studyStats | syncRevision | 包括快照、AI 清空和整体清空在内的事务修订 |
| studyStats | sequenceRevision | 最后一次由新处理器写入的修订，用于检测旧写入器 |
| studyStats | sequenceGeneration | 检测到旧处理器写入后递增，使原游标要求重建基线 |
| 本地账号档案 | syncCursor | `{version:2,dataEpoch,generation,sequence}`，与完整恢复结果一起落盘 |

新作答的 serverSequence 和 attemptSequence 在现有同一事务内分配；同 ID、同内容重放不消耗新序号，失败整批回滚。客户端提供的内部序号不会写入。内部字段不进入公开 AnswerAttempt，也不参与不可变事实内容比较。48 条的事务操作上限不变。

查询采用 CloudBase [比较指令与排序](https://github.com/TencentCloudBase/node-sdk/blob/master/docs/database/database.md)：`serverSequence > afterSequence`，按 serverSequence 升序分页。序号与客户端 createdAt、设备时间和本地数组位置无关。

### 请求与响应

没有有效本地游标时，先按既有全量分页读取历史，不回填或伪造旧流水。全部分页验证成功后保存高水位；之后发送：

```json
{"action":"get","token":"<session>","syncProtocol":2,"cursor":{"dataEpoch":0,"generation":0,"sequence":17},"afterSequence":17}
```

```json
{"ok":true,"syncProtocol":2,"mode":"delta","dataEpoch":0,"syncRevision":30,"aiEpoch":0,"stats":{},"attempts":[],"hasMore":false,"nextSequence":19,"cursor":{"dataEpoch":0,"generation":0,"sequence":19}}
```

示例中的 attempts 省略实际内容。第一响应的 syncRevision/dataEpoch 固定本轮视图，后续页原样携带；响应 cursor 是同一视图的最终高水位，nextSequence 仅用于本轮翻页。完整聚合快照只在本轮第一页返回，其他页 stats=null，AI 代次始终单独返回。

查询前后及跨页检查修订；任一变化返回 SNAPSHOT_CHANGED，不能返回完成游标。读取失败、集合/索引缺失、非法页结构、序号非前进都明确失败。整体清空、更换序号代次、超前或非法游标返回 CURSOR_RESET_REQUIRED；客户端最多在本轮回退全量基线一次。整体清空作废旧数据/outbox，同 dataEpoch 的序号代次变化只重建基线，不删除本地事实。

客户端只在全部分页成功且作用域、令牌、进程代次及 AI 上下文仍有效时合并。恢复数据与 syncCursor 一起同步写盘，成功后再发布内存和页面通知；写盘失败保留原内存、原磁盘及原游标。恢复得到的远端事实不进入 outbox。

## 生命周期协调

`utils/sync-coordinator.js` 合并同一身份的并发触发；登录确认、App.onShow 和已连接的网络变化都通过 store.syncNow() 进入同一流程：

1. 写盘并排空已有云写队列；保留删除意图优先、AI 清空优先的顺序。
2. 从持久游标增量拉取并原子落盘。
3. 等待恢复在途期间产生的本地编辑得到确认，才报告整轮成功。

每轮最多三次，第二/三次分别等待 100/400 毫秒；单次拉取最多 1000 页。失败保留队列/游标，等待下一次外部触发，不轮询、不无界重试。请求本身沿用 SDK 的完成/失败机制。账号、令牌或整体清空使上下文失效时取消旧轮，迟到结果不污染当前数据。

纯增量拉取只写本地，不回声上传快照或人为推进修订。启动旧档案的本地独有数据和恢复在途的新编辑仍会备份。数据实际变化时通知当前首页、学情页、个人页；隐藏/卸载页面不响应通知。练习与 AI 页面继续沿用已有上下文失效机制。

## 升级与回滚

- 新服务端兼容旧客户端的 get/update。新客户端遇到没有 syncProtocol 的旧服务端时，安全执行全量恢复并移除本地增量游标，不能猜测高水位。
- PR #10/#12 旧写入器保留未知元数据但仅推进 syncRevision。sequenceRevision 不匹配时拒绝旧增量游标；后续新写入递增 sequenceGeneration，防止它掩盖未编号事实。完整恢复包含这些事实，不修改其历史文档。此机制不替代对任意数据库直写的权限限制。
- 不新增集合或批量迁移，不更改真实学习数据。新增字段保持内部使用，客户端白名单不能覆盖它们。整体清空仍保留 dataEpoch 墓碑、持久 deleteId 及原物理清理语义。
- 发布前在独立环境验证 `(openid, serverSequence)` 和 `(openid, dataEpoch, serverSequence)` 的查询/排序索引及真实事务冲突重试；索引失败必须保持失败，不能降级为空完成。先具备新服务端，再发布客户端；PR #12 仍是前置依赖。
- 回滚保留 ADR 0009/0010 的事务、代次、权限及明确确认。不能退回不推进修订的早期写入器。若暂退到 PR #12 服务端，客户端会采用全量恢复；恢复新处理器后由序号代次重建基线。

## 验证与剩余工作

真实 store、真实云函数与独立设备存储替身覆盖：并发序号、时间回拨、幂等重放、旧无序号事实、分页并发写入、三次冲突上限、传输失败/重启、游标写盘失败、非法游标、整体/AI 清空、切账号迟到页、旧服务端及旧写入器交错、前台/网络/登录触发合并和当前页面刷新。前台恢复用例在基线 app 上复现看不到新作答，修复版通过。

仍需真实微信设备和云端索引/事务验收。聚合快照依然全量，单次本地写盘依然包含全部历史（#11）；超大历史或持续并发可能耗尽本轮页数/重试上限，但不会伪报完成。业务 clientOpId 唯一约束、服务端事实/聚合对账、持久后台物理清理、不可变题目版本仍未完成，#7 保持 Open。本变更不执行部署或付费模型调用。
