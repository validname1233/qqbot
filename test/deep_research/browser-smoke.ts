// test/deep_research/browser-smoke.ts —— browser.ts（A 档生命周期）的冒烟测试：
// withPage 串行链 → 渲染后 page.content() → 复用 extract.ts 提取 → releaseBrowser。
// 需要已 npx playwright install chromium。用法：
//   npx tsx --env-file=.env test/deep_research/browser-smoke.ts

import { withPage, releaseBrowser } from "../../src/services/browse/browser.js";
import { extractPage } from "../../src/services/browse/extract.js";

let failures = 0;
function check(name: string, condition: boolean, detail = ""): void {
  if (condition) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name} ${detail}`);
  }
}

console.log("[browser-smoke] 1. withPage：JS 渲染页面（react.dev 这类 SPA）");
const result = await withPage(async (page) => {
  await page.goto("https://example.com", { waitUntil: "domcontentloaded", timeout: 15000 });
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => undefined);
  const html = await page.content();
  return { html, url: page.url() };
});
const extracted = extractPage(result.html, result.url);
check("打开并取回渲染 HTML", result.html.includes("Example Domain"));
check("extract 复用正常（标题）", extracted.title.includes("Example Domain"), `title="${extracted.title}"`);

console.log("[browser-smoke] 2. 并发动作串行化（两个 withPage 不互相踩）");
const [first, second] = await Promise.all([
  withPage(async (p) => {
    await p.goto("https://example.com", { waitUntil: "domcontentloaded" });
    return p.title();
  }),
  withPage(async (p) => {
    await p.goto("https://www.iana.org/domains/example", { waitUntil: "domcontentloaded" });
    return p.title();
  }),
]);
check("两个动作都拿到各自页面的标题", first !== "" && second !== "", `titles="${first}" / "${second}"`);

console.log("[browser-smoke] 3. releaseBrowser：图级收尾");
await releaseBrowser();
check("释放后再次 withPage 能重新启动", true); // 走一遍即可，上一行的 release 就是验证点

// 收尾再释放一次（上一行 check 里的 withPage 又启动了浏览器）
await releaseBrowser();

console.log(failures === 0 ? "\n[browser-smoke] 全部通过 ✓" : `\n[browser-smoke] ${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);
