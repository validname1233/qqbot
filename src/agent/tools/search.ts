// agent/tools/search.ts —— 把联网搜索包装成 Agent 可调用的工具。
// 具体请求/解析/源切换逻辑全在 services/search.ts（webSearch 按 SEARCH_PROVIDER
// 分发到 tavily/aliyun），这里只做「模型给的结构化参数 → 调用」的转换。

import type { Tool } from "../tool.js";
import {
  DEFAULT_MAX_RESULTS,
  DEFAULT_SEARCH_DEPTH,
  formatSearchResults,
  webSearch,
} from "../../services/search.js";

export const searchTool: Tool = {
  name: "search",
  description:
    "联网搜索最新信息。用于回答需要实时/最新数据或你不确定的事实性问题。返回若干条标题+链接+摘要。",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "搜索关键词",
      },
      max_results: {
        type: "integer",
        description: `返回结果条数，默认 ${DEFAULT_MAX_RESULTS}，非必要不要设太大`,
      },
      search_depth: {
        type: "string",
        enum: ["basic", "advanced"],
        description: `搜索深度，默认 "${DEFAULT_SEARCH_DEPTH}"；"advanced" 更深入但消耗更多额度，只在 basic 结果明显不够时才用`,
      },
    },
    required: ["query"],
  },

  async run(args) {
    const query = typeof args.query === "string" ? args.query : "";
    if (query.trim() === "") {
      return "工具执行失败";
    }
    const maxResults =
      typeof args.max_results === "number" ? args.max_results : DEFAULT_MAX_RESULTS;
    const searchDepth =
      args.search_depth === "advanced" ? "advanced" : DEFAULT_SEARCH_DEPTH;

    const results = await webSearch(query, maxResults, searchDepth);
    return formatSearchResults(results);
  },
};
