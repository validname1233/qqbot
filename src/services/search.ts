// services/search.ts —— 联网搜索的统一入口（provider 模式）。
// 调用方一律用 webSearch()，运行时按 SEARCH_PROVIDER 环境变量分发到具体实现：
//   tavily（默认，向后兼容）或 aliyun（OpenSearch 联网搜索）。
// 加新 provider：实现一个签名同 webSearch 的函数，加进 PROVIDERS 分发表即可。
// 具体请求/解析逻辑收在各 provider 函数里，本文件顶部只管分发与公共类型。
//
// 三个调用方（全部经 webSearch，谁都不直接碰具体 provider）：
//   agent/tools/search.ts   /Agent 的 search 工具（透传 maxResults/searchDepth）
//   agent/deep-search.ts    深检图 searchNode（调研起点）
//   services/scheduler/     通用定时任务（到点跑的 /Agent 里模型可能调 search 工具）
//
// 调研背景与选型记录：docs/superpowers/specs/2026-08-31-search-provider-research.md
// （Bing v7 已退役）与 2026-08-31-aliyun-web-search-research.md（阿里接入规范）。

import { config } from "../config.js";
import { logger } from "./logger.js";

export interface SearchResult {
  title: string;
  url: string;
  content: string; // 摘要片段
}

export type SearchDepth = "basic" | "advanced";

// provider 实现的统一签名：与 webSearch 完全一致，便于直接进分发表。
type SearchProvider = (
  query: string,
  maxResults: number,
  searchDepth: SearchDepth,
) => Promise<SearchResult[]>;

// ---------------- Tavily provider ----------------

const TAVILY_API_URL = "https://api.tavily.com/search";

// 默认「结果少、搜索浅」：够用又省 Tavily 额度，模型需要更多/更深时可自己传参覆盖。
export const DEFAULT_MAX_RESULTS = 6;
export const DEFAULT_SEARCH_DEPTH: SearchDepth = "basic";

interface TavilyResponse {
  results?: Array<{ title?: string; url?: string; content?: string }>;
}

async function tavilySearch(
  query: string,
  maxResults: number,
  searchDepth: SearchDepth,
): Promise<SearchResult[]> {
  const response = await fetch(TAVILY_API_URL, {
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
      chunks_per_source: 5,
      max_results: maxResults,
      time_range: "month",
      include_answer: false,
      include_raw_content: true,
      include_images: false,
      include_image_descriptions: false,
      include_favicon: false,
      include_domains: [],
      exclude_domains: [],
      country: null,
      include_usage: false,
    }),
  });

  // 响应一到手就记录（成败都有）：排查时先看这条确认"请求确实到达了对端、拿到什么状态"，
  // 再决定往下看成功解析还是错误分支。与 !response.ok 分支里的 warn 是配合关系。
  logger.info(
    "search",
    `tavilySearch 响应 status=${response.status} ok=${response.ok} query="${query.slice(0, 50)}"`,
  );

  if (!response.ok) {
    const detail = await response.text();
    logger.warn(
      "search",
      `tavilySearch 失败 status=${response.status} query="${query.slice(0, 50)}" detail=${detail.slice(0, 300)}`,
    );
    throw new Error(`Tavily 接口返回 ${response.status}: ${detail}`);
  }

  const data = (await response.json()) as TavilyResponse;
  return (data.results ?? []).map((r) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    content: r.content ?? "",
  }));
}

// ---------------- 阿里云 OpenSearch 联网搜索 provider ----------------
// 接入规范见调研文档：POST {host}/v3/openapi/workspaces/{ws}/web-search/ops-web-search-001
// Bearer 认证；query_rewrite 保持默认 true（服务端免费帮忙把口语问题改写成利检索词）；
// searchDepth 映射 way 档位：basic→pro，advanced→pro-fetch（增强搜索+深度解析）。

interface AliyunSearchResponse {
  result?: {
    search_result?: Array<{
      title?: string;
      link?: string;
      snippet?: string;
    }>;
  };
}

// 阿里 QPS 上限 3（主+RAM 子账号合计）：串行链强制相邻调用间隔 ≥350ms，留出安全余量。
// 个人 bot 的量级（深检一次搜一次、news 低频）几乎不会真正等待，纯保险。
const ALIYUN_MIN_INTERVAL_MS = 350;
let aliyunLastCall = 0;

async function aliyunSearch(
  query: string,
  maxResults: number,
  searchDepth: SearchDepth,
): Promise<SearchResult[]> {
  // 排队限速：上一个调用还没结束或间隔未满，等齐再发（进程内所有 aliyun 搜索共用一条线）
  const wait = aliyunLastCall + ALIYUN_MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  aliyunLastCall = Date.now();

  const endpoint =
    `${config.aliyunSearchHost}/v3/openapi/workspaces/${config.aliyunSearchWorkspace}` +
    `/web-search/ops-web-search-001`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.aliyunSearchApiKey}`,
    },
    body: JSON.stringify({
      query,
      top_k: maxResults,
      content_type: "snippet",
      way: searchDepth === "advanced" ? "pro-fetch" : "pro",
    }),
  });

  // 响应一到手就记录（成败都有）：与 tavily 侧同款，排查时先看这条确认请求到达对端。
  logger.info(
    "search",
    `aliyunSearch 响应 status=${response.status} ok=${response.ok} query="${query.slice(0, 50)}"`,
  );

  if (!response.ok) {
    const detail = await response.text();
    logger.warn(
      "search",
      `aliyunSearch 失败 status=${response.status} query="${query.slice(0, 50)}" detail=${detail.slice(0, 300)}`,
    );
    throw new Error(`阿里联网搜索接口返回 ${response.status}: ${detail}`);
  }

  const data = (await response.json()) as AliyunSearchResponse;
  return (data.result?.search_result ?? []).map((r) => ({
    title: r.title ?? "",
    url: r.link ?? "",
    content: r.snippet ?? "",
  }));
}

// ---------------- 分发层 ----------------

const PROVIDERS: Record<string, SearchProvider> = {
  tavily: tavilySearch,
  aliyun: aliyunSearch,
};

export async function webSearch(
  query: string,
  maxResults: number = DEFAULT_MAX_RESULTS,
  searchDepth: SearchDepth = DEFAULT_SEARCH_DEPTH,
): Promise<SearchResult[]> {
  const provider = PROVIDERS[config.searchProvider];
  if (provider === undefined) {
    logger.error("search", `webSearch 配置错误：SEARCH_PROVIDER=${config.searchProvider}（可用：${Object.keys(PROVIDERS).join("/")}）`);
    throw new Error(`未知的 SEARCH_PROVIDER: ${config.searchProvider}（可用：${Object.keys(PROVIDERS).join("/")}）`);
  }
  const t0 = Date.now();
  try {
    const results = await provider(query, maxResults, searchDepth);
    logger.debug("search", `webSearch[${config.searchProvider}] "${query}" → ${results.length} 条 (+${Date.now() - t0}ms)`);
    return results;
  } catch (error) {
    // provider 抛错（含 !response.ok 的接口失败与网络异常）在重新抛出前统一记录：
    // 三个调用方的兜底逻辑各不相同（工具兜成失败短语/深检走 Tavily 兜底），但日志
    // 只在这里记一次就够——provider 内部已带 status/detail 的明细行。
    const message = error instanceof Error ? error.message : String(error);
    logger.error("search", `webSearch[${config.searchProvider}] 失败 (+${Date.now() - t0}ms) query="${query.slice(0, 50)}" error=${message.slice(0, 300)}`);
    throw error;
  }
}

// 把结果列表整理成一段文本——只给「标题+链接+摘要」，不用搜索服务自带的总结，
// 让模型/用户自己判断怎么用这些原始结果。
export function formatSearchResults(results: SearchResult[]): string {
  if (results.length === 0) {
    return "没有搜到相关结果。";
  }
  return results
    .map((r, i) => `${i + 1}. ${r.title}\n${r.url}\n${r.content}`)
    .join("\n\n");
}
