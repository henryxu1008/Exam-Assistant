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
| 我的 | 学习档案、每日目标与答题偏好设置、数据管理 |
| 登录 | 微信授权登录（强制登录），头像存云存储，资料存云数据库 |

- **间隔复习**：基于艾宾浩斯曲线，掌握等级 0–5 对应 0/1/2/4/7/15 天后复习；再次答错自动回归错题本。
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
│   └── login/            # 登录
├── components/
│   └── question-card/    # 题目卡片（单选/多选/判断/不定项/填空/排序渲染）
├── utils/
│   ├── questions.js      # 题库 + 统一判分 judge()
│   ├── store.js          # 答题记录 / 错题 / 复习计划 / 设置（本地存储）
│   ├── analytics.js      # 学情统计
│   ├── chart.js          # Canvas 2D 图表
│   ├── ai.js             # AI 讲解与对话（规则引擎）
│   ├── user.js           # 云开发登录与会话
│   └── config.js         # 云环境配置
└── cloudfunctions/
    ├── userLogin/        # 登录：code -> openid/token，用户落库
    └── userProfile/      # 资料：读取 / 更新 / 登出（token 校验）
```

## 快速开始

1. **开通云开发**：微信开发者工具 → 云开发，创建环境。
2. **配置环境 ID**：修改 `utils/config.js` 的 `cloudEnv`（当前已填 `cloud1-d4gye2rcib84f0347`，换成你自己的环境 ID）。
3. **创建数据库集合**：云开发控制台 → 数据库 → 新建集合 `users`。
4. **部署云函数**：右键 `cloudfunctions/userLogin`、`cloudfunctions/userProfile` → 上传并部署（云端安装依赖）。
5. 编译运行。

> 需要 `unionid` 时，在云函数 `userLogin` 的环境变量中配置 `APP_SECRET`，函数会用 `code` 调 `jscode2session` 换取；不配置则用云开发原生 `OPENID`，不影响登录。

## 题库

内置 51 道 mock 题，3 个科目：公共基础知识（22）、职业能力测验（12）、专业知识（17）。

支持 6 种题型，判分统一走 `utils/questions.js` 的 `judge(type, selected, answer)`：

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

替换真实题库时，直接改 `utils/questions.js` 的 `QUESTIONS` 即可，其余模块无需改动。

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

- **AI 助教为本地规则引擎**：`utils/ai.js` 的 `REMOTE_LLM.enabled` 默认 `false`，回复由本地模板 + 学情数据生成，不是真实大模型。接入真实模型时打开开关并实现请求层即可。
- **题库为 mock 数据**，题目内容与解析需替换为真实题库。
- 学情报告的 Canvas 图表在部分低版本基础库上可能需要适配。

## 许可

MIT
