# 联网搜索源调研：Bing Search API 现状与备选方案

> 状态：调研报告（未实现）
> 起因：计划在 `services/search.ts` 中添加 Bing 搜索入口（`bingSearch`）+ `searchProvider` 配置切换机制
> 日期：2026-08-31

## 1. 核心结论（先看这个）

**原计划接的 Bing Search API v7 已于 2025 年 8 月 11 日正式退役，无法接入。** 微软官方文档（learn.microsoft.com/bing/search-apis）明确公告："Public Bing Search and Bing Custom Search APIs were retired on 11th August 2025"——新客户不能注册，存量客户已停服，Azure 门户的创建入口已关闭。

微软给出的官方替代品（Grounding with Bing Search）对个人 bot **不可行**，理由见 §2.2。

**建议改为接入博查（Bocha）AI 搜索 API**（§3）作为第二搜索源：国内服务、中文搜索质量好、API 形态与 Tavily 高度相似、接入成本最低。`searchProvider` 配置切换机制的设计不受影响，只是 `bingSearch` 换成 `bochaSearch`。

## 2. Bing 搜索产品线现状

### 2.1 已退役的 Bing Search API v7（原计划接入对象）

以下信息仅供了解历史 API 形态（来自微软已归档的文档），**该服务已不可用**：

| 项目 | 内容 |
|---|---|
| 端点 | `GET https://api.bing.microsoft.com/v7.0/search` |
| 认证 | 请求头 `Ocp-Apim-Subscription-Key: <key>` |
| 核心参数 | `q`（必填，URL 编码）、`count`/`offset`（分页）、`mkt`（市场，如 zh-CN）、`safeSearch` |
| 响应结构 | `webPages.value[]`，每条含 `name`/`url`/`snippet` |
| 可选请求头 | `X-MSEdge-ClientID`（会话连续性）、`X-MSEdge-ClientIP`、`X-Search-Location`（位置感知） |
| 状态 | ❌ 2025-08-11 退役，文档页已标注 `is_retired: true` |

### 2.2 官方替代品：Grounding with Bing Search（不可行）

微软现在把搜索能力并入了 Azure AI Foundry Agent Service，作为 agent 的内置工具（`WebSearchTool` / `bing_grounding`）。对个人 bot 的三重障碍：

1. **不返回原始搜索结果**：它只在 agent 内部工作，返回"AI 处理后的回答 + 引用"，开发者拿不到 `webPages.value[]` 这样的结构化结果列表——无法适配我们 `SearchResult { title, url, content }` 的接口契约（深检图的起点材料、news 的链接列表都依赖原始结果）；
2. **强绑定 Azure 生态**：需要 Azure 付费订阅（免费/赞助订阅不可用）+ Foundry 项目 + agent 部署，搜索是 agent 的附属工具而非独立 API；
3. **价格贵一个数量级**：$14 / 1000 次交易（Tavily 付费档 $5/1000，免费档每月 1000 次）。

注册入口（仅供了解）：portal.azure.com/#create/Microsoft.BingGroundingSearch（需 Azure 订阅 + Owner/Contributor 角色）。

### 2.3 对我们的启示

微软搜索 API 的退役是搜索源集中化的缩影（Google 也关过 Similar）：**独立网页搜索 API 这个品类在收缩，选型时要优先考虑服务存续风险**。这也是支持做 `searchProvider` 切换机制的实际论据——单一搜索源随时可能涨价/退役/限制，可切换多源是必要的韧性设计。

## 3. 建议的替代源：博查（Bocha）AI 搜索 API

### 3.1 基本信息

| 项目 | 内容 |
|---|---|
| 定位 | 国内面向 AI/LLM 的搜索服务（"给 AI 用的世界知识搜索引擎"） |
| 端点 | `POST https://api.bochaai.com/v1/web-search` |
| 认证 | `Authorization: Bearer <API-KEY>`（与 Tavily 同款 Bearer 模式） |
| 注册入口 | open.bochaai.com → 控制台（/dashboard）注册获取 key |
| 中文支持 | 原生中文搜索（示例即中文 query，返回新华网/澎湃等中文源） |

### 3.2 API 形态（与 Tavily 的对照）

请求体（JSON）：

```json
{
  "query": "React 19.2 新特性",
  "freshness": "oneYear",     // 时效过滤，类比 Tavily 的 time_range
  "summary": true,            // 是否返回摘要（true 时结果带 summary 字段）
  "count": 8                  // 返回条数，类比 Tavily 的 max_results
}
```

响应核心结构：

```json
{
  "webPages": {
    "totalEstimatedMatches": 600000,
    "value": [
      {
        "name": "页面标题",
        "url": "https://...",
        "siteName": "站点名",
        "snippet": "摘要片段",
        "summary": "AI 摘要（summary=true 时）",
        "datePublished": "2026-08-01"
      }
    ]
  }
}
```

映射到现有 `SearchResult` 接口零障碍：`name→title`、`url→url`、`snippet/summary→content`。

### 3.3 待确认事项（接入前核实）

- **定价与免费额度**：官网价格信息在飞书文档里，本次调研未能直接获取。已知信息：按量计费，具体单价需注册后在控制台确认（社区说法约 ¥3-5/千次，需以官方为准）；
- **频控限制**：未获取到明确的 QPS 限制文档；
- **freshness 的完整取值**：示例见 `"oneYear"`，完整枚举（如 noLimit/day/week/month）需查官方文档；
- **advanced 深度搜索的对应能力**：Tavily 的 `search_depth` 参数在博查是否有等价物未知——若无，`bochaSearch` 的 searchDepth 参数可以静默忽略（接口兼容即可）。

### 3.4 其他候选（调研过，不推荐或待议）

| 服务 | 结论 |
|---|---|
| Brave Search API | 形态合适，但免费档要绑卡、付费 $3-5/千次，且中文搜索质量一般 |
| Serper.dev（Google 代理） | 质量好，$50/50k 次起，个人 bot 成本偏高 |
| SerpAPI | 同为 Google 代理，更贵（$75/5k 次起） |
| 智谱 web-search-pro | 国内备选，与现有智谱 embedding 同一账号体系，可作第二候选（本次未深入调研，接入博查失败时再看） |

## 4. searchProvider 切换机制的设计建议

调研确认了多源切换的必要性，机制设计（延续项目 env 配置惯例）：

### 4.1 配置层（config.ts + .env.example）

```text
SEARCH_PROVIDER=tavily            # tavily | bocha，默认 tavily（不填向后兼容）
BOCHA_API_KEY=你的博查APIKey      # provider=bocha 时必填
```

校验逻辑：`SEARCH_PROVIDER=bocha` 时对 `BOCHA_API_KEY` 做 requireEnv（启动即报缺，不拖到运行时）。

### 4.2 服务层（services/search.ts）

```ts
// 统一入口按配置分发，签名与现有 tavilySearch 完全一致——三个调用方
// （agent/tools/search.ts、news/cron.ts、agent/deep-search.ts）改一行 import 即接入：
export async function webSearch(
  query: string,
  maxResults?: number,
  searchDepth?: "basic" | "advanced",
): Promise<SearchResult[]>
```

实现方式：`webSearch` 内部按 `config.searchProvider` 分发到 `tavilySearch` / `bochaSearch`；两个具体实现保持 `SearchResult[]` 返回契约。`formatSearchResults` 不动（它只吃 SearchResult）。

两种调用方迁移策略可选：

- **激进**：三个调用点直接改调 `webSearch`（一次性换统一入口）；
- **保守**：把 `tavilySearch` 函数体改成内部转发 `webSearch`（调用点零改动，名字暂时名不副实）。

建议激进版——调用点只有三处，改动小且不留历史包袱。

### 4.3 不建议的方案

- **多源自动 fallback**（tavily 失败自动切 bocha）：先不做。失败切换涉及"配额双重消耗""两套错误语义"的复杂度，等真实遇到过单源故障再说；
- **按 query 语言自动选源**（中文走博查、英文走 Tavily）：听起来聪明，但让搜索行为不可预测、问题难排查。显式配置优于隐式智能。

## 5. 参考链接

- Bing Search v7 退役公告（归档文档首页）：https://learn.microsoft.com/en-us/bing/search-apis/
- Bing Web Search v7 API 文档（归档，仅供了解历史形态）：https://learn.microsoft.com/en-us/bing/search-apis/bing-web-search/search-the-web
- Grounding with Bing Search（微软现行的搜索产品，Azure 绑定）：https://learn.microsoft.com/en-us/azure/ai-services/agents/how-to/tools/bing-grounding
- Grounding 定价页（$14/千次）：https://www.microsoft.com/en-us/bing/apis
- 博查 AI 开放平台（建议的第二搜索源）：https://open.bochaai.com/
