# 深度网页浏览方案：多轮 open_page 工具 + 二期 Playwright 交互 + 三期扫码登录

> 状态：设计稿（未实现）
> 前置依赖：`src/agent/loop.ts`（LangGraph 五节点图）、`src/services/search.ts`（Tavily）、`src/services/vision.ts`（千问识图，二期复用）
> 日期：2026-08-24

## 1. 背景与目标

用户诉求：让机器人能"像浏览器一样"深度检索网页——

1. **深层访问**：读到一页后，注意到页面里的内层 URL，进一步点进去，逐层挖到目标信息；
2. **组件交互**：和网页上的按钮、输入框等元素互动（翻页、展开、提交查询）。

现状差距：项目目前唯一的联网能力是 Tavily 搜索（`src/services/search.ts`），只拿得到标题+摘要+URL，**没有任何 HTML 抓取与解析代码**（全项目零 cheerio/jsdom/playwright 依赖）。"深挖一层"与"按按钮"都无从谈起。

## 2. 调研结论：技术选型

| 方案 | 能力 | 体积/成本 | 结论 |
|---|---|---|---|
| 原生 fetch + 正则提链接 | 只有静态 HTML，链接提取极脆弱（注释里的 URL、拼接属性都会漏/错） | 零依赖 | 仅作兜底，不推荐 |
| **cheerio**（约 30k stars，MIT） | jQuery 子集 API 解析 HTML：选择器、提正文、提链接 | 纯 JS、无原生编译，TS/ESM 原生支持 | **一期采用**，最小可行依赖 |
| @mozilla/readability + jsdom | Firefox 阅读视图同款正文提取，效果好 | jsdom 体积大、依赖树深 | 正文提取增强可后补，非必需 |
| Jina Reader（r.jina.ai 前缀） | 网页转 markdown 的托管服务 | 外部服务；本次调研中该域名从本机网络不可达；页面内容要发给第三方 | 记为备选，不采用 |
| **Playwright** | 无头浏览器：JS 渲染、点击、填表、截图 | 需下载浏览器二进制（~百 MB 级），重 | **二期采用**，交互能力的唯一现实路径 |

两个关键调研事实：

- **"与按钮交互"必须有无头浏览器**。按钮 onClick 的行为是 JS 运行时产生的，静态解析永远拿不到。Playwright 无头模式下点击/填表/截图能力完整，且官方定位明确包含 "AI agents" 场景。
- **截图可以白嫖现有识图链路**。Playwright 截图 → 喂给 `src/services/vision.ts`（千问 qwen 识图）→ 用视觉模型理解"点完之后页面变成了什么样"，形成"DOM 不确定时用视觉兜底"的闭环。

## 3. 核心决策

### 3.1 "深度"来自多轮工具调用，不来自工具内部递归

两种实现"逐层深挖"的路线：

| 路线 | 做法 | 问题 |
|---|---|---|
| 工具内部递归 | 一个 `deep_crawl(url)` 工具内部 BFS 抓 N 层，把结果一次性返回 | 每层抓什么、抓多深是**代码写死的启发式**，不是智能判断；且返回内容极易撑爆上下文 |
| **多轮工具循环（采用）** | 模型调 `open_page` 看一页 → 自己决定点哪个链接 → 再调 `open_page` → …… | 哪个链接值得跟、什么时候信息够了该收尾，全部由模型判断——这才是"深度检索"的含义 |

后者需要把 `src/agent/loop.ts:40` 的 `MAX_TOOL_TURNS` 从 1 调到 6。该文件头部注释明确预留了这条路（"以后想让模型连续调多轮工具，还是只改 MAX_TOOL_TURNS 这个数字，不用动图结构"），图结构零改动。

与现有 `searchTool` 的关系是**互补而非替代**：search 负责"找到起点 URL"，open_page 负责"从起点往深处挖"。两者共存，模型自行编排。

### 3.2 页面对模型的表现：标题 + 截断正文 + 编号链接表

`open_page` 返回给模型的不是原始 HTML，而是：

```text
[页面] 标题：xxx（https://example.com/a）
[正文] 提取后的纯文本，按 token 截断（默认 3000 tokens 上限）
[链接] 1. "下一页：量子纠缠实验结果" → https://...
       2. "参考文献 [12] Nature 论文原文" → https://...
       ...（最多 30 条，导航类链接过滤后按正文区域优先）
```

关键设计：**链接给编号**。让模型在下一轮 `open_page` 里传编号（如 `link: 2`）而不是完整 URL——长 URL 抄写出错率高、token 浪费大；编号引用稳定且省 token。工具同时接受完整 URL 作为参数，兼容"用户直接甩一个链接"的场景。

### 3.3 页面缓存按会话隔离（内存，不落库）

- 内存 `Map<key, PagePool>`，key 沿用 `src/session/key.ts` 的会话键（`group:<openid>` / `c2c:<openid>`）；
- 每个池存最近 N 页（默认 8）的 `{ url, title, 提取正文, 链接编号表 }`，TTL 10 分钟；
- 深挖是"一次 /Agent 内的多轮工具调用"，进程内存即可满足，无需 SQLite（与图片池 `agent/memory/images.ts` 需要跨消息持久不同——页面随时可以重新抓）。

### 3.4 解析层引入 cheerio：对"内置优先"口味的论证

项目一贯口味是内置优先（node:http 不用 express、node:sqlite 不用 better-sqlite3）。但 HTML 解析没有内置能力，正则方案脆弱到不可用。cheerio 是该需求下**最小的第三方依赖**：纯 JS、无原生编译、MIT、原生 TS/ESM 支持，与项目 NodeNext 配置兼容。正文提取一期用 cheerio 手写启发式（剥 script/nav/footer/aside 后取文本密度最高的区域），效果不足再后补 readability。

## 4. 架构总览

```text
用户: /Agent 帮我查 xxx 的详细资料
        │
        ▼
  agent loop（LangGraph，MAX_TOOL_TURNS: 1 → 6）
        │
        ▼
  ┌─ llmCall ── 决定调工具 ──┐
  │                          ▼
  │                    tools 节点（并发执行）
  │                          │
  │        ┌─────────────────┼──────────────────┐
  │        ▼                 ▼                  ▼
  │   searchTool         open_page          （既有工具）
  │   （Tavily 找         │
  │     起点 URL）         ▼
  │              services/browse/fetch.ts
  │              （原生 fetch + 安全守卫：SSRF/大小/类型/超时）
  │                        ▼
  │              services/browse/extract.ts
  │              （cheerio：标题+正文+编号链接表）
  │                        ▼
  │              services/browse/page-pool.ts
  │              （会话级页面缓存，链接编号 → URL）
  │                        │
  └──── 工具结果拼回 messages，绕回 llmCall（最多 6 轮）
                             │
                             ▼
                    plainReply / finalize（人设收尾，不变）
```

## 5. 工具设计

### 5.1 一期：`open_page`

```ts
{
  name: "open_page",
  description: "打开一个网页并阅读。返回标题、正文摘要和编号链接列表。"
    + "想深入某个链接时，再次调用本工具并传 link 编号。"
    + "可用于继续阅读、翻页、查看引用来源等。",
  parameters: {
    type: "object",
    properties: {
      url:  { type: "string", description: "完整网址（与 link 二选一）" },
      link: { type: "number", description: "上次返回结果中的链接编号（与 url 二选一）" },
    },
  },
}
```

实现要点：

- `url` 与 `link` 二选一，都空或都有 → 返回错误提示字符串（沿用 `agent/registry.ts` 工具失败兜底返回字符串的模式）；
- `link` 在会话页面池里查最近一次 open_page 的链接编号表；编号过期（翻页/新页面）→ 明确报"链接编号已失效，请重新 open_page"；
- 返回正文按 token 截断，复用 `src/services/tokenizer.ts` 的计数能力。

### 5.2 二期：`interact_page`（Playwright）

```ts
{
  name: "interact_page",
  description: "在需要 JS 渲染或按钮交互的页面上执行动作（点击/输入），"
    + "返回动作后的页面状态（编号链接表），必要时附截图供视觉分析。",
  parameters: {
    type: "object",
    properties: {
      url:     { type: "string" },
      action:  { type: "string", enum: ["click", "fill", "scroll", "screenshot"] },
      target:  { type: "string", description: "角色化选择器，如 'button:下一页'、'input:搜索'" },
      value:   { type: "string", description: "fill 时的输入内容" },
    },
  },
}
```

设计取舍：

- **`target` 用角色+名称描述而非 CSS 选择器**：让模型说 `button:登录` 而不是 `#header > div.auth > a.btn`——后者模型猜不中。实现侧用 Playwright 的 `getByRole` 语义定位翻译；
- **截图走视觉链路**：`action: "screenshot"` 返回 `[图片:<id>]` 占位符，复用图片池+千问识图的现有机制（`agent/memory/images.ts` + `services/vision.ts`），DOM 快照不明确时用视觉兜底；
- Playwright 浏览器**懒启动单例**（首个 interact_page 才 launch），空闲 N 分钟自动关闭，避免常驻内存；
- 二期同时新增 `MAX_INTERACT_TURNS` 独立预算，交互轮次与阅读轮次分开计数。

## 6. 约束与安全

### 6.1 时间预算（QQ 被动回复窗口是硬约束）

官方文档：**群聊被动回复有效期 5 分钟、每条消息可回复 5 次；单聊 60 分钟、4 次**。深度浏览必须在此窗口内完成，否则回复发送直接失败。因此设总预算：

| 参数 | 默认值 | 说明 |
|---|---|---|
| `BROWSE_MAX_TURNS` | 6 | open_page 一轮对话内最多调用次数（同时是 MAX_TOOL_TURNS 新值） |
| `BROWSE_PAGE_TIMEOUT_MS` | 10000 | 单页抓取超时 |
| `BROWSE_TOTAL_BUDGET_MS` | 60000 | 整轮浏览墙钟预算，超了强制进入 finalize |
| `BROWSE_MAX_CONTENT_TOKENS` | 3000 | 单页正文截断上限 |
| `BROWSE_MAX_LINKS` | 30 | 链接表上限 |

超时不是报错收场：finalize 会拿到已读页面的累积结果，回复"已浏览 N 页，目前发现……"，部分结果好过没有结果。

### 6.2 SSRF 防护（fetch 层硬守卫，`services/browse/fetch.ts`）

机器人处理的是**用户输入的任意 URL**，必须防内网穿透：

- 只允许 `http:`/`https:` 协议；
- 抓取前 DNS 解析主机名，**拒绝私网/保留地址**（127.0.0.0/8、10/8、172.16/12、192.168/16、169.254.169.254 云元数据端点、::1）——注意要校验解析出的**全部 A/AAAA 记录**，防 DNS rebinding 的初级形态；
- 重定向跟随上限 5 次，每一跳重新过协议与 IP 校验；
- 响应大小上限 2MB（Content-Length 预检 + 流式计数双保险）；
- Content-Type 必须 `text/html`，其余类型直接报"不是网页"；
- 请求头带可识别 UA（`qq-bot/1.0 (+web-browse)`）。

### 6.3 礼貌抓取

- 同一域名并发=1，页间加 500ms 间隔；
- 一期不做 robots.txt 强制拦截（个人 bot 场景、抓取量极小），但日志记录；后续扩展再议。

### 6.4 登录态与验证码（三期边界）

- **明确不做验证码对抗**：不接打码平台、不用视觉模型解滑块/点选。验证码触发时的正确响应是提示用户"该站点风控较严，暂不支持"，而不是对抗。优先靠持久 profile + 低频访问降低触发率；
- **登录范围仅限用户本人账号**：login 状态机触发者与扫码者应是同一人，bot 不代登任何他人账号；
- 登录态目录（`data/browser-profile/`）与 `.env` 同级安全，任何日志不得输出 cookie 内容。

## 7. 分阶段实施

**一期（纯阅读，2 个新文件 + 3 处小改）**

1. 新建 `src/services/browse/fetch.ts`——带守卫的 HTTP 层；
2. 新建 `src/services/browse/extract.ts`——cheerio 解析（正文启发式 + 链接编号表）；
3. 新建 `src/services/browse/page-pool.ts`——会话级缓存；
4. 新建 `src/agent/tools/open-page.ts`——按 5.1 契约实现；
5. 改 `src/services/agent.ts`——补一行 `registerTool(openPageTool)`；
6. 改 `src/agent/loop.ts:40`——`MAX_TOOL_TURNS = 1` → 6；
7. 改 `src/config.ts` + `.env.example`——新增第 6.1 节配置项。

**二期（交互，依赖一期验证）**

8. `npm i playwright` + `npx playwright install chromium`；
9. 新建 `src/services/browse/browser.ts`——懒启动单例；
10. 新建 `src/agent/tools/interact-page.ts`——按 5.2 契约实现；
11. 截图接入图片池与识图链路。

**三期（登录态，依赖二期）**

12. Playwright 改用 `launchPersistentContext`（固定 profile 目录 `data/browser-profile`），替代每次新建临时 context；
13. 新建 `src/machines/login.ts`——扫码登录会话状态机（见 5.3）；
14. 复用会话状态机基础设施（`src/session/runner.ts`）与 QQ 发图能力（`src/qq/messages.ts`）。

### 5.3 三期：扫码登录（login 状态机）

**目标**：让 Agent 能访问需要登录态的国内网站（B 站、知乎等），登录动作由用户手机扫码完成，登录态持久化复用。

**为什么选扫码中转而不是其他方案**：

| 方案 | 做法 | 取舍 |
|---|---|---|
| Cookie/storageState 手动导入 | 人工导出登录态文件喂给 Agent | Cookie 过期需反复手动操作，且导出流程对非开发者不友好 |
| **扫码登录中转（采用）** | Agent 打开登录页 → 二维码截图发到 QQ → 用户手机扫码 → 登录态自动持久化 | 国内主流 App 登录方式的自然映射；首次登录后长期免登录 |
| 打码平台/视觉模型解验证码 | 滑块点选自动解 | 对抗性强、成功率不稳、易触发风控，明确不采用（见 6.4） |

**流程设计**（复用猜数字状态机的"拦截-等待-续跑"模式，`src/machines/guess.ts` 同款）：

```text
用户: /Login b站
  │
  ▼
login 状态机启动（会话锁定，后续消息进状态机不进 agent）
  │ 打开 https://passport.bilibili.com/login（Playwright 有头级等待）
  │ 定位二维码元素 → 截图 → QQ 回复图片："请用手机 App 扫码，5 分钟内有效"
  ▼
等待轮询：每 2s 检查页面跳转/登录成功标记（cookie 出现 / URL 离开登录页）
  │
  ├─ 用户扫码成功 → 持久化 context 自然带上登录态（profile 目录已固定）
  │   → QQ 回复"登录成功，之后访问该站将自动携带登录态" → 状态机结束
  │
  ├─ 超时（5 分钟）/二维码过期 → 重新截图发新码，最多 2 次，仍失败则结束并提示
  │
  └─ 用户发"取消" → 关闭页面，状态机结束
```

**设计要点**：

- **登录态存在固定 profile 目录而非 state.json 文件**：`launchPersistentContext("data/browser-profile")` 让浏览器指纹、cookie、localStorage 全部跨会话保留（`data/` 已在 gitignore）。多数网站对"同一持久 profile"的信任度显著高于"每次新 context"，同时降低验证码触发率；
- **短信验证码走同一条状态机**：登录流程若停在验证码输入页，状态机把提示发到 QQ，用户下一条消息即验证码，填回页面继续——挂起等待用户输入的模式与扫码完全同构；
- **安全边界**：登录态文件等价于账号钥匙，与 API key 同级对待；login 状态机仅限群主/管理员或白名单用户触发（复用 `author.member_role` 字段），避免任何群成员都能借机器人账号登录；
- **每站点一个 profile 子目录**（`data/browser-profile/<host>/`），避免多站点 cookie 互相污染。

## 8. 降级路径

- **cheerio 被否决**（坚持零新依赖）：退回 Tavily `include_raw_content: true`（`search.ts:44` 已开启）做单页浅阅读，放弃链接深挖与一切交互——功能残缺但可用；
- **Playwright 二期被否决**（体积/运维顾虑）：交互能力不做，一期阅读不受影响；
- **单页解析失败**（正文提取为空）：返回原始 `<body>` 文本的前 N 字符 + 链接表，标注"正文提取失败，以下为原始文本片段"，深挖仍可继续。

## 9. 配置与文件清单

```text
新增文件：
  src/services/browse/fetch.ts        HTTP 层 + 安全守卫
  src/services/browse/extract.ts      cheerio 解析
  src/services/browse/page-pool.ts    会话页面缓存
  src/agent/tools/open-page.ts        一期工具
  src/services/browse/browser.ts      二期：Playwright 单例
  src/agent/tools/interact-page.ts    二期：交互工具
  src/machines/login.ts               三期：扫码登录状态机

修改文件：
  src/services/agent.ts               +1 行 registerTool（二期再 +1）
  src/agent/loop.ts                   MAX_TOOL_TURNS 1 → 6
  src/config.ts / .env.example        BROWSE_* 配置项
  package.json                        +cheerio（一期）、+playwright（二期）

新增依赖：
  cheerio（一期，纯 JS）
  playwright（二期，含浏览器二进制；三期零新增）
```

## 10. 明确排除 / 后续扩展

- **不做通用爬虫**：没有全站索引、没有持久化页面库，每次深挖都是一次性任务；
- **不做表单批量提交、登录、验证码**：交互仅限"读信息所需的最低动作"（翻页/展开/搜索框），涉及账号操作的场景明确拒绝——**三期之前**；三期引入扫码登录后，登录态访问限定为用户本人账号 + 白名单站点，批量提交与验证码对抗仍然禁止；
- **不做验证码对抗**：不接打码平台、不用视觉模型解验证码（见 6.4）；
- **后续扩展候选**：Readability 增强正文提取；PDF/文档类型支持（复用多模态）；页面池持久化以支持"继续上次浏览"。
