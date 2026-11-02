# ADR 0014：独立题库审核与来源记录（Issue #5 第二阶段）

- 状态：Implemented，未部署；真实 CloudBase / 微信环境未验收
- 前置：ADR 0013 的不可变题目、发布快照及事务激活

## 决策与启用边界

第一阶段的 reviewed:true 是单管理员确认，不能证明另一人已经审核。本阶段增加个人身份与
编辑/审核/发布角色，以不可变草稿、审核收据和激活审计连接完整流程，不增加 CMS 或新服务。

先在隔离环境配置 `appConfig/bankRoles`，下例是占位身份，不能直接用于真实授权：

```json
{"editors":["<编辑openid>"],"reviewers":["<审核openid>"],"publishers":["<发布openid>"]}
```

角色不继承全局管理员名单或共享密钥。新接口只接受有效的个人 token；显式携带 adminSecret
返回 PERSONAL_IDENTITY_REQUIRED，不能靠密钥伪装成另一个审核人。token、用户身份及角色在
事务中重新读取，查询后换 token 或撤销角色不能沿用旧权限。配置缺失、损坏或读取失败均拒绝。

**第一次成功 createDraft 与 `questions/bank_workflow` 的 required 标记一起提交，启用严格流程。**
此后旧 publish(reviewed:true) 和 set(force:true) 在事务内拒绝，管理员密钥也不能绕过。
角色配置不能关闭该标记；当前发布还携带 workflowVersion 作为额外保护。标记损坏或读取失败
不能降级写入。启用前保留 ADR 0013 的兼容发布路径；上线验收必须显式完成启用与旧接口负面验证。
不得回滚为忽略严格标记的旧云函数，不能通过删除标记关闭流程。

## 状态与唯一约束

| 操作 | 必需角色与前置 | 结果 |
| --- | --- | --- |
| createDraft | editors；合法 bank、完整 sources、rightsConfirmed:true、稳定 submissionId | draft；未进入任何公开题库读取入口 |
| getDraft | editors/reviewers/publishers 任一角色 | 读取含来源证据的私有草稿；普通用户拒绝 |
| reviewDraft approve | reviewers；draft；审核人与创建人不同；sourceVerified:true、非空 note | approved；不可变审核收据和状态一起落盘 |
| reviewDraft reject | reviewers；draft；审核人与创建人不同；非空 note | rejected；原草稿不能被修改后再次审核 |
| publishDraft | publishers；approved；审核收据匹配；审核人当前仍具 reviewers；expectedRevision | published；归档、审计、镜像和草稿状态同事务提交 |

草稿地址为 `qd_<SHA256([editorOpenid,submissionId])>`；同提交 ID/同内容重试返回已有草稿，
改变题目或来源返回 DRAFT_OPERATION_CONFLICT，须换提交 ID。payloadDigest 绑定规范 releaseId
和逐题来源；审核收据 `qd_<摘要>_review` 绑定同一 payloadDigest、真实审核人、决定和时间。
创建人即使兼有审核角色也不能自审；发布人可与编辑或审核人相同，但必须具备独立配置的发布角色。

修改内容或补充来源需要新草稿和新审核，不允许把 approved 草稿指向另一份 bank。
审核重试不重写首次收据；并发不同审核决定只有一个能成功。已发布草稿重试返回首次发布修订，
不重复激活，也不把后续的新版本回滚。真正回滚必须新提交、独立审核，再按当前修订激活旧内容。

## 来源与授权记录

每个草稿题目都必须有且仅有一条来源，按 question.id 映射，并由草稿摘要绑定到该版本。
来源 kind 为 original / licensed / public_domain / ai_generated；全部要求 title、reference、
permission、attribution，AI 生成另要求 generator。不能遗漏、增加无关题号或用空授权说明代替。
题库内容仍受 500 题 / 600 KB 限制，全部来源 UTF-8 最多 160 KB，避免无界证据写入。

```json
{
  "action":"createDraft", "token":"<编辑个人token>", "submissionId":"import-20261101-1", "rightsConfirmed":true,
  "bank":{"manifest":{"subjects":[]},"questions":{}},
  "sources":{}
}
```

空题库示例用于撤回全部题目；实际导入的每个题号都必须填来源。例如：

```json
{"Q1":{"kind":"original","title":"原创题来源记录","reference":"<内部证据编号>","permission":"<授权范围说明>","attribution":"<署名>"}}
```

```json
{"action":"reviewDraft","token":"<审核个人token>","draftId":"qd_<摘要>","decision":"approve","sourceVerified":true,"note":"<审核结论>"}
```

```json
{"action":"publishDraft","token":"<发布个人token>","draftId":"qd_<摘要>","expectedRevision":0}
```

sourceVerified 是独立审核人对证据的确认，系统不自动证明实际版权归属、授权有效性或 AI 内容真实性。
私有证据引用不下发给普通客户端；公开署名展示、授权期限/撤销管理尚未完成，继续由 #5 跟踪。
当前公开 get/getPublished/getVersion 仍只读取已发布内容；草稿和拒绝内容不进入发布归档。

## 一致性、错误与回滚

创建、审核和发布分别使用事务。任何步骤的中途写失败，都不能留下半个启用标记、审核收据或发布。
legacy 发布与启用读取/写入同一个标记，因此并发请求只能按事务顺序发生，启用后不能插入旧写入。
复用 ADR 0013 的修订 CAS；STALE_PUBLICATION 保留 approved 草稿，读回并人工核对当前版本后再试。
审核期间撤销审核角色后，旧审批不能直接发布，需恢复授权或新建草稿重新审核。

常见明确错误：NOT_CATALOG_ROLE、ROLE_CONFIG_REQUIRED、SELF_REVIEW_FORBIDDEN、BAD_SOURCES、
RIGHTS_CONFIRMATION_REQUIRED、SOURCE_REVIEW_REQUIRED、DRAFT_NOT_APPROVED、REVIEW_ALREADY_DECIDED、
INVALID_REVIEW_RECEIPT、REVIEW_WORKFLOW_REQUIRED。未知读写失败为 WORKFLOW_FAILED，既有
legacy 路径保持 PUBLISH_FAILED / TX_FAILED；均不会返回假成功。

数据库规则必须拒绝客户端直接写 questions 的标记、草稿、收据、归档、镜像和审计；角色配置仅由
受控运维渠道维护。真正环境的权限规则、事务隔离、容量和多身份操作尚待隔离环境验收。
本提交不配置真实角色、不部署云函数、不读写真实学习数据、不调用付费 AI。

回滚内容使用新草稿审核发布，不改历史归档或收据。未发布草稿可保持 draft/rejected，不做物理删除；
后续数据保留和清理政策仍待定义。本阶段不改变客户端学习同步、原题快照、dataEpoch 或作答计数。

CSV/逐行导入报告、管理界面、来源公开展示、大题库分页、权威判分仍未完成，Issue #5 不关闭。


## 第三阶段工具补充

运营工具和 JSON/CSV 行级预检见 `docs/catalog-operations.md`。getCatalogAccess 只返回当前个人的目录角色，
不返回名单；共享来源校验模块由 shared/workflow-domain.js 与部署副本一致性检查维护。
可选 basePublication 绑定撤回草稿的发布基线并计入摘要，创建/激活事务都验证该基线；
旧草稿没有该字段时原摘要保持兼容。此约束防止基于旧完整快照的撤回覆盖后来新发布的题目。
