// services/browse/fetch.ts —— 深度检索的 HTTP 抓取层 + 安全守卫。
// 只负责"安全地拿到一个网页的 HTML"：SSRF 防护、重定向跟随、大小/类型/超时限制、
// 同域串行节流。不解析 HTML（那是 extract.ts 的事），不碰浏览器（动态页面走 browser.ts）。
// 用 Node 内置 fetch（与项目里 Tavily/QQ API 调用同一风格），不引入 HTTP 库。

import { lookup } from "node:dns/promises";
import { config } from "../../config.js";
import { logger } from "../logger.js";

// 抓取上限：响应体 2MB——正常网页 HTML 远小于此，超限的多半是误下二进制/超大页面。
const MAX_BODY_BYTES = 2 * 1024 * 1024;
// 重定向跟随上限：每一跳都要重新过协议/IP 守卫，防止"首跳安全、二跳进内网"的绕过。
const MAX_REDIRECTS = 5;
// 同域名两次请求的最小间隔：礼貌抓取，别打爆小站。
const SAME_HOST_INTERVAL_MS = 500;

export interface FetchedPage {
  html: string;
  finalUrl: string; // 跟完重定向后的最终地址（相对链接解析的基准）
}

// ---- 私网/保留地址判断（SSRF 防护的核心） ----

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return true; // 解析不出来的当危险处理
  }
  const [a, b] = parts;
  return (
    a === 127 || // 127.0.0.0/8 回环
    a === 10 || // 10.0.0.0/8
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
    (a === 192 && b === 168) || // 192.168.0.0/16
    (a === 169 && b === 254) || // 169.254.0.0/16 链路本地（含云元数据端点）
    a === 0 // 0.0.0.0/8
  );
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  return (
    lower === "::1" || // 回环
    lower === "::" || // 未指定地址
    lower.startsWith("fe80:") || // 链路本地
    lower.startsWith("fc") || // ULA fc00::/7
    lower.startsWith("fd")
  );
}

// DNS 解析并校验全部记录：任何一条落在私网就拒绝。
// 校验"全部"而不是"第一条"——DNS rebinding 的初级形态就是同域名多条记录里混一条内网地址。
async function assertPublicHost(hostname: string): Promise<void> {
  try {
    const records = await lookup(hostname, { all: true });
    if (records.length === 0) {
      throw new Error(`域名 ${hostname} 解析不到任何地址`);
    }
    for (const { address, family } of records) {
      const bad = family === 4 ? isPrivateIPv4(address) : isPrivateIPv6(address);
      if (bad) {
        throw new Error(`目标 ${hostname} 解析到内网/保留地址 ${address}，已拒绝访问`);
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("已拒绝访问")) throw error;
    throw new Error(`域名 ${hostname} DNS 解析失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

// ---- 同域串行 + 间隔（进程级队列，跨会话生效） ----

const hostQueues = new Map<string, Promise<void>>();
const hostLastRun = new Map<string, number>();

// 把一次抓取排进目标域名的队列：同域请求天然串行，且与上次执行间隔 ≥500ms。
function enqueue<T>(host: string, task: () => Promise<T>): Promise<T> {
  const previous = hostQueues.get(host) ?? Promise.resolve();
  const next = previous.then(task);
  // 队列存"上一次的尾巴"（失败不阻塞后续），执行前补齐间隔
  hostQueues.set(
    host,
    next.then(
      () => {
        hostLastRun.set(host, Date.now());
      },
      () => {
        hostLastRun.set(host, Date.now());
      },
    ),
  );
  return (async () => {
    const last = hostLastRun.get(host) ?? 0;
    const wait = last + SAME_HOST_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    return next;
  })();
}

// ---- 主入口 ----

export async function fetchPage(rawUrl: string): Promise<FetchedPage> {
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    // 每一跳都重新解析 URL + 过守卫：协议可能变、重定向域名可能变
    let parsed: URL;
    try {
      parsed = new URL(current);
    } catch {
      throw new Error(`不是合法的网址：${current}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`只支持 http/https 协议，收到 ${parsed.protocol}`);
    }
    await assertPublicHost(parsed.hostname);

    const html = await enqueue(parsed.hostname, () => fetchOnce(parsed, current));

    if (html.redirectTo !== null) {
      current = new URL(html.redirectTo, current).href; // 相对 Location 也要以当前页为基准转绝对
      continue;
    }
    return { html: html.body, finalUrl: current };
  }
  throw new Error(`重定向次数超过 ${MAX_REDIRECTS} 次，放弃抓取`);
}

interface OnceResult {
  body: string;
  redirectTo: string | null;
}

async function fetchOnce(url: URL, originalUrl: string): Promise<OnceResult> {
  // 发请求前打一行：超时/慢站时能立刻看出"卡在哪次获取上"，不用等 10s 报错才知道
  logger.info("browse", `正在获取 ${originalUrl}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.browsePageTimeoutMs);

  try {
    const response = await fetch(url, {
      redirect: "manual", // 手动跟重定向：每一跳都能重新过守卫
      signal: controller.signal,
      headers: {
        "User-Agent": "qq-bot/1.0 (+web-browse)",
        Accept: "text/html,application/xhtml+xml",
      },
    });

    // 重定向：交给外层循环处理
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (location === null) throw new Error(`收到 ${response.status} 但没有 Location 头`);
      return { body: "", redirectTo: location };
    }

    if (!response.ok) {
      throw new Error(`抓取 ${originalUrl} 返回 ${response.status}`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
      throw new Error(`目标不是网页（Content-Type: ${contentType || "未知"}）`);
    }

    // 大小双保险：Content-Length 预检 + 流式计数
    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (declaredLength > MAX_BODY_BYTES) {
      throw new Error(`页面超过 ${MAX_BODY_BYTES / 1024 / 1024}MB 大小上限`);
    }

    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("响应没有内容流");
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) {
        received += value.byteLength;
        if (received > MAX_BODY_BYTES) {
          await reader.cancel();
          throw new Error(`页面超过 ${MAX_BODY_BYTES / 1024 / 1024}MB 大小上限`);
        }
        chunks.push(value);
      }
    }

    const buffer = Buffer.concat(chunks);
    // charset：优先响应头，没有再默认 utf-8（现代网页基本都 utf-8，
    // <meta charset> 兜底交给 extract.ts 之后的 cheerio——parse5 能处理标签声明）
    const charset = /charset=([\w-]+)/i.exec(contentType)?.[1] ?? "utf-8";
    let body: string;
    try {
      body = buffer.toString(charset as BufferEncoding);
    } catch {
      body = buffer.toString("utf-8");
    }

    logger.debug("browse", `fetchPage 完成 ${originalUrl} → ${response.url} (${received}B)`);
    return { body, redirectTo: null };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`抓取 ${originalUrl} 超时（${config.browsePageTimeoutMs}ms）`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
