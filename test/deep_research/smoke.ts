// test/deep_research/smoke.ts —— 不依赖任何 API key 的冒烟测试：
// 只验证能力层（fetch 守卫 → cheerio 提取 → 页面池 → 格式化），不调 Tavily/LLM/浏览器。
// 用法：npx tsx --env-file=.env test/deep_research/smoke.ts
// 注意：config.ts 会对 AI_API_KEY 等做 requireEnv 校验，所以 .env 里的占位符
// 能过启动（非空即可），冒烟测试全程不会用到它们。

import { fetchPage } from "../../src/services/browse/fetch.js";
import { extractPage, formatPageForModel } from "../../src/services/browse/extract.js";
import { savePage, resolveLink, clearPagePools } from "../../src/services/browse/page-pool.js";
import type { BotEvent } from "../../src/events/registry.js";

const mockEvent = {
  type: "C2C_MESSAGE_CREATE",
  authorOpenid: "smoke-test",
  authorName: "冒烟测试",
} as unknown as BotEvent;

let failures = 0;
function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name} ${detail}`);
  }
}

// ---- 1. fetch + extract：抓一个稳定的静态页 ----
console.log("[smoke] 1. fetch + cheerio 提取（example.com）");
const fetched = await fetchPage("https://example.com");
const page = extractPage(fetched.html, fetched.finalUrl);
check("抓取成功", fetched.finalUrl.startsWith("https://example.com"), `finalUrl=${fetched.finalUrl}`);
check("标题非空", page.title !== "", `title="${page.title}"`);
check("正文非空", page.text !== "");
check("链接表存在", Array.isArray(page.links));

// ---- 2. 页面池：save → resolveLink ----
console.log("[smoke] 2. 页面池存取");
savePage(mockEvent, fetched.finalUrl, page);
const noLink = page.links.length > 0 ? page.links[0]!.no : null;
if (noLink !== null) {
  const resolved = resolveLink(mockEvent, noLink);
  check("编号能解析回 URL", resolved === page.links[0]!.url, `resolved=${resolved}`);
} else {
  console.log("  （example.com 没有链接，跳过编号解析检查）");
}
check("越界编号返回 null", resolveLink(mockEvent, 9999) === null);
clearPagePools();
check("清池后编号失效", resolveLink(mockEvent, noLink ?? 1) === null);

// ---- 3. SSRF 守卫 ----
console.log("[smoke] 3. SSRF 守卫");
for (const bad of ["http://127.0.0.1/", "http://10.0.0.1/", "http://192.168.1.1/", "http://169.254.169.254/"]) {
  let rejected = false;
  try {
    await fetchPage(bad);
  } catch (error) {
    rejected = error instanceof Error && error.message.includes("已拒绝");
  }
  check(`拒绝 ${bad}`, rejected);
}
let protocolRejected = false;
try {
  await fetchPage("ftp://example.com/");
} catch (error) {
  protocolRejected = error instanceof Error && error.message.includes("http/https");
}
check("拒绝非 http 协议", protocolRejected);

// ---- 4. 格式化输出 ----
console.log("[smoke] 4. 模型可见的输出格式");
const formatted = formatPageForModel(page, fetched.finalUrl);
check("含标题段", formatted.includes("[页面]"));
check("含正文段", formatted.includes("[正文]"));
check("含链接段", formatted.includes("[链接]"));

console.log(failures === 0 ? "\n[smoke] 全部通过 ✓" : `\n[smoke] ${failures} 项失败 ✗`);
// 等一拍再退：SSRF 守卫测试留下的 DNS 查询还在事件循环里，立刻 exit 会触发 libuv 断言
await new Promise((resolve) => setTimeout(resolve, 200));
process.exit(failures === 0 ? 0 : 1);
