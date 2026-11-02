# ADR 0018：原发布归档判分与服务端接收时间（Issue #3 / #5）

- 状态：Implemented，未部署；隔离 CloudBase / 微信验收未完成
- 前置：ADR 0012–0014；客户端代码 1.3.0；本地仓储格式不变

## 根因与事实边界

内容摘要只能证明快照自洽，不能证明它来自已发布题库，也不能证明客户端上报得分正确。
旧 studySync 可接受调用方自建的合法内容摘要，并直接把其 score 计入首次事实贡献。
使用 main 对应源码和内存数据库复现：无任何发布归档，选 B、答案 A、score:1 的版本化事实仍被接受并累计正确次数。

本阶段只为**首次接受的版本化事实**建立原发布归档判分及接收时间；不改写已接受事实，不重判历史。
AnswerAttempt 的业务身份、账号/dataEpoch 隔离、事实计数、持久队列和恢复游标不变。
服务端校验来自可信函数响应；grading 是来源记录，不是数字签名，也不证明答题者未提前看到答案。

## 发布依据与判分

studySync 在创建事实的同一事务中读取 `questions/<bankReleaseId>`，要求：

1. ID 为 `qb_<sha256>`，文档 kind 为 questionBankRelease，有合法 publishedAt。
2. bank 通过全量内容/清单/摘要校验，releaseId 与文档地址一致。
3. 归档包含对应 questionId + questionVersionId，规范化原题快照与提交证据一致。
4. selected 是合法的题型输入；按归档答案计算出的 0/1 分数与提交 score 完全一致。

读取明确不存在、访问失败、归档损坏与判分不符分别拒绝；任一项失败都抛出事务错误，
前面已创建的事实、计数、序号、会话和修订号全部回滚，不返回成功确认。
不使用当前 `questions/bank` 代替历史发布：纠错或撤回后离线补传仍按原版本判分。
已接受且有合法 grading 的幂等重试复用首次事实和时间，不再读取归档；损坏的已有 grading 明确拒绝。

共享规则在 `shared/grading-domain.js`，端上题库导出与 studySync 部署副本同步检查：

| 题型 | 选择验证与计分 |
| --- | --- |
| single / judge | 一个合法选项；与答案相同得 1 分 |
| multiple / uncertain | 非空、不重复、均为合法选项；集合相等得 1 分，少选/多选得 0 分 |
| fill | 空位数相同、每项为非空字符串；忽略空白和大小写，支持每空同义答案，全中得 1 分 |
| sort | 合法选项完整排列且不重复；顺序完全相同得 1 分 |

非法选择被拒绝，合法但错误的答案正常接受为 0 分。答案、得分不自动修正，避免改变持久待传事实和本地已派生计数。

需要处理内容或配置的判分错误（如 GRADE_MISMATCH、BAD_SELECTION、归档缺失/损坏）会终止当前同步轮次并返回原始原因，
保留队列，不消耗三次重试后改报 SYNC_RETRY_EXHAUSTED。READ_RELEASE_FAILED 等访问失败继续有界重试。
停止本轮不禁止后续外部触发；匹配归档经授权发布后，下一轮可直接补传原队列。

## 数据与确认契约

请求沿用 commitVersionedAttempts，要求 `attemptProtocol:2, questionProtocol:2`，每批最多 24 条。
新增字段由服务端生成，客户端提交同名字段会被写入白名单丢弃：

```js
{
  grading: {
    version: 1, judgeVersion: 1, source: 'published_archive',
    releaseId: originalReleaseId, questionVersionId: originalQuestionVersionId,
    score: 0 // 或 1；与原发布答案计算结果一致
  },
  serverReceivedAt: serverClockMilliseconds
}
```

serverReceivedAt 是首次接受时服务端应用时钟，不是客户端 createdAt，也不是数据库提交时间证明。
重试保持首次值。get / 增量恢复保留两个字段。

成功响应包含 `attemptProtocol:2, questionProtocol:2, gradingProtocol:1`。
每条 attemptReceipts 增加 gradingStatus：

| 状态 | 含义 | 客户端确认要求 |
| --- | --- | --- |
| graded | 新增版本事实已经按归档判分，或重试复用已有判分事实 | 版本/题目/发布/score 绑定、可重算结果及合法服务端时间均通过 |
| legacy_unverified | 已有未判分事实的原样重试，或兼容 v1 历史提交 | 没有 grading / serverReceivedAt，不将旧事实升级成已验证 |

既有业务身份、原答案、事实映射、确认集合与服务端计数校验仍全部执行。
任何确认缺失、不完整或冲突均保留整个当前批次；先持久化事实/确认映射，再出队。
50 条版本待传按 24/24/2 提交；最后一批才发布完整快照。

## 兼容、权限与历史

新服务拒绝 questionProtocol:1 的版本化请求；旧服务拒绝 questionProtocol:2。
禁止把版本化请求降级为 commitAttempts / update；旧 update 现在也明确拒绝版本字段。
普通用户仍只能以有效个人 token 提交自己的学习事实，不能写 questions、角色或配置。
发布权限、独立审核与管理员保护未修改；可信归档依赖既有 bankSync 和数据库禁止客户端直写规则。

旧 v1 / 无版本的 commitAttempts 保留兼容，明确为未验证；旧聚合基线不变，因此不能宣称总正确率均由权威判分产生。
旧服务已接受但丢 ACK 的版本事实可原样确认，返回 legacy_unverified，不补写接收时间或重判，即使原得分后来被发现有误。
旧事实与历史迁移仍需只读对账和独立迁移方案；不猜测缺失字段。

内置 Mock 和本地自签版本不是发布证据。离线练习仍可保存，但首次同步要求匹配的授权发布归档。
缺档时保留队列，不自动上传题库或把任意快照变成发布内容。已有缺档离线版本的运营处理仍需逐项核对来源与发布方案。

## 资源、发布与回滚

[CloudBase 事务文档](https://docs.cloudbase.net/database/transaction) 限制每事务 100 次操作，并有时间限制。
最坏每条新事实需要业务地址读、历史 ID 冲突读、归档读、事实写，另有档案读写：24×4+2=98。
同事务按 releaseId 缓存归档；纯历史批次上限仍为 32（32×3+2=98）。
此上限只覆盖操作数。多个接近 600 KB 的归档、内容摘要耗时和真实请求大小仍需隔离云验证，不能凭 Node 替身宣称满足原生限额。

后续上线须先验证数据库规则、保留所需归档，再协调 studySync 与客户端 1.3.0。
升级窗口的旧协议会保留待传项，发布方案须明确旧客户端升级路径；本 PR 不修改真实 minVersion / forceUpdate。
不要回滚为仍接受客户端分数的旧函数并继续新写入；需要暂停新写入、保留队列并评估协议后再回滚。
本地仓储版本不变，既有 v5 的回滚限制仍见 ADR 0017。

## 验证与剩余工作

合成回归覆盖六题型正反例、伪分数、未发布内容、归档缺失/损坏/读失败、半批回滚、写失败、
非法输入、首次时间、旧已接受事实不变、重试/丢 ACK/重启、纠错/撤回后离线补传、
旧协议保留队列、确认损坏、24 条最坏 98 次操作与 50 条客户端分批。
现有完整运营链路仍通过真实 bankSync / studySync / store；题库发布夹具显式共享同一 questions 集合，不自动信任提交快照。

升级组合已通过真实 1.2.0 与当前版本的 store、共享依赖及 studySync 源码在内存数据库中验证，
并纳入独立 CI job；见 [协议升级与隔离验收指南](../grading-upgrade-acceptance.md)。这些结果不代表已通过原生云或微信验收。

仍未完成：真实云/多设备验收，已有坏事实或缺档队列的操作入口，来源公开展示/期限治理、大题库分页，
完整学习领域投影与历史迁移。判分失败会保留队列并报告错误，当前没有自动改分或丢弃坏项机制。
Issue #3 / #5 保持 Open。未部署云函数、未访问或修改真实学习数据/运营配置、未调用付费 AI。
