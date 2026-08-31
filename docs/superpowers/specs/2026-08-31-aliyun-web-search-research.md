# 阿里云 OpenSearch 联网搜索 API 调研（web-search）

> 状态：调研报告（未实现）
> 起因：用户已有阿里云账号，评估其联网搜索 API 作为 `searchProvider` 切换机制的候选源之一（与《2026-08-31-search-provider-research.md》中的博查方案并列）
> 信息来源：help.aliyun.com/zh/open-search/search-platform/developer-reference/web-search（官方文档页，2026-08-31 抓取）
> 日期：2026-08-31

## 1. 一句话结论

阿里联网搜索 API 的**调用形态非常适合我们**（POST + Bearer token，响应就是 title/link/snippet 的结构化列表，与现有 `SearchResult` 契约几乎一一对应），且有几个 Tavily/博查都没有的独特能力（**`mainText` 模式直接返回网页正文**——相当于搜索+抓取一步到位）；但**公开渠道查不到具体单价**（计费文档全部 404，需登录控制台确认），且 QPS 限制 3 偏紧。建议：控制台确认价格后再决定是否接入。

## 2. 调用规范

### 2.1 端点与认证

```text
POST {host}/v3/openapi/workspaces/{workspace_name}/web-search/{service_id}

示例（杭州）：
POST https://xxxx-hangzhou.opensearch.aliyuncs.com/v3/openapi/workspaces/default/web-search/ops-web-search-001

请求头：
  Content-Type: application/json
  Authorization: Bearer 您的API-KEY        ← 与 Tavily/博查同款 Bearer 模式
```

- `host`：公网/VPC 两种接入地址（控制台 API Keys 页面顶部选工作空间后切换标签查看）——**VPC 端点对我们特别有价值**：你的 bot 跑在阿里云 ECS 上（iZ 开头主机名），走 VPC 网络调用免公网流量费且延迟更低；
- `workspace_name`：工作空间名，默认 `default`；
- `service_id`：联网搜索固定为 **`ops-web-search-001`**；
- API-KEY：控制台"获取 API-KEY"文档流程获取。

### 2.2 请求参数（Body JSON）

| 参数 | 类型 | 必填 | 说明 | 默认值 |
|---|---|---|---|---|
| `query` | String | ✅ | 搜索词 | — |
| `query_rewrite` | Boolean | 否 | 是否用 LLM 重写 query | `true` |
| `top_k` | Integer | 否 | 返回结果数 | 5 |
| `history` | List | 否 | 对话历史（`{role, content}`，system 可作首条）——多轮改写 query 用 | `null` |
| `content_type` | String | 否 | `snippet`（简短摘要）/ `summary`（LLM 摘要，更耗时）/ `mainText`（**网页正文**，最长） | `snippet` |
| `way` | String | 否 | `lite`（基础搜索+快速解析）/ `pro`（增强搜索+快速解析）/ `pro-fetch`（增强搜索+**深度解析**） | `pro` |

两个值得注意的参数语义：

- **`way` 与 `content_type` 的联动**：`way` 的解析策略部分（快速/深度）仅在 `content_type=mainText` 时生效；纯摘要场景下 lite/pro 的区别只在搜索质量本身；
- **`query_rewrite=true`（默认）**：服务端会用 LLM 重写搜索词。对深检的 searchNode 是利好（口语化问题自动优化成利检索词——总设计 §10"检索词改写节点"的候选实现，而且是免费的）；但如果想精确控制检索词，记得显式传 `false`。

### 2.3 响应结构

```json
{
  "request_id": "...",
  "latency": ...,
  "usage": { "ops-web-search-001/pro": 1 },
  "result": {
    "search_result": [
      {
        "title": "网页标题",
        "link": "https://...",
        "snippet": "网页摘要",
        "content": "（snippet 模式=摘要；mainText 模式=完整正文）",
        "position": null,
        "meta_info": { "publishedTime": "2026-08-01" }
      }
    ]
  }
}
```

映射到现有 `SearchResult { title, url, content }`：`title→title`、`link→url`、`snippet→content`。零障碍。

### 2.4 错误码

| 状态码 | 含义 |
|---|---|
| 200 | 成功 |
| 400 | InvalidParameter（参数不合法） |
| 404 | BadRequest.TaskNotExist（任务不存在） |
| 500 | InternalServerError（内部错误） |

## 3. 计费模式（部分未知）

**确定的**：

- 按调用量计费，`usage` 字段返回本次产生的计费项与次数（如 `"ops-web-search-001/pro": 1`）——**按 way 分档计费**，lite/pro/pro-fetch 单价不同（大概率递增）；
- **pro-fetch + mainText 组合产生双计费项**：一次调用同时记 `pro-fetch` 和 `pro` 两个账（深度解析 = 搜索费 + 解析费），这是最贵的组合，也是最接近"搜索+读正文"一体化的组合。

**未知的（公开渠道查不到）**：

- 各档具体单价：帮助中心的计费文档链接全部 404（billing-overview / billing-for-internet-search / billing 等路径均失效），价格计算器页面需登录后交互查询；
- 免费额度/试用额度：同上，未能确认。

**需要在控制台确认的清单**（接入前必做）：

1. 联网搜索各档（lite/pro/pro-fetch）单价；
2. 有无免费额度（阿里云 AI 类新服务常有 30 天或按量的试用额度，值得查）；
3. 自己账号当前的实际计费方式（按量付费是否需单独开通）。

## 4. 限制

| 项目 | 值 | 评估 |
|---|---|---|
| QPS | **3**（主账号+RAM 子账号合计） | 偏紧但够用：深检一次只搜 1 次；news cron 低频；Agent 工具单人触发。只有多群同时深检才可能撞限（可接受，重试即可） |
| 扩容 | 需工单联系技术支持 | 个人 bot 用不上 |
| 地域 | 示例为杭州，实际以控制台为准 | 无影响 |

## 5. 与候选方案的对比

| 维度 | Tavily（现有） | 阿里联网搜索 | 博查 |
|---|---|---|---|
| 中文搜索质量 | 一般 | 好（国内生态） | 好（国内生态） |
| 认证方式 | Bearer | Bearer | Bearer |
| 响应适配成本 | —（现有） | 低（字段直映射） | 低 |
| 独特能力 | include_raw_content | **mainText 直接返回正文**；VPC 端点；query_rewrite | 语义重排模型 |
| QPS | 充足 | **3** | 待确认 |
| 价格 | 免费 1000 次/月，付费 $5/千次 | **未知（需控制台确认）** | 待确认 |
| 账号便利性 | 需另注册 | **已有阿里云账号**（bot 还跑在 ECS 上） | 需另注册 |

**对深检的特别价值**：`content_type=mainText` 理论上可以让 searchNode 直接拿到起点页面的正文——省掉一轮 open_page 抓取。但要权衡：pro-fetch 双计费的价格可能比"搜索一次 + open_page 一次（免费）"更贵，等价格确认后再评估是否值得用。

## 6. 接入设计（若确认接入）

沿用《2026-08-31-search-provider-research.md》§4 的 `searchProvider` 框架，新增 `aliyun` 选项：

```text
.env:
  SEARCH_PROVIDER=aliyun
  ALIYUN_SEARCH_API_KEY=你的API-KEY
  ALIYUN_SEARCH_HOST=https://xxxx-hangzhou.opensearch.aliyuncs.com    # 控制台查
  ALIYUN_SEARCH_WORKSPACE=default
```

`aliyunSearch` 实现要点：

- 请求体：`{ query, top_k: maxResults, content_type: "snippet", way: searchDepth === "advanced" ? "pro-fetch" : "pro" }`——用现有 searchDepth 参数映射 way 档位（advanced→pro-fetch），语义顺承；
- `query_rewrite` 保持默认 true（白嫖服务端的 query 优化）；
- 响应映射：`result.search_result[].{title, link, snippet}` → `SearchResult`；
- QPS 3 的保险：`search.ts` 加一个简单的进程级限流（连续调用间隔 ≥350ms）——Tavily/博查不需要，可以做成 aliyun 分支独有，或统一直接受益。

## 7. 参考链接

- 联网搜索 API 官方文档（本报告主要来源）：https://help.aliyun.com/zh/open-search/search-platform/developer-reference/web-search
- API 参考总目录（服务广场）：https://help.aliyun.com/zh/open-search/search-platform/developer-reference/service-plaza/
- 前置调研（Bing 退役 + 博查 + searchProvider 设计）：`docs/superpowers/specs/2026-08-31-search-provider-research.md`
