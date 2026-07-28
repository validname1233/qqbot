// services/search.ts —— 调用 Tavily 联网搜索接口。
// 职责单一：给关键词，返回搜索结果列表。这次只给 Agent 用（用户不能 /命令 直接调），
// 所以本文件不实现 CommandService，就是个纯函数服务，角色和 ai.ts 的 askAI 一样。

import { config } from "../config.js";

const API_URL = "https://api.tavily.com/search";

// 默认「结果少、搜索浅」：够用又省 Tavily 额度，模型需要更多/更深时可自己传参覆盖。
export const DEFAULT_MAX_RESULTS = 3;
export const DEFAULT_SEARCH_DEPTH: "basic" | "advanced" = "basic";

export interface SearchResult {
  title: string;
  url: string;
  content: string; // 摘要片段
}

// 只声明用得到的字段，Tavily 返回里其余字段（score、images 等）忽略。
interface TavilyResponse {
  results?: Array<{ title?: string; url?: string; content?: string }>;
}

export async function tavilySearch(
  query: string,
  maxResults: number = DEFAULT_MAX_RESULTS,
  searchDepth: "basic" | "advanced" = DEFAULT_SEARCH_DEPTH,
): Promise<SearchResult[]> {
  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.tavilyApiKey}`,
    },
    body: JSON.stringify({
      query,
      auto_parameters: false,
      topic: "general",
      search_depth: searchDepth,
      chunks_per_source: 3,
      max_results: maxResults,
      time_range: null,
      include_answer: false,
      include_raw_content: false,
      include_images: false,
      include_image_descriptions: false,
      include_favicon: false,
      include_domains: [],
      exclude_domains: [],
      country: null,
      include_usage: false,
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Tavily 接口返回 ${response.status}: ${detail}`);
  }

  const data = (await response.json()) as TavilyResponse;
  return (data.results ?? []).map((r) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    content: r.content ?? "",
  }));
}

// 把结果列表整理成一段文本——只给「标题+链接+摘要」，不用 Tavily 自带的 include_answer
// 总结，让模型/用户自己判断怎么用这些原始结果。
export function formatSearchResults(results: SearchResult[]): string {
  if (results.length === 0) {
    return "没有搜到相关结果。";
  }
  return results
    .map((r, i) => `${i + 1}. ${r.title}\n${r.url}\n${r.content}`)
    .join("\n\n");
}
