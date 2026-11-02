# 题库运营工具（Issue #5 第三阶段）

当前代码提供离线预检和最小小程序管理页；未部署、未配置真实角色，以下线上操作只用于后续隔离环境验收。
使用已有个人登录与 bankRoles，不新增密码、共享密钥输入或独立 CMS。

## 离线预检

```bash
npm run catalog:check -- --input docs/examples/catalog-import.json --format json
npm run catalog:check -- --input docs/examples/catalog-import.csv --format csv
npm run catalog:check -- --input input.csv --format csv --prepared /tmp/catalog-prepared.json
```

默认只读输入，stdout 为 `{ok,total,validCount,errors,releaseId?}`，不输出题面、答案、来源证据或 token。
退出码 0=整批有效，2=数据校验失败，1=文件/编码/用法/输出失败。输入为 UTF-8，支持 BOM；
不接受超过 2 MB 的输入。prepared 只在全批通过后显式新建，权限 0600，不覆盖已有文件或输入。
准备文件含完整题目和私有来源证据，不能把它当成脱敏报告。

错误项为 `{row,field,code}`；CSV row 是物理起始行号（包含带换行的单元格），JSON row 是题目记录序号，
row=0 表示文件/清单错误。默认整批拒绝，validCount 仅用于定位，不能作为部分成功发布的依据。
修复所有错误后重跑；不会静默跳过坏题、坏来源、重复题号或错误分类。

JSON 接受 `{bank:{manifest,questions},sources}` 或 `{manifest,questions,sources}`。
保留未使用科目/章节，不推断修改分类。空导入拒绝，防止误清空；全部撤回须走显式撤回草稿。

CSV 必需列：

```
id,subjectKey,subject,chapterKey,chapter,type,stem,options,answer,sourceKind,sourceTitle,sourceReference,sourcePermission,sourceAttribution
```

可选列：level、explain、pitfall、keyPoint、tags、sourceGenerator。options/answer/tags 单元格是 JSON；
含逗号、换行或双引号时使用 CSV 双引号转义。列头重复、未知列、列数不匹配和坏 JSON 均报错。
仍受服务端 500 题 / 600 KB 内容、160 KB 来源限制；逐题来源规则见 ADR 0014。
仓库中的两个样例全部为合成数据，不代表真实题目的来源授权。

## 最小管理页

隔离环境准备步骤：配置 bankSync / studySync 的当前版本、数据库规则及个人角色，按 ADR 0014 验证身份隔离。
在微信开发者工具把启动页面设为 `pages/catalog-admin/catalog-admin`，用具有目录角色的个人账号登录。
普通账号只能取得自己的空角色列表，不能读取私有草稿或执行操作。旧后端不支持新权限读取时不会降级开放。
管理页没有普通学习页面的导航入口；真实微信布局、容量与多账号操作尚待设备验收。

1. **编辑**：粘贴完整 JSON/CSV，点击本地预检，核对报告；输入稳定提交 ID，并确认有发布权，再提交草稿。
2. **独立审核人**：取得草稿 ID，读取完整题目和来源证据，核验后填写结论并确认来源，再批准或拒绝。
3. **发布人**：读取对应草稿，读取并核对当前修订号，按该修订发布。服务端角色、禁止自审和修订 CAS 始终生效。
4. **纠错**：修改完整快照和来源后换提交 ID，重新预检、审核、发布。不能原地修改已批准内容。
5. **撤回**：填当前已发布草稿 ID、待撤回题号和新提交 ID，确认来源后提交撤回草稿；再独立审核并发布。

管理页输入最多 UTF-8 200 KB，草稿预览最多 400 KB；超限明确拒绝，不截断 CSV 或不完整展示后允许审核。
较大数据的离线预检仍可运行，但大批次管理入口、分页预览和管理列表属于 #5 后续范围。
修改输入会作废预检和发布权确认；换草稿会清除已读证据和核验状态。切账号、隐藏/卸载及延迟登录回调
不能让旧任务在新身份继续执行或把私有内容显示到新页面。凭据只从当前登录会话读取，不进入表单或预检报告。

撤回客户端读取当前已发布草稿与修订，生成保留其余题目及来源的新草稿；服务端把 basePublication
（releaseId、revision）绑定进草稿摘要，并在创建与发布事务中检查。若基线发生变化，返回 STALE_BASE_RELEASE；
即使发布人输入新的当前修订号，也不能把旧撤回草稿强行激活，须基于最新库重新生成并审核。
对全部题目的撤回同样需要确认、草稿、独立审核与发布，不复用空导入完成清空。

## 已验证与仍未验收

合成替身运行真实 bankSync、studySync、题库加载器与 store，覆盖导入 → 草稿 → 独立审核 → 发布 →
拉题 → 作答同步 → 纠错 → 原题追溯 → 撤回；无效行、权限失败、丢失/过时上下文和过时撤回均不绕过保护。
前述验证不等于真实 CloudBase 事务/数据库规则、微信容量和多设备验收。

#5 继续 Open：来源公开署名、授权期限治理、管理列表/大批次预览、大题库分页及权威判分仍待完成。
#11 的存储基线见 `docs/reports/learning-storage-baseline-2026-11-02.md`；本轮不改仓储格式或迁移真实数据。
