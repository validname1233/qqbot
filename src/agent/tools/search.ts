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

    // 兜底：搜索异常转成给模型的文字而不是抛出——search 现在同时挂在深检注册表
    // （planTools 自寻起点用），深检的 runTool 不做"工具执行失败"统一兜底
    // （细粒度文案才可自愈），异常漏出去会炸穿整张深检图（同 open_page 当初
    // 的 403 问题）。网络抖动/接口故障时模型读到提示可换检索词重试。
    let results;
    try {
      results = await webSearch(query, maxResults, searchDepth);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return `搜索"${query.slice(0, 50)}"失败：${reason.slice(0, 200)}。可以换一个检索词重试，或用 open_page 打开搜索引擎结果页。`;
    }
    return formatSearchResults(results);
  },
};
