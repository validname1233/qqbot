# 深度检索方案：独立工作流（Tavily 起点 + 多轮 open_page 深挖）+ 二期 Playwright 交互 + 三期扫码登录

> 状态：设计稿（未实现）
> 前置依赖：`src/agent/loop.ts`（LangGraph 五节点图——只借鉴模式，不改一行）、`src/services/search.ts`（Tavily 起点）、`src/services/model.ts`（callModel）、`src/services/prompts/`（场景化提示词）
> 日期：2026-08-24 初稿；2026-08-25 修订——编排层从「扩展日常 Agent 循环」改为「独立深度检索工作流」（§3.1），能力层设计（抓取/解析/缓存/安全）不变；2026-08-26 修订一——起点 URL 预读（§5.2）；2026-08-26 修订二——plan & execute：planNode + 思维链（§5.2、§5.4）；2026-08-26 修订三——思维链产生机制定为「一次调用双职责 + 合成兜底」（§5.2）、记忆策略确认保持「问题 + 报告」两条（中间 messages 从不落库，§3.5）

## 1. 背景与目标

用户诉求：一个专门的「深度检索」功能——机器人对一个问题做真正深入的网络调研：

1. **起点**：用 Tavily 搜出若干起点 URL（标题 + 摘要 + 链接）；
2. **深挖**：用 `open_page` 打开起点页面阅读，顺着页面里的内层链接逐层点进去，直到信息足够；
3. **成报告**：把整个过程中读到的材料汇总成一份结构化报告回复用户。

与现有能力的边界：日常 `/Agent` 的 `search` 工具是「浅检索」——单轮、只有摘要、不追链接，快问快答够用；深度检索是「深调研」——多轮、读全文、追链接链，代价是慢（几十秒）和贵（多次模型 + 抓取调用）。**两者并存互补，日常链路一行不改。**

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
- **截图可以白嫖现有识图链路**。Playwright 截图 → 喂给 `src/services/vision.ts`（千问识图）→ 用视觉模型理解"点完之后页面变成了什么样"，形成"DOM 不确定时用视觉兜底"的闭环。

## 3. 核心决策

### 3.1 独立工作流：新建一张图 + 独立命令入口，不并入日常 Agent 图（本次修订的核心）

初稿方案是「扩展现有 agent 图：`open_page` 注册成共享工具 + `loop.ts` 的 `MAX_TOOL_TURNS` 从 1 调到 6」。修订后否决，理由：

**理由一：触发判断不可靠，显式命令才确定。**
「要不要深度检索」交给模型判断，失败模式不对称且无界：误触发——日常聊天一句话点燃 60 秒浏览 + 十几次调用；漏触发——用户想要深检却启动不了。目前的大模型对这类意图判断还不具备可靠智能。本项目已有同款决策先例：`/Agent` 本身就必须显式命令触发（`src/registry.ts` 注册处的注释写明：不开兜底 service、不点名不触发，否则机器人对群里所有话搭话）。深度检索的单次代价远高于一次普通工具调用，更应该确定化。

**理由二：一张图塞两种工作流，条件边、节点、提示词三处都要分叉。**
`llmCall` 之后的路由要多一个「这是不是深检模式」的分支；每个节点内部要区分场景取值；`agent_judge` 提示词要额外描述深检语义（提示词越长，判断越差）。两条工作流分开，各自的图、提示词、预算、记忆策略都干净。

**分离的附带红利（初稿没有预见的三条）：**

- **零回归风险**：初稿要改 `MAX_TOOL_TURNS`（1→6），等于顺带改变日常 `/Agent` 的行为（闲聊也可能多轮工具调用，变慢变贵）；分离后 `loop.ts` 一行不动，日常图行为与今天完全一致。
- **记忆策略独立**：日常图把全部中间消息（assistant 工具调用、tool 结果）落短期记忆。6 轮浏览 ≈ 十余条消息、每条正文最多 3000 token——一次深检会吃掉 20 条窗口的大半，污染之后所有 `/Agent` 的上下文。独立图可以只落「问题 + 最终报告」两条（§3.5）。
- **预算独立**：深检有自己的轮次 / 墙钟预算，日常聊天保持单轮工具的轻量。

**分离的代价（可接受）**：`llmCall ↔ tools` 的循环壳要在新图里重写一遍（约百行节点代码）。但这本来就是廉价部分——真正值钱的全在 service 层（callModel、tavilySearch、提示词组装、浏览三件套），完全复用。LangGraph 的图是轻量编译对象，两张图共存无任何开销。

### 3.2 「深度」来自多轮工具调用，不来自工具内部递归

两种实现"逐层深挖"的路线：

| 路线 | 做法 | 问题 |
|---|---|---|
| 工具内部递归 | 一个 `deep_crawl(url)` 工具内部 BFS 抓 N 层，把结果一次性返回 | 每层抓什么、抓多深是**代码写死的启发式**，不是智能判断；且返回内容极易撑爆上下文 |
| **多轮工具循环（采用）** | 模型调 `open_page` 看一页 → 自己决定点哪个链接 → 再调 `open_page` → …… | 哪个链接值得跟、什么时候信息够了该收尾，全部由模型判断——这才是"深度检索"的含义 |

多轮循环发生在深检图内部，轮次上限 `BROWSE_MAX_TURNS` 是深检图自己的预算，与日常图的 `MAX_TOOL_TURNS` 无关（后者保持 1 不动）。

**判断的分工**（对 §3.1 理由一的边界说明）：触发判断确定化（命令），不等于否定模型判断的全部价值。循环内部「哪个链接值得跟、信息够没够」仍然是模型判断——这正是「深度」的来源；区别在于这里的失败有硬预算兜底（轮次 / 墙钟一到强制收尾，输出部分结果），最坏情况是「报告不够全」，而不是污染日常对话。若连导航判断也不信任，就只剩代码写死的 BFS 爬虫——那是上表明确否决的路线。

与 Tavily 的关系是**起点与深挖的分工**：searchNode 负责"找到起点 URL"（确定性执行，不经模型），open_page 负责"从起点往深处挖"（模型驱动）。

### 3.3 页面对模型的表现：标题 + 截断正文 + 编号链接表

`open_page` 返回给模型的不是原始 HTML，而是：

```text
[页面] 标题：xxx（https://example.com/a）
[正文] 提取后的纯文本，按 token 截断（默认 3000 tokens 上限）
[链接] 1. "下一页：量子纠缠实验结果" → https://...
       2. "参考文献 [12] Nature 论文原文" → https://...
       ...（最多 30 条，导航类链接过滤后按正文区域优先）
```

关键设计：**链接给编号**。让模型在下一轮 `open_page` 里传编号（如 `link: 2`）而不是完整 URL——长 URL 抄写出错率高、token 浪费大；编号引用稳定且省 token。工具同时接受完整 URL 作为参数，兼容"用户直接甩一个链接"的场景（§5.1）。

### 3.4 页面缓存按人隔离（内存，不落库）

- 内存 `Map<key, PagePool>`，key 用 `src/session/key.ts` 的 `sessionKey`（**人粒度**：群聊是 `group:<groupOpenid>:<authorOpenid>`）。初稿写的是群粒度，修正原因：群里两人同时深检会共用一个池，互相覆盖"最近一次 open_page"的链接编号表。
- 每个池存最近 N 页（默认 8）的 `{ url, title, 提取正文, 链接编号表 }`，TTL 10 分钟；
- 深挖是"一次 /深度检索 内的多轮工具调用"，进程内存即可满足，无需 SQLite（与图片池 `agent/memory/images.ts` 需要跨消息持久不同——页面随时可以重新抓）。
- 已知小竞态：同一用户并发两次深检仍共享一个池，链接编号可能被后一次覆盖。概率低、后果轻（模型拿到另一页的链接，可改传完整 URL 自愈）；要彻底解决需把编号表挂到每次图运行的调用上下文，留作实现后视情况。

### 3.5 记忆策略：只落「问题 + 报告」两条，中间 messages 从不落库（修订三确认）

- memory-log observer 只落 `command === null` 的消息，`/深度检索 xxx` 不会经由观察者入库——深检服务自己负责落库（与 agentService 对 /Agent 的责任划分同款）。
- 图的中间过程（plan、思维链、assistant 的 tool_calls、tool 的页面正文）**全部不落库**——它们只活在图的 state.messages 里，runDeepSearch 从不把 state.messages 写进 sqlite。
- 修订三确认：图结束后向 `memoryKey` 落 **两条**——user = 问题原文（带说话人前缀）、assistant = 最终报告。两条都是"结晶"：一条记录问了什么（含发起人），一条记录查到了什么；中间的几百次往返都是过程噪声，不值得占窗口。
- 效果：后续 `/Agent` 能看到"刚才查过什么、结论是什么"（可基于报告追问展开），20 条窗口一次深检只占 2 格，上下文不被页面正文挤爆。
- 实现现状：runDeepSearch 的落库代码（手写两行 append）已是这个口径，无需改动。

### 3.6 解析层引入 cheerio：对"内置优先"口味的论证

项目一贯口味是内置优先（node:http 不用 express、node:sqlite 不用 better-sqlite3）。但 HTML 解析没有内置能力，正则方案脆弱到不可用。cheerio 是该需求下**最小的第三方依赖**：纯 JS、无原生编译、MIT、原生 TS/ESM 支持，与项目 NodeNext 配置兼容。正文提取一期用 cheerio 手写启发式（剥 script/nav/footer/aside 后取文本密度最高的区域），效果不足再后补 readability。

## 4. 架构总览

```text
用户: /深度检索 量子纠缠最新的实验进展（消息里可带 URL 起点）
        │
        ▼
  deepSearchService（src/services/deep-search.ts，CommandService 壳）
        │  registry.ts 登记一行，handler / dispatcher / 日常 agent 零改动
        ▼
  runDeepSearch（src/agent/deep-search.ts，独立 StateGraph）
        │
  ┌─────▼─────────────────────────────────────────────────┐
  │ searchNode    起点装配（确定性，无模型参与）                  │
  │               URL 预读成页面材料（≤5 个，全败才退化          │
  │               Tavily 起点），拼进首条 user 消息              │
  ├─────────────────────────────────────────────────────────┤
  │ planNode      制定调研计划（flash，deep_plan 纯功能场景）    │
  │               看过起点材料再定方向 → 写入思维链 chain[0]     │
  │               （三期登录检测的挂点，见 §5.2）                │
  ├─────────────────────────────────────────────────────────┤
  │ browseLlm ⇄ browseTools    深挖循环（plan & execute）       │
  │   browseLlm    思维链注入提示词末尾 → callModel(flash+tools) │
  │                content（本步小结）追加进 chain               │
  │   browseTools  执行 open_page / interact_page             │
  │   ↻ 条件边：还有 tool_calls 且轮次/墙钟预算未耗尽 → 继续       │
  │             否则（模型主动停 或 预算耗尽）→ synthesize       │
  ├─────────────────────────────────────────────────────────┤
  │ synthesize    汇总报告（pro + thinking，deep_report；      │
  │               user 消息含思维链 = 计划与逐步进展）            │
  └─────┬─────────────────────────────────────────────────┘
        ▼
  回复（Markdown，走 handler 现有 markdown-first 发送）
  落库：问题 + 报告 两条进短期记忆（§3.5）
```

能力层（与编排解耦，二期三期继续挂在深检图上）：

```text
  open_page 工具
    → services/browse/fetch.ts    原生 fetch + 安全守卫（SSRF/大小/类型/超时）
    → services/browse/extract.ts  cheerio：标题+正文+编号链接表
    → services/browse/page-pool.ts 人粒度页面缓存（链接编号 → URL）
```

**关键约束：`open_page` 不进 `agent/registry.ts` 的共享工具注册表。** 那张表是全局单例，日常 `/Agent` 的 `toolSchemas()` 会把它一并发给闲聊模型——等于变相把深检能力漏回日常链路，违背 §3.1 的分离初衷。深检图自持工具列表（本地数组，browseTools 节点直接调 `tool.run`），顺带绕开 runTool 的"工具执行失败"统一兜底——open_page 需要细粒度错误文案（如"链接编号已失效，请重新 open_page"）让模型能自愈重试。

## 5. 工作流与工具设计

### 5.1 命令入口：/深度检索

- CommandService：name `深度检索`，别名 `ds`。空参数 → 用法提示（`用法：/深度检索 想深入调研的问题`）。
- 参数里可以带 http(s) URL（正则提取，最多 5 个），URL 之外的文字是问题本体——两种形态自由组合："`/深度检索 https://a.com/x 帮我总结要点`"或纯问题。
- 不做会话锁定（一次性命令，与猜数字状态机不同）：执行期间同会话的其它消息正常处理，互不阻塞。

### 5.2 深检图节点（2026-08-26 修订二：plan & execute——planNode + 思维链）

图结构：`searchNode → planNode → (browseLlm ⇄ browseTools)* → synthesize → END`。

State：`question / ctx / messages（ReducedValue 累加）/ chain（思维链，string[]）/ turnCount / deadline / report`。

- **searchNode（起点装配，2026-08-26 修订一：URL 预读替代"模型自己打开用户 URL"）**：入口三情形——
  1. **消息里带 URL** → 正则提取（≤5 个，排除尾随中文标点）后**逐个预读成页面材料**（`Promise.allSettled` 并行，复用 open_page 的 loadPage 管线：fetch→extract→入池→格式化）。不经模型转手：用户指明的那一跳没有判断成分，不该交给模型"抄写进工具参数"——这是全链路最后一个必须逐字抄 URL 的点，也是幻觉/丢字风险最集中的点（§3.2：无判断的步骤该是确定性代码）。部分失败是常态：成功的页面进材料；失败的注记"以下网址无法访问：…（原因），请勿再尝试打开"；**全部失败才跑 Tavily 兜底**（部分成功时再搜索只添噪音），且明确告诉模型"用户提供的网址访问失败，以下是搜索得到的起点材料"。
  2. **没有 URL** → `tavilySearch(question)`（basic 深度、默认条数 6，复用 `search.ts` 现有默认值），拼"以下是搜索得到的起点材料"——不提"访问失败"字样，凭空提失败反而诱导模型重试。
  3. **Tavily 0 结果** → 提示模型可用 open_page 打开搜索引擎结果页自寻起点（见 §8）。
  预读与搜索都计入墙钟预算：`deadline = now + BROWSE_TOTAL_BUDGET_MS` 在本节点开头设定。初始 messages = `[system: deep_browse] + [user: 问题（去掉 URL 的文字部分）+ 起点材料]`。
- **planNode（修订二新增：制定计划）**：排在起点装配之后的专职第二步。输入 = searchNode 拼好的问题 + 起点材料（system 换 `deep_plan` 场景），调 flash、**不带 tools**——计划是纯文本方向而非动作；三期的 login 工具就位后才给它工具表。输出几条简明调研方向（要核实什么、材料还缺什么、第一步跟哪个链接），写入 `chain[0]`，不追加进 messages——浏览循环经思维链注入读它，两条通道只会重复。**放在 searchNode 之后（先见材料再定计划）**是关键：URL 预读的红利在这里变现——登录墙、付费墙、空壳 SPA 在计划阶段就能被看见，对策直接写进计划（换来源/改用 interact_page）。**三期登录检测的挂点**：预读材料若显示"需要登录才能看内容"，planNode（届时带 login 工具）在此触发登录流程，browseLlm 接手时起点已是可读内容——登录是"计划层的判断"，不该散落在浏览循环里。deadline 已耗尽（预读+计划吃光预算的极端情况）→ 跳过浏览直接 synthesize。planNode 不计入 turnCount（它不是浏览轮次，墙钟预算已覆盖它的耗时）。
- **browseLlm（修订二：思维链注入 + 工具决策）**：调用前把 chain 拼成一条临时 system 消息附在 messages 末尾（`[调研计划与进展]（这是你此前的思考记录，请延续编号继续维护）1.（计划）… 2.（第1步）…`——认领式措辞让模型把链当成自己思考的连续体，而非外部塞进来的指令），再 `callModel(拼接后的消息, toolSchemas(), config.aiModel, false)`。flash 足够——导航判断是轻任务，且要调很多次。链文**只进本次调用、不进 state.messages**，两个原因：其一，链文若入库，每轮一份越来越长的快照会在历史里滚雪球；其二，OpenAI 兼容接口要求 assistant(tool_calls) 消息后紧跟对应的 tool 结果消息，链文入库很难保证插入位置不破坏这个邻接——临时注入天然规避（附在末尾，永远在最后一组 tool 结果之后）。模型输出的 content 追加进 chain——**「一次调用双职责」（修订三确认产生机制）**：content 是复盘（进展到哪、刚读到什么、与计划的关系）+ 前瞻（下一步为什么调这个工具），tool_calls 是动作，即 ReAct 的 Thought 与 Action 同体；deep_browse 提示词强制调工具时必须同时输出 content。**content 为 null 的兜底**：DeepSeek 这类接口带 tool_calls 时 content 可能为 null（模型的注意力全给了工具参数，提示词压不死），此时代码从 tool_calls 合成最小条目（`第N步：调用了 open_page(link:3)`）追加进链——合成条目只有动作没有判断（行车记录仪，不是方向盘），有 content 时永远用 content，链永不间断。链长有界（1 条计划 + ≤6 步，每条一两句），无需压缩机制。最后一轮"无 tool_calls"的输出就是材料小结，自然成为链尾。
- **browseTools**：解析 tool_calls、并发执行、tool 消息拼回 messages、turnCount+1。（open_page 可真并发——同域名串行由 fetch 层的进程级队列保证，跨会话也生效，见 §6.3；interact_page 经 browser.ts 的链自动串行。）
- **路由（条件边）**：
  - planNode 后：`now < deadline` → browseLlm；否则 → synthesize（预算耗尽的优雅降级）。
  - browseLlm 后：无 tool_calls → synthesize（**Claude Code 式的自然退出**：工具循环的结束信号就是模型不再要工具——本图现有行为，修订二把它确认为正式设计语义）；有 tool_calls 且 `turnCount < BROWSE_MAX_TURNS` 且 `now < deadline` → browseTools；否则 → synthesize（预算耗尽的优雅降级，绝不报错收场）。
  - browseTools 后：`now < deadline` 且 `turnCount < BROWSE_MAX_TURNS` → browseLlm；否则 → synthesize。
- **synthesize（修订二：增加思维链）**：仿 `synthesizeFinalReply` 的两条消息模式——system 用 `deep_report` 场景（带人设），user 放问题 + 起点列表 + **思维链（计划与逐步进展）** + 全部浏览记录；`config.agentModel`（pro）+ `enableThinking=true`。浏览记录给证据，思维链给意图脉络，报告模型两者都有。提示词要求报告精炼（约 1500 字内，QQ 消息有长度上限）。

**chain（思维链）机制小结**：

- 写入方：planNode 写 chain[0]（计划）；browseLlm 每轮把模型 content（本步复盘 + 下一步指示）追加为 chain[N]，content 为 null 时从 tool_calls 合成最小条目兜底（详见 browseLlm 条）。
- 读取方：browseLlm（注入提示词末尾——工具结果越积越多时，紧凑的计划+进展在提示词末尾重新拉回模型注意力，对抗上下文稀释）；synthesize（作为"调研计划与进展"段）。
- 刻意不进 state.messages：理由见 browseLlm 条。
- **刻意不加进 loop.ts 的 AgentState**：两张图的状态本就不同构（loop 有 history/longTermContext/imageIds，深检有 question/deadline/report），"一致性"并不存在；恒空的字段是死状态，对读者是噪声。日常 Agent 需要 plan & execute 时再加——那时它有自己独立的注入语义（要连同 plainReply/finalize 怎么消费链一起设计），照搬深检的字段反而缚手脚。

模型分工沿用现有惯例：计划与导航用 flash（多次、便宜），成文用 pro（一次、要质量）——与 loop.ts 里 llmCall 用 aiModel / finalize 用 agentModel 的拆分同构。

### 5.3 一期工具：`open_page`

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

- `url` 与 `link` 二选一，都空或都有 → 返回错误提示字符串（模型读到后可自行修正重试）；
- `link` 在人粒度页面池里查最近一次 open_page 的链接编号表；编号过期（翻页/新页面）→ 明确报"链接编号已失效，请重新 open_page"；
- 返回正文按 token 截断——**更正初稿**：`src/services/tokenizer.ts` 是给长期记忆 BM25 用的中文分词器，不是 token 计数器，不能复用。一期按字符折算（中文 ≈ 1 字 / token），不为此引入 token 计数依赖。

### 5.4 提示词场景（functional.ts 新增三个 scene）

- `deep_plan`（纯功能场景，加进 builder.ts 的 `PURE_FUNCTIONAL_SCENES`；修订二新增）：计划制定——输入问题 + 起点材料，输出几条简明的调研方向（要核实什么、材料还缺什么、第一步跟哪个链接/搜什么）。要求识别材料质量问题（登录墙、空正文、死链）并把对策写进计划（换来源/改用 interact_page）。纯文本输出、不执行动作——三期登录工具就位后，这个场景才随 planNode 一起获得工具表。
- `deep_browse`（纯功能场景，加进 builder.ts 的 `PURE_FUNCTIONAL_SCENES`）：浏览纪律——起点已在首条消息给出、预算有限、跟进链接用 link 编号、围绕问题深挖、信息足够时**停止调用工具并输出一段简短的材料小结**（小结会留在浏览记录里，供 synthesize 参考）；**调用工具时 content 必须同时输出本步复盘（进展到哪、刚读到什么）与下一步指示（为什么调这个工具）**——它是思维链的下一环，会被追加进 [调研计划与进展] 指导后续决策（修订二定协议，修订三确认产生机制见 §5.2 browseLlm 条）。
- `deep_report`（带人设，仿 agent_finalize）：基于材料成文，不提过程性描述（"我调用了工具"之类），专业内容收起人设语气、首尾可点缀一两句，OUTPUT_FORMAT_RULE 沿用现有规则。
- 日常场景（daily / agent_judge 等）**零改动**——深检不进它们的提示词，模型永远不需要"判断要不要深检"。

### 5.5 二期：`interact_page`（Playwright）

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
- **截图走视觉链路**：`action: "screenshot"` 返回 `[图片:<id>]` 占位符，复用图片池 + 千问识图的现有机制（`agent/memory/images.ts` + `services/vision.ts`），DOM 快照不明确时用视觉兜底；
- Playwright 浏览器的生命周期按 §5.6 的三档渐进演进：起步只做图级（一次深检请求一套浏览器），后续视需要再放开进程级与持久化；
- 二期新增 `MAX_INTERACT_TURNS` 独立预算，交互轮次与阅读轮次分开计数；interact_page 同样只挂深检图的工具列表，不进共享注册表。

**Playwright/Chromium 能力清单**（实现 interact_page 及后续扩展时选型的 API 地图，按"是否已被本项目使用"标注）：

| 能力类别 | 代表 API | 返回值 | 本项目 |
|---|---|---|---|
| 导航 | `page.goto(url)` / `goBack()` / `reload()` | `Promise<HttpResponse>`（主文档响应，含状态码） | ✅ goto |
| 等待 | `page.waitForLoadState()` / `waitForSelector()` / `waitForURL()` | `Promise<void>`（等到即 resolve，超时抛错） | ✅ waitForLoadState |
| 查询（读） | `page.title()` / `page.url()` / `page.content()` | 字符串——**content() 返回渲染后 HTML，是动态路径的核心产出** | ✅ 三者 |
| 交互（写） | `locator.click()` / `.fill()` / `.press()` / `.check()` / `page.mouse.wheel()` | `Promise<void>`（动作无返回值，效果体现在之后的 DOM） | ✅ click/fill/wheel |
| 定位器 | `page.getByRole()` / `getByText()` / `getByPlaceholder()` / `locator(css)` | `Locator` 对象（**惰性**：创建时不查找，动作时才解析） | ✅ getByRole/getByPlaceholder |
| 截图 | `page.screenshot()` | `Promise<Buffer>`（图片字节，可落盘） | ✅ 存盘不分析 |
| 执行任意 JS | `page.evaluate(() => ...)` | 回调返回值的序列化结果 | ❌ 刻意不用 |
| 网络监听/拦截 | `page.on("request"/"response")` / `page.route()` | 事件回调（可拦截改写请求） | ❌ 未用 |
| 会话管理 | `context.cookies()` / `storageState()` / `launchPersistentContext()` | cookie 对象 / 登录态 JSON / 持久会话 | ❌ 三期扫码登录用 |

三个使用要点：

1. **"写后读"拼接模式**：Playwright 的交互类 API 大多返回 `void`（动作确认而非数据），页面数据要靠查询类 API 单独取。interact_page 的完整动作单元固定为 `goto → 交互动作 → waitForLoadState → page.content() → cheerio 提取`——把"写"和"读"拼成一次工具调用，且产出与 open_page 走同一条 extract 管线、同一种三段式格式，模型无需感知页面来源差异；
2. **不使用 `page.evaluate` 的原因**：我们的工具协议是"模型传意图（action/target/value），代码翻译成 API 调用"，不让模型写 JS 塞进页面执行——任意 JS 执行有安全面（可绕过提取层直接操作页面），且模型生成 JS 的出错率远高于描述意图。若未来确需页面内计算（如取 JS 变量值），再评估放开；
3. **Locator 惰性语义**：`getByRole("button", { name: "下一页" })` 创建时不接触 DOM，真正 click 时才查找——找不到/不可点的报错发生在动作阶段，所以错误兜底（interact-page.ts 的 catch）要包住整个动作而非仅定位语句。

### 5.6 浏览器生命周期：三档渐进演进（二期内部路线图）

无头浏览器的状态（cookie、localStorage、当前页面）挂在"谁持有引用"上，由此自然分出三档实现。每档都是前一档的增量改造，做一档、验证一档、再决定要不要下一档：

| 档位 | 状态存活范围 | 实现方式 | 代价 |
|---|---|---|---|
| **A：图级（二期起步）** | 一次 `/深度检索` 请求内 | 首次 interact_page 时 launch，深检图收尾（synthesize 后）统一 close | 每次请求多 ~1-2s 启动延迟；请求间状态清零，无登录态延续 |
| **B：进程级（可选）** | webhook 进程存活期间 | browser 模块级单例 + 按 `memoryKey` 每会话一个 context；图收尾关 page 留 context，空闲 N 分钟关整个 browser | 多会话并存的内存（每 page 约 10-50MB）+ 会话隔离复杂度 |
| **C：磁盘级（三期）** | 跨进程重启 | context 改 `launchPersistentContext`，cookie 落 `data/browser-profile/<host>/` | 与三期扫码登录合并实现（§5.7） |

**起步选 A 的理由**：

- **隔离问题不存在**：一次请求一套浏览器，多群/多用户天然互不污染——B 档的主要设计负担（按会话分 context、内存护栏）全部可以先不做；
- **内存最省**：图收尾即归零，不存在"几个群同时挂着浏览器"的峰值，并发 page 上限护栏也可以推迟；
- **A 的代码是 B 的子集**：`browse/browser.ts` 对外只暴露 `getPage()` / `releasePage()` 两个函数，A 档内部是"launch → 串行执行 → close"；升 B 档只改内部持有方式（模块级变量 + 按会话分 context），工具层与深检图零改动。做 A 不产生需要推翻的代码。

**A 档也要做的一件事——动作串行化**：深检图的 browseTools 节点会并发执行同轮的多个 tool_calls，两个 interact_page 同时操作同一个 page 会互相踩。A 档就在 browser.ts 里用 Promise 链排队（同一时刻只跑一个动作），这个串行化逻辑三档通用。

**B 档明确标记为"可能做可能不做"**：只有实际使用中"每次重新打开目标网站"的延迟/登录成本确实痛了才值得做；跳过 B 直接 A→C 也成立（C 自带跨请求状态，且是持久化的）。不提前为 B 实现任何代码，避免投机性设计。

### 5.7 三期：扫码登录（login 状态机）

**目标**：让深检能访问需要登录态的国内网站（B 站、知乎等），登录动作由用户手机扫码完成，登录态持久化复用。

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

## 6. 约束与安全

### 6.1 时间预算（QQ 被动回复窗口是硬约束）

官方文档：**群聊被动回复有效期 5 分钟、每条消息可回复 5 次；单聊 60 分钟、4 次**。深度检索必须在此窗口内完成，否则回复发送直接失败。因此设总预算：

| 参数 | 默认值 | 说明 |
|---|---|---|
| `BROWSE_MAX_TURNS` | 6 | 深检图内 open_page 的轮次上限（browseLlm ↔ browseTools 循环次数）；日常 Agent 的 MAX_TOOL_TURNS 保持 1，互不影响 |
| `BROWSE_PAGE_TIMEOUT_MS` | 10000 | 单页抓取超时 |
| `BROWSE_TOTAL_BUDGET_MS` | 60000 | 整轮深检墙钟预算（Tavily + 浏览 + 收尾），超了强制进 synthesize |
| `BROWSE_MAX_CONTENT_TOKENS` | 3000 | 单页正文截断上限（按字符折算，见 §5.3） |
| `BROWSE_MAX_LINKS` | 30 | 链接表上限 |

超时不是报错收场：synthesize 会拿到已读页面的累积记录，回复"已浏览 N 页，目前发现……"，部分结果好过没有结果。60s 预算 + 收尾约 30s，距群聊 5 分钟窗口余量充足。

### 6.2 SSRF 防护（fetch 层硬守卫，`services/browse/fetch.ts`）

深检处理的是**用户输入的任意 URL**，必须防内网穿透：

- 只允许 `http:`/`https:` 协议；
- 抓取前 DNS 解析主机名，**拒绝私网/保留地址**（127.0.0.0/8、10/8、172.16/12、192.168/16、169.254.169.254 云元数据端点、::1）——注意要校验解析出的**全部 A/AAAA 记录**，防 DNS rebinding 的初级形态；
- 重定向跟随上限 5 次，每一跳重新过协议与 IP 校验；
- 响应大小上限 2MB（Content-Length 预检 + 流式计数双保险）；
- Content-Type 必须 `text/html`，其余类型直接报"不是网页"；
- 请求头带可识别 UA（`qq-bot/1.0 (+web-browse)`）。

### 6.3 礼貌抓取

- 同一域名并发=1（进程级队列，跨会话生效），页间加 500ms 间隔；
- 一期不做 robots.txt 强制拦截（个人 bot 场景、抓取量极小），但日志记录；后续扩展再议。

### 6.4 登录态与验证码（三期边界）

- **明确不做验证码对抗**：不接打码平台、不用视觉模型解滑块/点选。验证码触发时的正确响应是提示用户"该站点风控较严，暂不支持"，而不是对抗。优先靠持久 profile + 低频访问降低触发率；
- **登录范围仅限用户本人账号**：login 状态机触发者与扫码者应是同一人，bot 不代登任何他人账号；
- 登录态目录（`data/browser-profile/`）与 `.env` 同级安全，任何日志不得输出 cookie 内容。

## 7. 分阶段实施

**一期（纯阅读，6 个新文件 + 5 处小改；`loop.ts` / handlers / dispatcher / `agent.ts` 零改动——这是与初稿最大的差异）**

1. 新建 `src/services/browse/fetch.ts`——带守卫的 HTTP 层；
2. 新建 `src/services/browse/extract.ts`——cheerio 解析（正文启发式 + 链接编号表）；
3. 新建 `src/services/browse/page-pool.ts`——人粒度页面缓存；
4. 新建 `src/agent/tools/open-page.ts`——按 §5.3 契约实现；
5. 新建 `src/agent/deep-search.ts`——深检图（searchNode / planNode / browseLlm / browseTools / synthesize + 条件边）；
6. 新建 `src/services/deep-search.ts`——CommandService 壳（/深度检索，别名 ds）；
7. 改 `src/registry.ts`——补一行 `registerCommand(deepSearchService)`；
8. 改 `src/services/prompts/functional.ts` + `builder.ts`——新增 deep_plan / deep_browse / deep_report 场景，deep_plan 与 deep_browse 进 PURE_FUNCTIONAL_SCENES；
9. 改 `src/config.ts` + `.env.example`——新增 §6.1 配置项；
10. 改 `package.json`——+cheerio。

**二期（交互，依赖一期验证）**

11. `npm i playwright` + `npx playwright install chromium`；
12. 新建 `src/services/browse/browser.ts`——按 §5.6 A 档实现（图级生命周期 + 动作串行化）；B 档（进程级单例 + 会话隔离）暂不做，出现实际痛点再升档；
13. 新建 `src/agent/tools/interact-page.ts`——按 §5.5 契约实现，挂深检图工具列表；
14. 截图接入图片池与识图链路。

**三期（登录态，依赖二期）**

15. browser.ts 升 C 档：`launchPersistentContext`（固定 profile 目录 `data/browser-profile`），替代 A 档的临时 context（§5.6）；
16. 新建 `src/machines/login.ts`——扫码登录会话状态机（§5.7）；
17. 复用会话状态机基础设施（`src/session/runner.ts`）与 QQ 发图能力（`src/qq/messages.ts`）。

## 8. 降级路径

- **cheerio 被否决**（坚持零新依赖）：深检退化为「Tavily 摘要汇总」——searchNode 照跑、跳过 browse 循环、直接 synthesize 摘要材料（`search.ts` 的 `include_raw_content` 已开启，摘要 + 原文片段可用）；放弃链接深挖与一切交互。日常 `/Agent` 的浅检索不受影响；
- **Tavily 起点质量差 / 0 结果**：deep_browse 提示词允许模型用 open_page 直接打开搜索引擎结果页（如 `bing.com/search?q=…`）自寻起点；
- **Playwright 二期被否决**（体积/运维顾虑）：交互能力不做，一期阅读不受影响；
- **单页解析失败**（正文提取为空）：返回原始 `<body>` 文本的前 N 字符 + 链接表，标注"正文提取失败，以下为原始文本片段"，深挖仍可继续；
- **预算耗尽**：synthesize 拿部分材料收尾（§6.1），不报错。

## 9. 配置与文件清单

```text
新增文件：
  src/agent/deep-search.ts            深检图（StateGraph）
  src/services/deep-search.ts         /深度检索 命令壳
  src/services/browse/fetch.ts        HTTP 层 + 安全守卫
  src/services/browse/extract.ts      cheerio 解析
  src/services/browse/page-pool.ts    人粒度页面缓存
  src/agent/tools/open-page.ts        一期工具
  src/services/browse/browser.ts      二期：Playwright 生命周期管理（§5.6 三档，起步 A 档）
  src/agent/tools/interact-page.ts    二期：交互工具
  src/machines/login.ts               三期：扫码登录状态机

修改文件：
  src/registry.ts                     +1 行 registerCommand
  src/services/prompts/functional.ts  +deep_plan / deep_browse / deep_report 场景
  src/services/prompts/builder.ts     PURE_FUNCTIONAL_SCENES +deep_plan、deep_browse
  src/config.ts / .env.example        BROWSE_* 配置项
  package.json                        +cheerio（一期）、+playwright（二期）

新增依赖：
  cheerio（一期，纯 JS）
  playwright（二期，含浏览器二进制；三期零新增）

不改动（与初稿的关键差异）：
  src/agent/loop.ts                   MAX_TOOL_TURNS 保持 1，日常 Agent 行为不变；思维链字段也刻意不加（理由见 §5.2 chain 小结）
  src/services/agent.ts               工具注册不动，open_page 不进共享注册表
  src/handlers/*、src/events/*        深检回复走现有 markdown-first 链路
```

```text
.env 配置项（一期）：
  BROWSE_MAX_TURNS=6
  BROWSE_PAGE_TIMEOUT_MS=10000
  BROWSE_TOTAL_BUDGET_MS=60000
  BROWSE_MAX_CONTENT_TOKENS=3000
  BROWSE_MAX_LINKS=30
```

## 10. 明确排除 / 后续扩展

- **不做通用爬虫**：没有全站索引、没有持久化页面库，每次深挖都是一次性任务；
- **不做表单批量提交、登录、验证码**：交互仅限"读信息所需的最低动作"（翻页/展开/搜索框），涉及账号操作的场景明确拒绝——**三期之前**；三期引入扫码登录后，登录态访问限定为用户本人账号 + 白名单站点，批量提交与验证码对抗仍然禁止；
- **不做验证码对抗**：不接打码平台、不用视觉模型解验证码（见 6.4）；
- **不改日常链路**：/Agent 的 search 工具、MAX_TOOL_TURNS、提示词全部保持现状，深检与浅检索并存互补；
- **后续扩展候选**：检索词改写节点（searchNode 前加一个 flash 小节点，把口语问题改写成更利的检索词——当前直接拿原句当 query）；报告择要写入长期记忆（跨会话可召回）；Readability 增强正文提取；PDF/文档类型支持（复用多模态）；页面池持久化以支持"继续上次浏览"。
