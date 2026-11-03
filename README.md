# 回练

面向事业单位 / 公考备考的微信小程序：刷题、错题本、间隔复习、学情报告、AI 助教讲解。

原生小程序 + 微信云开发，无需自建服务端。

---

## 功能

| 模块 | 说明 |
| --- | --- |
| 首页 | 今日目标进度、连续打卡、薄弱知识点预览、多种练习入口 |
| 刷题 | 顺序 / 随机 / 薄弱突破 / 到期复习 / 错题重做 / 章节专练 / 单题重练；提交后即出解析，可一键 AI 讲解 |
| 错题本 | 全部 / 顽固 / 待复习 / 收藏四分类，科目筛选，单题重练、AI 讲解、收藏、标记「已掌握」 |
| 学情报告 | 正确率总览、知识点雷达图、近 7 天正确率趋势、模块正确率条形图、薄弱/优势清单、AI 建议 |
| AI 助教 | 对话式答疑，支持诊断、制定计划、讲解单题、举一反三，对话本地持久化 |
| 我的 | 学习档案、每日目标与答题偏好设置、数据管理、用户协议 / 隐私政策入口 |
| 登录 | 可选：默认游客态可直接刷题（数据存本机 `anon` 作用域），登录后云端同步，游客期间的记录会一并并入账号；头像存云存储，资料存云数据库；登录页可查看《用户协议》《隐私政策》，也可「先随便逛逛」 |

- **间隔复习**：基于艾宾浩斯曲线，掌握等级 0–5 对应 0/1/2/4/7/15 天后复习；再次答错自动回归错题本。
- **自动掌握**：同一道题连续 3 天答对，自动移出错题本（也可在错题本手动标记「已掌握」）。
- **学情统计**：正确率低于 60% 且至少答过 2 题的知识点判定为薄弱。

## 技术栈

- 微信小程序原生开发（无框架、无构建）
- 微信云开发：云函数 `wx-server-sdk`、云数据库、云存储
- Canvas 2D 绘图（`utils/chart.js`）
- 基础库要求：**2.21.2+**（头像 `open-type="chooseAvatar"` 与 `input type="nickname"` 依赖）

## 目录结构

```
miniprogram-4/
├── app.js                # 云开发初始化、启动会话校验、练习页跳转入口
├── app.json              # 页面注册与 tabBar
├── pages/
│   ├── index/            # 首页（tab）
│   ├── practice/         # 刷题（tab）
│   ├── mistakes/         # 错题本（tab）
│   ├── ai/               # AI 助教（tab）
│   ├── profile/          # 我的（tab）
│   ├── analysis/         # 学情报告
│   ├── agreement/        # 用户协议 / 隐私政策
│   └── login/            # 登录
├── components/
│   └── question-card/    # 题目卡片（单选/多选/判断/不定项/填空/排序渲染）
├── utils/
│   ├── questions.js      # 题库入口：直接 re-export utils/bank/index.js（对外 API 不变）
│   ├── bank/
│   │   ├── manifest.js   # 科目 / 章节清单（manifest 驱动，页面与统计口径都从这里取）
│   │   ├── index.js      # 加载器：按科目懒加载分片 + 查询函数（导出共享 judge()）
│   │   ├── gk.js         # 分片：公共基础知识（module.exports = [题目...]）
│   │   ├── nl.js         # 分片：职业能力测验
│   │   └── it.js         # 分片：专业知识
│   ├── store.js          # 答题记录 / 错题 / 复习计划 / 设置（本地存储）
│   ├── analytics.js      # 学情统计
│   ├── chart.js          # Canvas 2D 图表
│   ├── ai.js             # AI 讲解与对话（规则引擎）
│   ├── user.js           # 云开发登录与会话（含页面登录拦截）
│   ├── agreement.js      # 用户协议与隐私政策文本
│   └── config.js         # 云环境配置
└── cloudfunctions/
    ├── userLogin/        # 登录：code -> openid/token，用户落库
    ├── userProfile/      # 资料：读取 / 更新 / 登出（token 校验）
    ├── studySync/        # 学习档案与流水：事务提交 / 恢复 / 清空代次
    ├── bankSync/         # 公开读题库、管理员导入
    ├── initConfig/       # 管理员初始化运营配置
    └── aiTutor/          # AI 助教：大模型接入骨架（默认关闭，配置后启用）
```

## 快速开始

1. **开通云开发**：微信开发者工具 → 云开发，创建环境。
2. **配置环境 ID**：修改 `utils/config.js` 的 `cloudEnv`（当前已填 `cloud1-d4gye2rcib84f0347`，换成你自己的环境 ID）。
3. **创建数据库集合**：`users`、`studyStats`、`attempts`、`questions`、`appConfig`；启用真实 AI 时另需 `aiTutorUsage`。
4. **准备云函数**：各函数目录独立打包、安装依赖；先按 [ADR 0009](docs/adr/0009-sync-integrity-and-resource-permissions.md) 验证事务、索引、管理员及新旧客户端兼容，再协调发布。题库由管理员显式导入，普通客户端不自动播种。
5. 编译运行。

> 需要 `unionid` 时，在云函数 `userLogin` 的环境变量中配置 `APP_SECRET`，函数会用 `code` 调 `jscode2session` 换取；不配置则用云开发原生 `OPENID`，不影响登录。

> `aiTutor` 的环境变量：`AI_TUTOR_ENABLED`、`LLM_ENDPOINT`、`LLM_API_KEY`、`LLM_MODEL`（可选）、全局每日 `AI_TUTOR_DAILY_CAP`（默认 200，非负安全整数，显式 0 为无全局限制）、每用户每日 `AI_TUTOR_USER_DAILY_CAP`（默认 20，正安全整数）。远端请求必须携带有效业务 token。两份配额在同一事务预约；鉴权、配额或上游失败均可回落本地，上游失败仍计入次数。默认关闭。

## 题库

内置 51 道 mock 题，3 个科目：公共基础知识（22）、职业能力测验（12）、专业知识（17）。

新题库使用不可变题目版本与发布快照。第一阶段支持管理员 bankSync.publish；启用独立审核流程后，改由编辑创建草稿、另一人审核、发布角色按修订号激活，旧单管理员路径被拒绝；纠错、撤回和回滚都保留旧归档。客户端只读取 getPublished，缓存落盘后才切换；练习会话和新作答保留原题快照，旧 v1 记录不推测版本。接口、权限、兼容和剩余范围见 [ADR 0013](docs/adr/0013-immutable-question-releases.md)。独立角色、来源记录、启用与兼容边界见 [ADR 0014](docs/adr/0014-independent-catalog-review.md)。本阶段未部署，真实环境未验收。

支持 6 种题型，端上经 `utils/bank/index.js` 导出 `shared/grading-domain.js` 的 `judge(type, selected, answer)`。
新增版本化作答由 studySync 按原发布归档重新判分，归档失败或分数不符则整批拒绝、保留待传项；旧事实不重判。
协议、服务端接收时间、旧数据与上线限制见 [ADR 0018](docs/adr/0018-published-question-grading.md)。
1.2.0 / 1.3.0 客户端与服务端升级组合、可复现命令和原生验收项见 [协议升级指南](docs/grading-upgrade-acceptance.md)。

| type | 题型 | 题数 | 作答方式 | 判分规则 |
| --- | --- | --- | --- | --- |
| `single` | 单选题 | 36 | 单选 | 集合相等 |
| `multiple` | 多选题 | 3 | 多选 | 集合相等（少选/多选均判错） |
| `judge` | 判断题 | 4 | 单选（A 正确 / B 错误） | 集合相等 |
| `uncertain` | 不定项选择 | 3 | 多选 | 集合相等 |
| `fill` | 填空题 | 3 | 按空位填写 | 逐空比对，支持同义答案数组；忽略大小写与全部空白 |
| `sort` | 排序题 | 2 | 点击选项依次入列，可 ↑↓ 调整 | 顺序全等 |

题目字段：

```js
{
  id, subject, chapter, type, level, stem,
  options: [{ key, text }],   // 填空题无此字段
  answer: [],                 // 见上表；填空每项可为字符串或同义答案数组
  explain, pitfall, keyPoint, tags
}
```

**题库按科目拆分管理（已落地）**：科目 / 章节定义集中在 `utils/bank/manifest.js`（manifest 驱动，页面科目列表与统计口径都从它取）；题目数据按科目拆到 `utils/bank/<key>.js` 分片（`gk` / `nl` / `it`），经 `utils/bank/index.js` 懒加载并对外提供全部查询函数，`utils/questions.js` 仅作兼容入口。

- **换科目 / 章节**：改 `manifest.js` 即可，题目分片不变。
- **加科目**：① 在 `manifest.js` 追加一项；② 新建对应的 `utils/bank/<key>.js`（`module.exports = [题目...]`）；其余查询函数无需改动。
- **发布题库**：按 ADR 0014 配置个人角色并完成首个草稿以启用严格审核流程；之后使用 createDraft / reviewDraft / publishDraft，旧 publish 和 set 均拒绝。现阶段全量发布限制 500 题 / 600 KB，大题库分页及来源审核继续跟踪 #5。

## 数据说明

**本地存储**（`wx.setStorageSync`）

| key | 内容 |
| --- | --- |
| `exam_quiz_data_v1__<openid>` | 答题记录、错题、复习计划、每日统计、设置、AI 对话；**按用户命名空间隔离**，切换账号互不可见（见 Issue 1） |
| `exam_quiz_session_v1` | 登录会话缓存（openid / token / 资料），仅缓存，不是身份来源；token 仅存本地、不下发到公开 profile |

**本地数据隔离（Issue 1）**：`store.js` 按可信 `openid` 命名空间存储，账号 A 登出、账号 B 登录后无法读取 A 的数据；首启动会把旧版全局 key 一次性迁移到对应用户命名空间。会话校验以**服务端令牌验证为主**（`userProfile` 校验 token 是否仍有效，覆盖撤销/过期/跨设备失效），不再仅依赖 `wx.checkSession`。传输失败或业务服务不可用时保留未被拒绝的离线会话；明确返回 `INVALID_TOKEN` / `NO_TOKEN` 时先撤销旧会话，自动重登失败也不恢复失效令牌。

**AI 对话生命周期**：页面历史与异步回复绑定到仓储中的对话代次。切换账号（包括 A→B→A）、清空学习数据或清空对话都会使旧代次失效；页面先重载当前账号历史，再消费预填问题。远程成功、异常回落、本地延迟回复和清空确认框均校验所属代次，避免旧操作写入新用户或复活已删除的对话。

**跨设备清空 AI 历史**：客户端持久化每次 clearId，服务端 clearAI 事务统一生成 aiEpoch，并保存幂等回执。独立清空不会获得相同代次，丢失回包后的重试也不会误删另一设备的新消息。待确认时消息和学习数据继续保存在本地，云同步在确认后恢复；旧代次 AI 片段不会阻断新作答流水的提交。协议与回执保留策略见 ADR 0009。

**匿名（游客）使用**：登录不是使用前提，符合微信「不得强制授权登录」的平台要求。启动时无论是否登录都会完成会话校验，页面通过 `whenReady(onReady)` 等待 `whenSessionReady` 后刷新数据、创建/恢复练习和消费 AI 预填内容；未登录时按 `anon` 作用域读写本地档案，`syncNow()`/云删除/云端 AI 均有 `isLogged()` + `openid === scope` 双守卫，匿名态不发任何同步请求。只有真正需要身份的能力（云端同步、题库管理端）走 `requireAccount()`，未登录时不跳转，由调用方用 `promptLogin()` 让用户自己决定；登录页也提供「先随便逛逛」出口。网络不可达返回 unknown 时继续保留离线练习能力，已离开的页面不执行过期初始化回调。

**游客档案并入账号**：`user.login()` 在切换作用域前调用 `store.adoptGuestProfile(openid)`。它只在「该账号在本机还没有任何档案」时把 `anon` 档案一次性写入账号作用域：账本类数据走 `mergeStats` 归一化，`syncCursor` / `dataEpoch` / `pendingDeleteId` / `aiClearQueue` 一律丢弃（游客的清空意图不能替账号发起云端删除），`attemptOutbox` 不搬运，由 `load()` 按 `attempts` 重建待传队列，使游客作答在登录后正常上云。写入只到本地，随后首次拉取仍按 `mergeStats` 与账号云端档案双向合并，服务端写入同样是 `mergeStats`，因此不会用游客档案整doc覆盖账号备份（评审 P1）。匿名档案不删除，退出登录后仍可继续以游客身份使用。

**练习状态机与不可变作答（Issue 2 / Issue 3）**：每轮练习创建 `practiceSession`（状态 `created → in_progress → completed`），每题绑定 `attemptId`，以 `clientOpId` 实现**幂等提交**（重复点击只落库一次、不重复计数）；已提交题在会话内回看为只读，主动重练生成新 Session。单次作答作为不可变事实追加到 `attempts[]`（AnswerAttempt），聚合统计由事件派生。详见 `docs/adr/0003-answer-attempt-domain.md`。

**云端**（云开发数据库集合 `users`）

| 字段 | 说明 |
| --- | --- |
| `openid` / `unionid` | 用户标识 |
| `token` / `tokenAt` | 会话令牌，登出时作废 |
| `nickName` / `avatarUrl` / `exam` | 昵称、头像云存储 fileID、目标考试 |
| `createdAt` / `lastLoginAt` | 创建与最近登录时间 |

服务端过期清理和登出均按读取时的 `(_id, token)` 条件原子撤销：旧请求读完后若已有新登录换发令牌，旧请求不再清除新会话；过期令牌即使清理写入失败也不会被接受。

学习档案与流水经 `studySync` 同步到 `studyStats` / `attempts`。作答经 commitAttempts / commitVersionedAttempts 按业务键事务去重；客户端先将作答与待传队列一起落盘，验证提交 ID、云端事实和判分证据后才持久出队。版本化批次每批最多 24 条（questionProtocol:2），纯历史批次最多 32 条；每批确认独立保存进度，最后一批发布完整会话/设置快照。题目和每日计数按已接受事实累计，历史基线与旧 v1 提交保持未验证。首次全量恢复后按服务端序号增量读取作答；恢复分页校验同一修订号，完整恢复结果与游标一起落盘。登录、前台和网络恢复事件共享有界同步任务；清空以服务端 dataEpoch 阻断其他设备旧快照。题库写入仅允许管理员。

持久 outbox 与按 ID 确认对应 #7 第一阶段；作答增量恢复及生命周期触发对应第二阶段，协议、旧写入器兼容和索引验收见 [ADR 0011](docs/adr/0011-incremental-recovery-and-lifecycle-sync.md)。第三阶段业务幂等、规范 ID、事实计数和只读对账见 [ADR 0012](docs/adr/0012-business-idempotency-and-readonly-reconciliation.md)。旧聚合仍保留历史基线；真实环境/历史差异验收、题目不可变版本与仓储拆分分别跟踪在 #7、#5、#11。原有事务/权限边界见 [ADR 0009](docs/adr/0009-sync-integrity-and-resource-permissions.md)，队列契约、旧数据重放、同步写盘成本及发布/回滚约束见 [ADR 0010](docs/adr/0010-durable-attempt-outbox.md)。

**离线只读对账**：`npm run audit:learning -- --input <单账号离线快照.json>`。退出码 0=当前范围一致，2=已证明差异，3=历史未知，1=输入/用法失败；不访问云或写回文件。旧聚合缺少明细时不会补造流水，`consistent` 也不代表已完成云同步。新提交需要先发布支持 commitAttempts 的后端；旧后端会明确拒绝并保留本地待传项。

## 题库运营与存储基线

离线检查：`npm run catalog:check -- --input docs/examples/catalog-import.csv --format csv`。
小程序管理页为 `pages/catalog-admin/catalog-admin`，具备目录角色的账号可从个人页进入；v3 支持可视化维护和 JSON/CSV 全量导入。v4 支持完整 JSON 文件分片上传、逐页独立审核和原子发布，学习端分片缓存及原发布判分；首版最多 20 页、每页 100 题、总计 2000 题，另有页大小和登记容量限制。v4 支持基于已发布内容逐题编辑，并可由创建人丢弃未封存的私有暂存；详细操作与限制见 [运营指南](docs/catalog-operations.md) 和 [ADR 0020](docs/adr/0020-paged-catalog.md)。
接口权限仍由服务端检查；用法、大小限制与隔离环境验收步骤见 [运营指南](docs/catalog-operations.md)。 管理员可选择知识点生成 AI 候选题并核对后加入编辑工作区；配置与权限边界见 [AI 出题说明](docs/ai-question-generation.md)，功能默认关闭，尚未部署。

合成存储基线：`npm run bench:learning -- --sizes 1000,10000 --runs 5`，只用进程内存储、不访问云。
[基线报告](docs/reports/learning-storage-baseline-2026-11-02.md) 记录整档写入随历史增长的成本，仓储优化继续跟踪 #11。

已确认作答现在由用户隔离的本地仓储分段保存，活动检查点保留聚合、会话、AI 和待传项；
首次迁移准备失败可延期使用完整原格式，已有分段损坏明确失败。格式、备份、回滚、应用 1.1.0 升级约束及
剩余风险见 [ADR 0015](docs/adr/0015-scoped-local-repository.md)，
[分段后报告](docs/reports/learning-storage-segmented-2026-11-02.md) 同时记录写入减少和迁移额外成本。
代码未部署；微信配额、同步迁移耗时、断电/损坏恢复尚待真实环境验收。

首次迁移现按运行时总占用和额度预估新增空间，空间不足或额度未知时保留完整原格式并延期；
“我的”页显示本地保存/迁移/清理状态并提供本地检查重试。保存结果不确定时须重启核对，不能盲用旧内存或备份覆盖。
配额与子进程中断测试、重试边界及微信隔离验收清单见 [ADR 0016](docs/adr/0016-storage-capacity-and-recovery.md)。

AI 历史现可在本地按有序内容页保存，普通作答复用历史；学习仓储的每次写入有 900 KiB 单项工程预算，
大迁移档案分块保留。超限明确失败且保留待传流水，已有 AI 分段损坏不降级。
格式 v5、应用 1.2.0 兼容与回滚限制见 [ADR 0017](docs/adr/0017-paged-ai-history-and-entry-budgets.md)。
云端 AI 同步与现有最近 60 条新增保留策略不变，真实微信验收仍待完成。

## 已知限制

- **AI 助教默认走本地规则引擎**：`utils/ai.js` 的 `REMOTE_LLM.enabled` 默认 `false`，回复由本地模板 + 学情数据生成，不是真实大模型。已预留云函数 `aiTutor`（OpenAI 兼容 chat/completions 骨架，默认关闭、安全护栏齐全），接入真实模型时：① 在 `aiTutor` 的环境变量配置 `AI_TUTOR_ENABLED=true`、`LLM_ENDPOINT`、`LLM_API_KEY`（可选 `LLM_MODEL`）；② 把端上 `REMOTE_LLM.enabled` 改为 `true`。云函数未启用时端上自动回落本地引擎，互不影响。
- **题库为 mock 数据**，题目内容与解析需替换为真实题库。

## 上线前核对

- **`users` 集合建索引**：控制台给 `openid`、`token` 各建一个索引，否则用户量增长后按 token 查询会全表扫描。
- **`aiTutorUsage` 集合（启用真实大模型时才需要）**：部署前在控制台创建集合 `aiTutorUsage` 并给 `date` 建索引。全局计数 `_id` 为日期（如 `2026-10-30`），每用户计数 `_id` 为 `user:<日期>:<openid>`，两者共同事务预约；首次升级会分页汇总当天旧版随机 ID 文档的 `count`，保留旧文档。切换时应停止旧版云函数接收新调用，待在途调用结束后启用新版，避免旧版继续写入随机计数器。集合缺失、计数服务故障或达到上限时回落本地答疑，不调用付费上游。
- **协议文本**：`utils/agreement.js` 中的主体名称与联系方式是占位内容，需替换；并与微信后台「用户隐私保护指引」保持一致，两者不一致会被驳回。
- **隐私接口**：本小程序未调用位置、相册等隐私接口，暂无需在指引中声明。
- 学情报告的 Canvas 图表在部分低版本基础库上可能需要适配。

## 本地测试与 CI

> 对应 Issue 4：在不依赖微信运行时的前提下，对判分 / 复习 / 学情等纯函数建立回归测试。

工程根目录新增了 `package.json`（仅用于测试 / lint，不影响小程序运行时），需要 Node >= 18。

```bash
npm test        # 运行 test/*.test.js（node --test 默认发现）
npm run lint    # 语法校验全部工程 JS（无外部依赖，vm.Script 解析）
```

测试通过 `test/wx-shim.js` 注入内存版 `wx` Storage 适配器，使 `store` / `analytics` 可在 Node 下运行；
`test/date-mock.js` 提供可控 `Date` 桩，覆盖跨日、复习到期、掌握等级变化等时间相关逻辑。
每个用例通过清除 `require` 缓存 + 清空内存存储实现相互隔离。

GitHub Actions 在 `.github/workflows/ci.yml`：PR 中自动执行 `npm run lint` 与 `npm test`，失败则阻止合并。

**风险 / 回滚**：测试与 lint 为纯增量，不影响线上小程序；若 CI 误拦，回退对应提交即可，小程序代码本身未被改动。

## 架构演进（Architecture V2）

`Issue 1–4` 已落地（见上方说明）：本地测试/CI、按用户隔离与会话安全、练习状态机与 AnswerAttempt 领域模型。

`Issue 5–8` 涉及后端（动态题库 / Go 模块化单体 / 云端同步 / AI 服务端），需 PostgreSQL、Go、Docker 等环境，
本地暂以 **ADR + 数据契约** 形式交付，落地实现待后端环境就绪：

- `docs/adr/0005-dynamic-question-bank.md`：动态题库、题目版本与审核发布
- `docs/adr/0006-go-modular-monolith.md`：Go 模块化单体与 OpenAPI 契约
- `docs/adr/0007-cloud-sync-offline-queue.md`：云端同步、离线队列与多设备一致性
- `docs/adr/0008-ai-tutor-server.md`：AI Tutor 服务端适配、分级提示与评测

## 许可

MIT
