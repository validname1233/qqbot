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

import { chromium, type Page } from "playwright";
import { logger } from "../logger.js";

let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
let page: Page | null = null;
let chain: Promise<unknown> = Promise.resolve();

// 在（唯一的）页面上执行一个动作。并发调用自动排队。
export async function withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    if (browser === null) {
      logger.debug("browse", "browser 懒启动：launch chromium");
      browser = await chromium.launch();
    }
    if (page === null || page.isClosed()) {
      page = await browser.newPage();
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
