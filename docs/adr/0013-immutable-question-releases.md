# ADR 0013：不可变题目版本与最小发布快照（Issue #5 第一阶段）

- 状态：Implemented，未部署，真实环境未验收；独立审核与严格启用边界由 ADR 0014 补充
- 关联：#3、#5、#7；沿用微信云开发，不提前实施 #6 的后端迁移

## 问题与决策

旧题库只有稳定题号，管理员强制导入会覆盖题面、答案和解析。练习恢复按题号查询当前题库，
所以旧作答可能被放在纠错后的新题面下展示。仅把作答的 `v1` 换成一个编号不能解决恢复问题。

使用内容寻址的不可变题目版本和发布快照；练习固定所见题目，新作答保存完整题目证据。
当前小题库将版本嵌入不可变 release 文档，避免先引入独立内容管理服务或大量文档事务。

| 数据 | 身份与存储 | 变化规则 |
| --- | --- | --- |
| Question | 稳定 `id` | 用于题目列表、收藏与现有聚合 |
| QuestionVersion | `qv_<SHA256(canonical(content))>` | 题号、题面、分类、题型、难度、选项、答案、解析、易错点、知识点或标签变化即新版本 |
| QuestionBankRelease | `questions/qb_<SHA256(canonical(bank))>`，内嵌各版本 | 发布归档只创建、不覆盖；同内容复用同一归档 |
| 当前发布 | `questions/bank`，完整兼容镜像及 `publicationRevision` | 事务 CAS 激活；回滚也必须推进修订号 |
| 激活审计 | `questions/bank_publication_<revision>` | 服务端记录真实管理员、前后 release 与时间，与激活一起提交 |
| PracticeSession | `questionSnapshots[qid]` | 创建/加入题目时固定；同会话合并保留双方新增题目，同题不同版本冲突置为未知 |
| AnswerAttempt | `questionVersionId`、`bankReleaseId`、`questionSnapshot` | 新作答保留原题面、答案、解析；提交/恢复/确认均保留证据 |

canonical 按对象字段排序，保留选项及填空/排序题的顺序，多选答案规范排序。可移植 SHA-256
与 Node 标准实现交叉校验，端云部署副本由 lint 检查。内容摘要用于一致性校验，不是签名。

## 云函数 API 与管理员边界

继续使用 `bankSync` 与原有管理员 token / 密钥校验。错误密钥即拒绝，不能回退 token；
未配置凭据不开放写入。公开读取无用户身份，不公开未发布内容。

```json
{"action":"getPublished"}
```

返回 `{ok:true, bank, publicationRevision}`。尚未发布返回 `bank:null`；访问失败为
`READ_BANK_FAILED`，损坏内容为 `INVALID_RELEASE`，不能冒充空库。

```json
{
  "action":"publish", "token":"<管理员令牌>", "reviewed":true, "expectedRevision":0,
  "bank":{
    "manifest":{"subjects":[{"key":"it","name":"专业知识","chapters":[{"key":"net","name":"网络基础"}]}]},
    "questions":{"it":[{"id":"NET-01","subject":"专业知识","chapter":"网络基础","type":"single",
      "stem":"示例题面", "options":[{"key":"A","text":"选项甲"},{"key":"B","text":"选项乙"}],
      "answer":["A"],"explain":"示例解析"}]}
  }
}
```

服务端规范化内容并生成版本，不接受调用方指定摘要或审计身份。JSON 全批校验，坏答案、重复题号、
分类不匹配等使整批失败，返回明确错误；本阶段不采用部分成功。`reviewed:true` 是单管理员人工审核
确认，不代表已有独立审核人、草稿工作流、来源授权审核或 CSV 导入界面。

读取当前修订、检查不可变归档、必要时备份旧库、创建归档/审计与激活全在同一事务内。
并发或过时请求得到 `STALE_PUBLICATION`，必须重新读取并核对后再发布；丢失成功响应时也先读回，
不能盲目重放旧修订。访问/写入失败为 `PUBLISH_FAILED`，无事务能力为 `TRANSACTION_REQUIRED`。
现阶段全量发布最多 500 题、规范内容 UTF-8 600 KB；超过即拒绝。没有按题数增长的事务文档操作，
初次旧库迁移最坏 7 次文档操作。实际 SDK、容量和耗时仍须隔离环境验证。

```json
{"action":"getVersion","releaseId":"qb_<64位摘要>","versionId":"qv_<64位摘要>"}
```

只从已发布归档读取原题；确认没有目标返回 `question:null`，访问失败 `READ_VERSION_FAILED`，
摘要/结构不一致 `INVALID_RELEASE`。撤回用新的发布快照移除题目；旧归档仍保留供追溯。
回滚是使用原内容、当前 expectedRevision 再发布，不覆盖历史。

旧 `get` 仍返回当前已发布镜像供老读者使用。所有旧 `set` 写入改为事务，与 publish 串行化；
一旦当前库为 schemaVersion 2，旧 set 即使管理员 force 也返回 `PUBLICATION_REQUIRED`。
首次激活前的原始旧库保存在 `bank_legacy_backup`，不用于猜测旧流水版本。

## 客户端与历史兼容

新客户端只请求 getPublished；旧后端 BAD_ACTION、缺失发布、损坏发布、缓存失败都保留当前源。
新缓存 `exam_quiz_bank_published_v2` 与旧缓存分离；完整校验、同步落盘成功后才切换内存源。
修订不能倒退，延迟旧响应不能覆盖较新发布；管理员回滚因修订递增而可正常生效。
断网使用最近确认的发布或内置快照，不将其宣称为已检查远端最新状态。

内置题也生成内容版本，并标记内容所属 release 摘要；该摘要不意味着云端已归档或已审核。
会话和作答自带快照，跨设备恢复或清缓存后不依赖当前题库还原旧题。
练习恢复优先使用已提交事实的原题证据，未提交题用会话固定快照；缺失或冲突时显示缺少原题版本，
不展示缓存成功成绩，要求用户主动开始新练习。原始流水和统计不自动改写。

旧 `questionVersionId:'v1'`、旧 outbox 和既有云端事实原样保留，不强行映射当前题。
旧会话缺少固定版本时不能保证续做，保留原数据并提示重新开始；这是一项明确兼容代价。
原 dataEpoch、业务幂等、账号隔离与管理员权限保护不变。

带版本快照的批次使用独立 action `commitVersionedAttempts`（questionProtocol:1、attemptProtocol:2），
旧后端返回 BAD_ACTION，保留 outbox；不能让旧 commitAttempts 丢弃快照后接受事实。
纯历史队列沿用 commitAttempts。新处理器拒绝在旧 action 上提交新版本字段。

studySync 校验新快照的内容身份、原答案、分类与事实版本是否匹配；错误为 BAD_QUESTION_VERSION，
客户端保留待传项并停止无意义的永久错误重试。服务端尚未将每次作答与发布归档联查，且仍接收
客户端得分；因此这是版本追溯和内容一致性边界，不是服务端权威判分或反作弊保证。

**后续更新**：上述 questionProtocol:1 与只检查自签快照的边界由 [ADR 0018](0018-published-question-grading.md)
升级。当前版本化提交要求 questionProtocol:2，并对首次创建的事实按原发布归档判分、记录接收时间；
旧事实和历史聚合仍未验证，不补造证据。本文保留第一阶段决策背景。

## 验证、发布与回滚限制

替身覆盖管理员鉴权、坏内容、并发发布、旧强制写、事务中途失败回滚、归档读取失败、纠错/撤回/
回滚后旧版本保持、缓存失败/离线/乱序响应、真实练习页恢复、同步保留与拒绝变造快照。
旧练习页代码可复现：修订题库后恢复会话显示新题面；当前代码仍显示原题面与原解析。

上线前须在隔离 CloudBase/微信环境验证数据库规则（客户端不得直写归档与审计）、事务、单文档容量、
网络与本地存储限额；协调 bankSync、studySync、客户端升级。本提交不部署，也不读写真实学习数据。
回滚发布内容使用递增修订激活旧 release；不要回滚为允许旧 set 的处理器或丢弃快照的 studySync。
旧缓存保留用于代码回滚，但旧客户端不保证版本追溯，不能作为无损回滚的已验收承诺。

后续 #5：独立审核角色/状态机和逐题来源记录已由 ADR 0014 实现，仍需 CSV/逐行错误、来源公开展示、授权期限治理、大题库分页及缓存淘汰；
#3：领域完整迁移/服务端接收时间与更多投影；#11：快照重复存储和全量历史写盘的实测与优化。
