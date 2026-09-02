# Agent fetch_tool 实现方案：给 /Agent 补上"直接访问 URL"的能力

> 状态：实现方案（未实现）
> 起因：用户在 /Agent 里直接给 URL 时，Agent 只能用 search 工具搜这个 URL（搜索 ≠ 打开页面），浪费且拿不到页面真实内容
> 日期：2026-09-02

## 0. 背景与思路

现状问题：`/Agent 帮我看看 https://example.com/article 讲了什么`——Agent 的工具表里只有 search（联网搜索），没有"打开网页"的工具。模型最好的也只能把 URL 当搜索词丢给 search，搜索引擎未必收录该页、摘要也不等于页面正文。而**项目其实早就有完整的网页抓取能力**——深检（/深度检索）的 browse 层就是为了这个建的，只是当时刻意隔离在深检图内部（防止深检能力漏给日常闲聊）。

本方案 = 把深检的 `open_page`（静态阅读）以独立工具身份挂进日常 Agent 的全局工具注册表。**不是新写一个工具，是把已有能力换一个注册位置**——因为 open_page 走 fetch+cheerio 轻量路径，不会把"60 秒深调研"的代价漏给日常对话，当时的隔离顾虑（总设计 §3.1 理由一：误触发成本）对轻量工具不成立。

## 1. 四个前置问题的解答

### 1.1 Node.js 有原生 fetch 吗？

有，**Node 18+ 全局内置**，无需 import、无需安装任何包（浏览器同款 API，由 undici 库实现）。本项目已大量使用：`services/model.ts`（调 DeepSeek）、`services/search.ts`（调 Tavily/阿里）、`qq/api.ts`（调 QQ 接口）、`services/browse/fetch.ts`（抓网页）——全是全局 `fetch(...)` 直接调用。你的 Node v24 远超版本要求。

### 1.2 本项目写过 fetch 相关逻辑吗？

写过，而且有两层，**fetch_tool 全部复用、零新抓取代码**：

| 层 | 文件 | 职责 | fetch_tool 复用 |
|---|---|---|---|
| 抓取层 | `services/browse/fetch.ts` → `fetchPage(url)` | 原生 fetch + 安全守卫（SSRF 防护/重定向逐跳校验/2MB 上限/超时/同域限速） | ✅ 直接调用 |
| 解析层 | `services/browse/extract.ts` → `extractPage(html, baseUrl)` / `formatPageForModel(page, url)` | cheerio 解析出标题+正文+编号链接表，渲染成模型友好文本 | ✅ 直接调用 |
| 管线层 | `agent/tools/open-page.ts` → `loadPage(url, event)` | 抓取→解析→入页面池→格式化，四步一次封装 | ✅ 直接调用 |

甚至工具壳都是现成的：`open-page.ts` 已经导出了完整的 `Tool` 契约对象（`openPageTool`）——只是它当前注册在深检的独立注册表（`deep-search/registry.ts`）里，不在全局注册表。

### 1.3 Node 原生 fetch 需要哪些参数？

基础调用只要一个 URL 字符串：`await fetch("https://example.com")`。可选的第二参数组装请求（fetch_tool 用到的部分）：

```ts
await fetch(url, {
  method: "GET",                          // 默认 GET，抓页面不用写
  headers: {
    "User-Agent": "qq-bot/1.0 (+web-browse)",   // 身份标识，部分站点校验
    "Accept": "text/html,application/xhtml+xml", // 只要网页
  },
  redirect: "manual",        // 手动跟重定向：每跳重新过安全守卫
  signal: controller.signal, // AbortSignal：超时/中断控制
})
```

常见请求头补充（供理解，`fetch.ts` 已按需组装）：`Content-Type`（POST 请求体的格式，GET 不需要）、`Authorization: Bearer <key>`（API 鉴权，抓公开网页不需要）。**不需要手动处理的事**：gzip/br 解压（undici 自动）、cookie 会话（无状态抓取不需要）。这些细节全部封在 `fetchPage` 里，fetch_tool 一行都不用碰。

### 1.4 fetch 输出什么？怎么解析？喂给模型什么格式？

**输出**是一个 `Response` 对象（不是字符串！）：`response.ok`（状态码 2xx）、`response.status`、`response.headers`、`response.body`（字节流）。要变成文本需 `await response.text()` 或流式读取（`fetch.ts` 用流式，为了 2MB 上限的中途掐断）。

**解析**：HTML 字符串不能直接喂模型（几 MB 的标签噪声），项目用 cheerio（jQuery 子集语法）解析成 DOM 树后提取——这些已封装在 `extractPage`：剥掉 script/nav/footer 等噪声标签 → 取正文纯文本（截 3000 字符）→ 收集链接表（相对转绝对、去重、限 30 条、编号）。

**喂给模型的格式**（`formatPageForModel` 的现成产出，三段式纯文本）：

```text
[页面] 标题：React 19.2 发布说明（https://react.dev/blog/...）
[正文]
React 19.2 现已发布，本次重点是……（3000 字符内）

[链接]
1. "React 官方文档" → https://react.dev/
2. "Activity 组件参考" → https://react.dev/reference/react/Activity
```

这个格式经过深检长期验证：段落标记帮模型定位信息类型、链接编号让它能引用（下一轮传 `link: 2`）而不用抄长 URL。

## 2. 实现方案：注册位置的移动，不是新代码

### 2.1 核心改动（两处小改，无新文件）

**改动一：`openPageTool` 双注册**。`open-page.ts` 的工具壳（Tool 契约对象）已经存在，只需在 `src/services/agent.ts` 的工具注册区补一行：

```ts
import { openPageTool } from "../agent/tools/open-page.js";
registerTool(openPageTool);   // 挂进全局注册表 → /Agent 的模型可见
```

深检侧的 `deep-search/registry.ts` 注册**保持不动**——两个注册表各存一份引用，同一个工具对象，维护单一。

**改动二：工具描述微调**。现有 description 是为深检语境写的（"想深入某个链接时再次调用本工具并传 link 编号…可尝试 interact_page 工具"）。挂进日常 Agent 后语境变了：没有 interact_page 兜底（那仍是深检专属）、用户直接甩 URL 的场景要突出。description 改为面向日常语境的版本，例如：

> "打开一个网页并阅读其内容。当用户消息里包含网址（https://...）、或明确让你查看某个网页时调用。返回页面标题、正文摘要和页面里的链接列表。"

注意 description 是工具对象的属性，双注册共用一个对象意味着**两边共享同一份描述**——如果深检语境和日常语境的描述差异大到不能共用，就浅拷贝一份改 description（`{ ...openPageTool, description: "..." }`），两行代码的事。

### 2.2 页面池的会话问题（唯一需要想的点）

open_page 的 `link` 编号机制依赖页面池（`page-pool.ts`，人粒度 sessionKey 隔离）。工具的 `run(args, ctx)` 签名里 ctx 是现成的，`loadPage(url, ctx.event)` 内部自动按 sessionKey 入池——**日常 Agent 里用编号跟进链接同样有效**，且和深检的池天然共用（同一会话同一个人）。这是复用的红利，无需改动；副作用只有一个：日常对话里打开的页面也会占池子（上限 8 页、TTL 10 分钟，无实质影响）。

### 2.3 与 search 工具的关系：互补，不替代

- 用户给 URL → `open_page` 直接打开（新能力，本方案的目标）；
- 用户问开放问题 → `search` 找来源（原有能力）；
- 模型甚至可以组合：search 找到相关文章链接 → open_page 读全文——这顺带让 /Agent 获得了"轻量版深检"能力（单轮工具内的一次页面阅读），但受 MAX_TOOL_TURNS=1 限制，search 之后不能再 open_page（第二轮）。**这是已知边界**，够用的场景是"用户直接给 URL"；若以后想放开组合，调 loop.ts 的 MAX_TOOL_TURNS 即可（另一话题）。

## 3. 安全与预算（全部继承，零新增）

fetch_tool 的所有风险面已在 browse 层解决，直接继承：

- **SSRF 防护**：`fetchPage` 的 DNS 全记录校验拒绝私网/保留地址（用户给 `http://127.0.0.1:3000/` 这种 URL 会被拒）；
- **资源限制**：单页 10s 超时、2MB 大小上限、Content-Type 必须 text/html；
- **礼貌抓取**：同域串行 + 500ms 间隔（进程级队列，和深检共用）；
- **错误文案自愈**：抓取失败返回"打开 xxx 失败：原因"（模型可据此告知用户，不会炸穿 /Agent 流程）。

## 4. 测试方案

1. **单测**：现有 `test/deep_research/smoke.ts` 已覆盖 fetchPage/extractPage（16 项），无需新增；
2. **端到端（本地）**：临时脚本直调 `runTool("open_page", { url: "https://example.com" }, mockCtx)`，验证全局注册表里的分发；
3. **QQ 实测**：`/Agent 帮我看看 https://react.dev/blog 讲了什么`——预期模型直接调 open_page 返回页面摘要，而非走 search。

## 5. 文件清单

```text
修改：
  src/services/agent.ts        +1 行 registerTool（openPageTool）
  src/agent/tools/open-page.ts  description 微调（日常语境）或双描述拷贝

不改动（全部复用）：
  services/browse/fetch.ts / extract.ts / page-pool.ts   能力层原样
  agent/deep-search/registry.ts                           深检侧注册保持
  agent/registry.ts                                        注册表本身不动
```

预计工作量：半小时内（含测试）。
