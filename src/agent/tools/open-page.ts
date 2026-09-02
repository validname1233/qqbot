// agent/tools/open-page.ts —— 深检图的静态阅读工具。
// 注意：只注册进深检图的独立工具表（deep-search/registry.ts），**不进 agent/registry.ts
// 全局注册表**（总设计 §4：进了共享表会被日常 /Agent 的 toolSchemas() 一并发给闲聊模型，
// 等于把深检能力漏回日常链路）。所以除了 Tool 契约导出，还保留裸的 run 函数供测试直调。
//
// 与 interact_page 的分工：本工具用 fetch+cheerio（快、便宜、无浏览器开销），
// 页面需要 JS 渲染或点击交互时模型应改调 interact_page。

import type { BotEvent } from "../../events/registry.js";
import type { Tool } from "../tool.js";
import type { ToolSchema } from "../types.js";
import type { MessageContext } from "../../types.js";
import { fetchPage } from "../../services/browse/fetch.js";
import { extractPage, formatPageForModel } from "../../services/browse/extract.js";
import { savePage, resolveLink } from "../../services/browse/page-pool.js";
import { logger } from "../../services/logger.js";

export const openPageSchema: ToolSchema = {
  type: "function",
  function: {
    name: "open_page",
    description:
      "打开一个网页并阅读，返回标题、正文摘要和编号链接列表。" +
      "想深入某个链接时，再次调用本工具并传 link 编号。" +
      "适用于阅读普通网页；页面需要 JS 渲染或点击按钮时改用 interact_page 工具。",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "完整网址（与 link 二选一）" },
        link: { type: "number", description: "上次返回结果中的链接编号（与 url 二选一）" },
      },
    },
  },
};

// Tool 契约导出：注册进深检注册表用。run 内部 catch 掉一切异常转成给模型的文字——
// 单页失败不该炸穿整张图（深检多轮循环的容错语义），细粒度文案才能让模型自愈重试。
export const openPageTool: Tool = {
  name: "open_page",
  description: openPageSchema.function.description,
  parameters: openPageSchema.function.parameters,
  run: (args: Record<string, unknown>, ctx: MessageContext) => runOpenPage(args, ctx.event),
};

// 同一工具的日常 Agent 版本：浅拷贝改 description（fetch_tool 方案 §2.1——
// 日常语境没有 interact_page 兜底（深检专属），要突出"用户给了网址就打开"；
// 双注册表各持一份描述，run 逻辑单一维护）。
export const agentOpenPageTool: Tool = {
  ...openPageTool,
  description:
    "打开一个网页并阅读其内容。当用户消息里包含网址（http(s)://...），" +
    "或明确让你查看/打开某个网页、链接时调用。返回页面标题、正文摘要和页面内的链接列表" +
    "（带编号，跟进页面内的链接时可再次调用并传 link 编号）。" +
    "注意：这不是搜索工具——需要查找信息来源时用 search，已经拿到具体网址时用本工具。",
};

// "抓取 → 提取 → 入池 → 格式化"管线：open_page 工具与深检图 searchNode 的 URL
// 预读共用——入口节点把用户消息里的网址直接读成页面材料，不经模型转手（消灭
// "模型逐字抄写用户 URL"这个最后的幻觉/丢字风险点，总设计 §3.2：无判断的步骤
// 该是确定性代码）。失败直接抛出（fetchPage 的错误自带可读文案），兜底方式由
// 调用方决定：工具路径转成模型可读的提示串（runOpenPage 的 catch），
// 预读路径收进失败清单（searchNode 的全败 Tavily 兜底）。
export async function loadPage(url: string, event: BotEvent): Promise<string> {
  const t0 = Date.now();
  const fetched = await fetchPage(url);
  const page = extractPage(fetched.html, fetched.finalUrl);
  savePage(event, fetched.finalUrl, page);
  logger.debug("browse", `页面加载完成 ${fetched.finalUrl} (+${Date.now() - t0}ms)`);
  return formatPageForModel(page, fetched.finalUrl);
}

export async function runOpenPage(
  args: Record<string, unknown>,
  event: BotEvent,
): Promise<string> {
  const url = typeof args.url === "string" ? args.url.trim() : "";
  const link = typeof args.link === "number" ? args.link : null;

  // 参数校验：二选一。错误文案写给模型看，它读到后可自行修正重试
  if (url === "" && link === null) {
    return "参数错误：请提供 url 或 link 之一。";
  }
  if (url !== "" && link !== null) {
    return "参数错误：url 和 link 只能传一个，请只保留一个。";
  }

  let target = url;
  if (link !== null) {
    const resolved = resolveLink(event, link);
    if (resolved === null) {
      return `链接编号 ${link} 已失效（页面池过期或编号不存在），请用 url 参数重新打开页面。`;
    }
    target = resolved;
  }

  // 兜底：抓取/解析的异常转成给模型的文字而不是抛出——单页失败不该炸穿整张图，
  // 模型读到"这页读不到"会自己换链接继续（这才是深检多轮循环的容错语义）。
  // 403/超时等常见失败给出可行动的提示：换链接或改用 interact_page（真浏览器 UA）。
  try {
    return await loadPage(target, event);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("browse", `open_page 抓取失败 ${target}: ${message}`);
    return `打开 ${target} 失败：${message}。可以换一个链接，或改用 interact_page 工具（真实浏览器访问，部分拒绝爬虫的网站只接受它）。`;
  }
}
