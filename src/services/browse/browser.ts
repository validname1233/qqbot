// services/browse/browser.ts —— Playwright 图级生命周期管理（A 档，总设计 §5.6）。
// A 档语义：一次深检请求一套浏览器——首个 interact_page 才懒启动，深检图收尾
// （runDeepSearch 的 finally）调 releaseBrowser 整体关闭，状态清零、内存归零。
//
// 对外只暴露 withPage / releaseBrowser 两个函数——这是三档通用的接口：
// 升 B 档（进程级单例+按会话分 context）或 C 档（persistent context）只改本文件内部，
// 工具层与深检图零改动。
//
// 动作串行化（A 档的硬要求）：深检图 browseTools 节点会并发执行同轮的多个 tool_calls，
// 两个 interact_page 同时操作同一个 page 会互相踩（A 页还没读完就被 goto 到 B 页）。
// 所有动作经 chain 排队，同一时刻只跑一个。

import { platform } from "node:os";
import { chromium, type Page } from "playwright";
import { logger } from "../logger.js";

// UA 伪装：headless Chromium 默认 UA 带 "HeadlessChrome" 标记，等于在 HTTP 头和
// navigator.userAgent 里自报自动化身份，是 UA 黑名单类风控（如 GitHub 的降级页）
// 最便宜的命中点。覆盖成同版本（151，对齐捆绑 Chromium 大版本）的真实 Chrome UA。
// OS 段跟随真实系统：sec-ch-ua-platform 等客户端提示头仍按真实平台发送，
// UA 写 Windows 而主机是 Linux 会制造新的自相矛盾指纹。
const UA_OS =
  platform() === "win32" ? "Windows NT 10.0; Win64; x64" : "X11; Linux x86_64";
const CHROME_UA = `Mozilla/5.0 (${UA_OS}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36`;

let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
let page: Page | null = null;
let chain: Promise<unknown> = Promise.resolve();

// 在（唯一的）页面上执行一个动作。并发调用自动排队。
export async function withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    if (browser === null) {
      logger.debug("browse", "browser 懒启动：launch chromium");
      // --disable-blink-features=AutomationControlled：去掉 navigator.webdriver
      // 自动化标记（与 UA 伪装同层，挡最便宜的第一道检测；IP 信誉问题管不着）
      browser = await chromium.launch({
        args: ["--disable-blink-features=AutomationControlled"],
      });
    }
    if (page === null || page.isClosed()) {
      page = await browser.newPage({ userAgent: CHROME_UA });
    }
    return fn(page);
  });
  // 队列尾巴接住失败：一次动作报错不能让后续动作永远排队不上
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// 图级收尾：关浏览器、清引用。幂等（重复调用无害）。
export async function releaseBrowser(): Promise<void> {
  await chain; // 等在途动作做完再关，不抢跑
  await browser?.close();
  browser = null;
  page = null;
  logger.debug("browse", "browser 已释放（A 档：图级生命周期结束）");
}
