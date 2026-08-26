// test/deep_research/run-graph.ts —— 本地直跑深检图（A 档验证），不碰 QQ 事件层。
// 走 runDeepSearchLocally：mock ctx + 跳过短期记忆落库（不创建/写 data/memory.sqlite）。
// 用法：
//   npx tsx --env-file=.env test/deep_research/run-graph.ts "调研问题"
//   npx tsx --env-file=.env test/deep_research/run-graph.ts "https://example.com"   # 直接给起点
// 建议 LOG_LEVEL=debug 跑（同命令前缀），能看到每轮 tool_calls 和页面抓取明细。
// 设计文档：本目录 方案.md；总设计 docs/superpowers/specs/2026-08-24-deep-web-browsing-design.md

import { runDeepSearchLocally } from "../../src/agent/deep-search.js";

const question = process.argv[2];
if (question === undefined || question.trim() === "") {
  console.log('用法：npx tsx --env-file=.env test/deep_research/run-graph.ts "调研问题或起始URL"');
  process.exit(1);
}

console.log(`[run-graph] 调研问题：${question}`);
console.log("[run-graph] 开始运行深检图（Tavily 起点 → 多轮浏览 → 汇总报告）…\n");

const t0 = Date.now();
try {
  const report = await runDeepSearchLocally(question);
  const seconds = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n[run-graph] 完成，总耗时 ${seconds}s\n`);
  console.log("========== 最终报告 ==========\n");
  console.log(report);
} catch (error) {
  const seconds = ((Date.now() - t0) / 1000).toFixed(1);
  console.error(`\n[run-graph] 失败（${seconds}s）：${error instanceof Error ? error.stack : error}`);
  process.exitCode = 1;
} finally {
  // 显式退出：Playwright 进程和可能的 SQLite 句柄会挂住事件循环，自然结束不可靠
  process.exit(process.exitCode === 1 ? 1 : 0);
}
