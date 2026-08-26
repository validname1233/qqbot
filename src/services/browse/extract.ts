// services/browse/extract.ts —— HTML → 模型友好的页面摘要。
// cheerio 解析：标题、正文（启发式截取）、编号链接表。静态路径（fetch.ts 抓回来的）
// 和动态路径（browser.ts 渲染后 page.content() 拿到的）共用这一套提取逻辑——
// 两条路径对模型返回的格式完全一致，模型不需要区分页面是哪来的。

import * as cheerio from "cheerio";
import { config } from "../../config.js";

export interface PageLink {
  no: number; // 编号：模型下一轮 open_page 传它，而不是抄完整 URL
  text: string; // 链接文字（模型判断"这个链接值不值得跟"的依据）
  url: string; // 绝对地址
}

export interface ExtractedPage {
  title: string;
  text: string; // 截断后的正文纯文本
  links: PageLink[];
}

// 正文提取前要剥掉的标签：脚本/样式是代码不是内容，导航/页脚/侧栏是模板噪声。
const STRIP_SELECTORS = "script, style, noscript, nav, footer, aside, header, form, iframe";

// 中文约 1 字 ≈ 1 token，按字符截断即近似按 token 截断（总设计 §5.3 的折算口径）。
function truncateText(text: string): string {
  const limit = config.browseMaxContentTokens;
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…（正文过长，已截断）`;
}

export function extractPage(html: string, baseUrl: string): ExtractedPage {
  const $ = cheerio.load(html);

  const title = ($("title").first().text() || $("h1").first().text() || "").trim();

  // 正文：剥掉噪声标签后取 body 文本，压掉连续空白。启发式从简——
  // 先取全文本，效果不够再上"文本密度最高子块"或 readability（总设计 §8 预留的升级位）。
  $(STRIP_SELECTORS).remove();
  const rawText = $("body").text();
  const text = truncateText(
    rawText
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .join("\n"),
  );

  // 链接：a[href] → 绝对化 → 过滤非 http 和同页锚点 → 截上限。
  const seen = new Set<string>();
  const links: PageLink[] = [];
  $("a[href]").each((_, element) => {
    if (links.length >= config.browseMaxLinks) return;

    const href = $(element).attr("href");
    if (href === undefined) return;

    let absolute: URL;
    try {
      absolute = new URL(href, baseUrl);
    } catch {
      return;
    }
    if (absolute.protocol !== "http:" && absolute.protocol !== "https:") return;

    // 去掉锚点后再判重：#section 和本体是同一个页面
    absolute.hash = "";
    const key = absolute.href;
    if (key === "" || seen.has(key)) return;
    seen.add(key);

    const text_ = $(element).text().trim().replace(/\s+/g, " ").slice(0, 60);
    // 没有文字的链接（纯图片按钮）用 URL pathname 兜底，保证模型至少能看到指向
    links.push({ no: links.length + 1, text: text_ !== "" ? text_ : absolute.pathname, url: key });
  });

  return { title, text, links };
}

// 把提取结果渲染成给模型看的文本（open_page / interact_page 的返回值共用）。
export function formatPageForModel(page: ExtractedPage, url: string): string {
  const linkLines = page.links
    .map((link) => `${link.no}. "${link.text}" → ${link.url}`)
    .join("\n");
  return `[页面] 标题：${page.title || "（无标题）"}（${url}）
[正文]
${page.text !== "" ? page.text : "（正文提取为空，可能是 JS 渲染页面，可尝试 interact_page 工具）"}

[链接]
${linkLines !== "" ? linkLines : "（页面内没有可跟进的链接）"}`;
}
