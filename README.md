# 备考刷题助手

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
| 登录 | 微信授权登录（强制登录），头像存云存储，资料存云数据库；登录页可查看《用户协议》《隐私政策》 |

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
│   │   ├── index.js      # 加载器：按科目懒加载分片 + 全部查询函数（统一判分 judge() 在此）
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
    └── aiTutor/          # AI 助教：大模型接入骨架（默认关闭，配置后启用）
```

## 快速开始

1. **开通云开发**：微信开发者工具 → 云开发，创建环境。
2. **配置环境 ID**：修改 `utils/config.js` 的 `cloudEnv`（当前已填 `cloud1-d4gye2rcib84f0347`，换成你自己的环境 ID）。
3. **创建数据库集合**：云开发控制台 → 数据库 → 新建集合 `users`。
4. **部署云函数**：右键 `cloudfunctions/userLogin`、`cloudfunctions/userProfile`、`cloudfunctions/aiTutor` → 上传并部署（云端安装依赖）。
5. 编译运行。

> 需要 `unionid` 时，在云函数 `userLogin` 的环境变量中配置 `APP_SECRET`，函数会用 `code` 调 `jscode2session` 换取；不配置则用云开发原生 `OPENID`，不影响登录。

> `aiTutor` 的环境变量：`AI_TUTOR_ENABLED`（true/false）、`LLM_ENDPOINT`（OpenAI 兼容接口完整 URL）、`LLM_API_KEY`、`LLM_MODEL`（可选）、`AI_TUTOR_DAILY_CAP`（可选，每日上游调用次数上限，默认 200；必须为非负安全整数，显式配置 0 表示不限制）。未配置或 `AI_TUTOR_ENABLED=false` 时，端上回落本地规则引擎。预算护栏在调用上游之前原子预约一次额度：`aiTutorUsage` 以日期作为唯一 `_id`，条件自增 `count`；并发创建也共用一个计数器。超过上限、配置无效或数据库不可用时回落本地引擎。预约后上游失败仍计入次数，不退还额度，以保证调用次数上限。

## 题库

内置 51 道 mock 题，3 个科目：公共基础知识（22）、职业能力测验（12）、专业知识（17）。

支持 6 种题型，判分统一走 `utils/bank/index.js` 的 `judge(type, selected, answer)`：

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
- **换真实大题库 / 上云**：把各分片的 `require` 换成异步拉取（fetch / 分包加载）即可，`index.js` 其余逻辑不动。

## 数据说明

**本地存储**（`wx.setStorageSync`）

| key | 内容 |
| --- | --- |
| `exam_quiz_data_v1__<openid>` | 答题记录、错题、复习计划、每日统计、设置、AI 对话；**按用户命名空间隔离**，切换账号互不可见（见 Issue 1） |
| `exam_quiz_session_v1` | 登录会话缓存（openid / token / 资料），仅缓存，不是身份来源；token 仅存本地、不下发到公开 profile |

**本地数据隔离（Issue 1）**：`store.js` 按可信 `openid` 命名空间存储，账号 A 登出、账号 B 登录后无法读取 A 的数据；首启动会把旧版全局 key 一次性迁移到对应用户命名空间。会话校验以**服务端令牌验证为主**（`userProfile` 校验 token 是否仍有效，覆盖撤销/过期/跨设备失效），不再仅依赖 `wx.checkSession`。传输失败或业务服务不可用时保留未被拒绝的离线会话；明确返回 `INVALID_TOKEN` / `NO_TOKEN` 时先撤销旧会话，自动重登失败也不恢复失效令牌。

**AI 对话生命周期**：页面历史与异步回复绑定到仓储中的对话代次。切换账号（包括 A→B→A）、清空学习数据或清空对话都会使旧代次失效；页面先重载当前账号历史，再消费预填问题。远程成功、异常回落、本地延迟回复和清空确认框均校验所属代次，避免旧操作写入新用户或复活已删除的对话。

**练习状态机与不可变作答（Issue 2 / Issue 3）**：每轮练习创建 `practiceSession`（状态 `created → in_progress → completed`），每题绑定 `attemptId`，以 `clientOpId` 实现**幂等提交**（重复点击只落库一次、不重复计数）；已提交题在会话内回看为只读，主动重练生成新 Session。单次作答作为不可变事实追加到 `attempts[]`（AnswerAttempt），聚合统计由事件派生。详见 `docs/adr/0003-answer-attempt-domain.md`。

**云端**（云开发数据库集合 `users`）

| 字段 | 说明 |
| --- | --- |
| `openid` / `unionid` | 用户标识 |
| `token` / `tokenAt` | 会话令牌，登出时作废 |
| `nickName` / `avatarUrl` / `exam` | 昵称、头像云存储 fileID、目标考试 |
| `createdAt` / `lastLoginAt` | 创建与最近登录时间 |

答题数据仍存本地，未同步到云端——多设备同步需要另行开发。

## 已知限制

- **AI 助教默认走本地规则引擎**：`utils/ai.js` 的 `REMOTE_LLM.enabled` 默认 `false`，回复由本地模板 + 学情数据生成，不是真实大模型。已预留云函数 `aiTutor`（OpenAI 兼容 chat/completions 骨架，默认关闭、安全护栏齐全），接入真实模型时：① 在 `aiTutor` 的环境变量配置 `AI_TUTOR_ENABLED=true`、`LLM_ENDPOINT`、`LLM_API_KEY`（可选 `LLM_MODEL`）；② 把端上 `REMOTE_LLM.enabled` 改为 `true`。云函数未启用时端上自动回落本地引擎，互不影响。
- **题库为 mock 数据**，题目内容与解析需替换为真实题库。

## 上线前核对

- **`users` 集合建索引**：控制台给 `openid`、`token` 各建一个索引，否则用户量增长后按 token 查询会全表扫描。
- **`aiTutorUsage` 集合（启用真实大模型时才需要）**：部署前在控制台创建集合 `aiTutorUsage` 并给 `date` 建索引。每日计数文档 `_id` 固定为日期（如 `2026-10-30`），依靠 `_id` 唯一约束防止重复计数器；首次升级会分页汇总当天旧版随机 ID 文档的 `count`，保留旧文档。切换时应停止旧版云函数接收新调用，待在途调用结束后启用新版，避免旧版继续写入随机计数器。集合缺失、计数服务故障或达到上限时回落本地答疑，不调用付费上游。
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
