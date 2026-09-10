// agent/tools/interact-page.ts —— 深检图的动态交互工具（Playwright 路径）。
// 处理 fetch+cheerio 搞不定的场景：JS 渲染的页面（fetch 拿回空壳）、点击按钮/
// 翻页/展开、填写搜索框。动作经 browser.ts 的串行链排队（A 档），动作后拿渲染完的
// HTML 复用 extract.ts 提取——与 open_page 返回格式完全一致。
//
// 同样只注册进深检注册表（deep-search/registry.ts），不进全局注册表（理由见 open-page.ts）。

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { BotEvent } from "../../events/registry.js";
import type { Tool } from "../tool.js";
import type { ToolSchema } from "../types.js";
import type { MessageContext } from "../../types.js";
import { withPage } from "../../services/browse/browser.js";
import { extractPage, formatPageForModel } from "../../services/browse/extract.js";
import { savePage } from "../../services/browse/page-pool.js";
import { logger } from "../../services/logger.js";

// 截图落盘目录（A 档：只存盘返回路径，视觉兜底等 B/C 档再接识图链路——总设计 §9）
const SCREENSHOT_DIR = join("data", "deep-research");

export const interactPageSchema: ToolSchema = {
  type: "function",
  function: {
    name: "interact_page",
    description:
      "在需要 JS 渲染或按钮交互的页面上执行动作：打开页面、点击元素、输入文本、滚动、截图。" +
      "返回动作后的页面内容（标题+正文+编号链接表）。当 open_page 返回的正文为空或明显不完整时，改用本工具。",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "要打开的完整网址" },
        action: {
          type: "string",
          enum: ["click", "fill", "scroll", "screenshot"],
          description: "打开页面后执行的动作；click/fill 需要 target，fill 还需要 value",
        },
        target: {
          type: "string",
          description: "目标元素的角色化描述，格式 '角色:名称'，如 'button:下一页'、'input:搜索'",
        },
        value: { type: "string", description: "fill 动作的输入内容" },
      },
      required: ["url"],
    },
  },
};

// "button:下一页" → getByRole("button", { name: "下一页" })。
// 角色名白名单对齐 Playwright ARIA role 的常用子集；input 特判成 textbox
// （中文页面说 input 多指文本框）。
const ROLE_ALIASES: Record<string, string> = {
  button: "button",
  link: "link",
  input: "textbox",
  textbox: "textbox",
  search: "searchbox",
  checkbox: "checkbox",
  tab: "tab",
  menuitem: "menuitem",
};

// Tool 契约导出：注册进深检注册表用。runInteractPage 内部已自带 try/catch
// 兜底（细粒度错误文案让模型自愈），不会再向外抛异常。
export const interactPageTool: Tool = {
  name: "interact_page",
  description: interactPageSchema.function.description,
  parameters: interactPageSchema.function.parameters,
  // 进度文案带动作：interact_page 的耗时主要在 Playwright 渲染（数秒级），
  // "正在用浏览器交互"与 open_page 的"正在打开网页"区分开，用户能感知到
  // 当前卡在哪类操作上。
  progressNote: (args) => {
    const url = typeof args.url === "string" ? args.url.slice(0, 40) : "";
    const action = typeof args.action === "string" && args.action !== "" ? args.action : "打开";
    return url !== "" ? `---正在用浏览器${action}：${url}---` : `---正在用浏览器${action}页面---`;
  },
  run: (args: Record<string, unknown>, ctx: MessageContext) => runInteractPage(args, ctx.event),
};

export async function runInteractPage(
  args: Record<string, unknown>,
  event: BotEvent,
): Promise<string> {
  const url = typeof args.url === "string" ? args.url.trim() : "";
  const action = typeof args.action === "string" ? args.action : "";
  const target = typeof args.target === "string" ? args.target : "";
  const value = typeof args.value === "string" ? args.value : "";

  if (url === "") return "参数错误：请提供 url。";
  if (action !== "" && !["click", "fill", "scroll", "screenshot"].includes(action)) {
    return `参数错误：action 只能是 click/fill/scroll/screenshot，收到 "${action}"。`;
  }
  if ((action === "click" || action === "fill") && target === "") {
    return `参数错误：${action} 动作需要 target（如 "button:下一页"）。`;
  }
  if (action === "fill" && value === "") {
    return "参数错误：fill 动作需要 value（要输入的内容）。";
  }

  const t0 = Date.now();
  try {
    const result = await withPage(async (page) => {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });

      if (action === "click") {
        await locate(page, target).first().click({ timeout: 5000 });
      } else if (action === "fill") {
        await locate(page, target).first().fill(value, { timeout: 5000 });
      } else if (action === "scroll") {
        await page.mouse.wheel(0, 2000);
      } else if (action === "screenshot") {
        mkdirSync(SCREENSHOT_DIR, { recursive: true });
        const path = join(SCREENSHOT_DIR, `shot-${Date.now()}.png`);
        await page.screenshot({ path, fullPage: false });
        return `已截图保存到 ${path}（A 档暂不接视觉分析，截图仅供人工排查）。`;
      }

      // 动作后等一下网络空闲的近似（JS 渲染页内容常是异步填充的），再取渲染完的 HTML
      await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => undefined);
      const html = await page.content();
      const finalUrl = page.url();
      const extracted = extractPage(html, finalUrl);
      savePage(event, finalUrl, extracted);
      return formatPageForModel(extracted, finalUrl);
    });

    logger.debug("browse", `interact_page(${action || "open"}) 完成 ${url} (+${Date.now() - t0}ms)`);
    return result;
  } catch (error) {
    // 细粒度错误文案：定位失败 vs 页面打不开，模型能据此调整（换个 target / 放弃该页）
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("Timeout") || message.includes("timeout")) {
      return `动作执行超时：${message.slice(0, 200)}。可以换一个 target 描述，或改用 url 直接访问。`;
    }
    return `interact_page 执行失败：${message.slice(0, 200)}`;
  }
}

// 角色化描述 → Playwright locator。返回 any locator 类型由 withPage 内的 page 参数承担。
//
// getByRole(角色, { name }) 的 name 匹配的是元素的「可访问名称」——浏览器按
// ACCM 规范计算出的结果，来源优先级：
//   aria-labelledby > aria-label > 关联的 <label> > 元素自身内容文字 > placeholder
// 对按钮/链接，"元素自身文字"是最常见来源（<button>下一页</button> 的可访问名称
// 就是"下一页"，无需任何 aria 标注）；图标按钮（无文字）才真正依赖 aria-label。
function locate(page: import("playwright").Page, target: string) {
  const separator = target.indexOf(":");
  const role = separator === -1 ? "button" : target.slice(0, separator);
  const name = separator === -1 ? target : target.slice(separator + 1);

  const resolved = ROLE_ALIASES[role.toLowerCase()];
  if (resolved === undefined) {
    throw new Error(
      `不认识的角色 "${role}"（支持：${Object.keys(ROLE_ALIASES).join("/")}）`,
    );
  }
  if (resolved === "textbox" || resolved === "searchbox") {
    // 文本框类：按占位符和无障碍名求并集（.or() 无优先级，两条同时匹配取并集）。
    // 必要性：placeholder 在 ACCM 优先级垫底，只写 placeholder 没写 aria-label/
    // label 的输入框（真实网页的大多数）其可访问名称为空——getByRole 单路必查空；
    // 而 placeholder 是这类框身上唯一可靠的文字。规范查询 + 现实兜底，两边都能命中。
    return page.getByPlaceholder(name).or(page.getByRole(resolved as "textbox", { name }));
  }
  return page.getByRole(resolved as Parameters<typeof page.getByRole>[0], { name });
}
