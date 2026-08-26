// agent/tools/open-page.ts —— 深检图的静态阅读工具。
// 注意：只挂深检图的工具列表（deep-search.ts 本地数组），**不进 agent/registry.ts 共享注册表**
// （总设计 §4：进了共享表就会被日常 /Agent 的 toolSchemas() 一并发给闲聊模型，
// 等于把深检能力漏回日常链路）。所以这里不实现 Tool 契约给 registerTool 用，
// 而是导出 schema + run 两件套，由深检图自己组装。
//
// 与 interact_page 的分工：本工具用 fetch+cheerio（快、便宜、无浏览器开销），
// 页面需要 JS 渲染或点击交互时模型应改调 interact_page。

import type { BotEvent } from "../../events/registry.js";
import type { ToolSchema } from "../types.js";
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

  const t0 = Date.now();
  // 兜底：抓取/解析的异常转成给模型的文字而不是抛出——单页失败不该炸穿整张图，
  // 模型读到"这页读不到"会自己换链接继续（这才是深检多轮循环的容错语义）。
  // 403/超时等常见失败给出可行动的提示：换链接或改用 interact_page（真浏览器 UA）。
  let fetched: Awaited<ReturnType<typeof fetchPage>>;
  try {
    fetched = await fetchPage(target);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("browse", `open_page 抓取失败 ${target}: ${message}`);
    return `打开 ${target} 失败：${message}。可以换一个链接，或改用 interact_page 工具（真实浏览器访问，部分拒绝爬虫的网站只接受它）。`;
  }
  const page = extractPage(fetched.html, fetched.finalUrl);
  savePage(event, fetched.finalUrl, page);
  logger.debug("browse", `open_page 完成 ${fetched.finalUrl} (+${Date.now() - t0}ms)`);

  return formatPageForModel(page, fetched.finalUrl);
}
