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

> `aiTutor` 的环境变量：`AI_TUTOR_ENABLED`（true/false）、`LLM_ENDPOINT`（OpenAI 兼容接口完整 URL）、`LLM_API_KEY`、`LLM_MODEL`（可选）、`AI_TUTOR_DAILY_CAP`（可选，每日上游调用次数上限，默认 200）。未配置或 `AI_TUTOR_ENABLED=false` 时，端上回落本地规则引擎。预算护栏已落地：每次成功调用上游大模型后，在云数据库集合 `aiTutorUsage`（按日期 `date` 累计 `count`）计数，超过上限即回落本地引擎，避免产生不可控费用。

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
| `exam_quiz_data_v1` | 答题记录、错题、复习计划、每日统计、设置、AI 对话 |
| `exam_quiz_session_v1` | 登录会话缓存（openid / token / 资料），仅缓存，不是身份来源 |

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
- **`aiTutorUsage` 集合（启用真实大模型时才需要）**：首次调用 `aiTutor` 会由云函数自动创建；如想避免首次写入延迟，可提前在控制台新建集合 `aiTutorUsage` 并给 `date` 建索引。预算护栏按 `date` 累计每日次数，超出 `AI_TUTOR_DAILY_CAP` 即回落本地引擎。
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

## 许可

MIT
