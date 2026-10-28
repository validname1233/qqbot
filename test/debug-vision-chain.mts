// test/debug-vision-chain.mts —— 识图链路探针：从 env → config → 库 → 识图调用全链戳一遍。
// 运行：cd /d/TS/qq-bot && npx tsx --env-file=.env test/debug-vision-chain.mts
// 服务器上同样跑这个（.env 在项目根目录），五段输出定位断点在哪一环。

import { config } from "../src/config.js";

console.log("========== ① env 原始值 ==========");
console.log("VISION_API_KEY 长度:", (process.env.VISION_API_KEY ?? "").length,
  process.env.VISION_API_KEY ? "（已设置）" : "（❌ 未设置/空）");
console.log("VISION_MODEL:", process.env.VISION_MODEL ?? "（未设置，将用默认）");

console.log("\n========== ② config 解析结果 ==========");
console.log("config.visionApiKey 长度:", config.visionApiKey.length,
  config.visionApiKey === "" ? "❌ 空（enableVision=false，全部降级 [图片]）" : "✅ 有值");
console.log("config.visionModel:", config.visionModel);
console.log("enableVision 判定（assembly 用的口径）:", config.visionApiKey !== "" ? "✅ true" : "❌ false");

console.log("\n========== ③ 库里最近的图片行 ==========");
const { db } = await import("../src/agent/memory/events.js");
const imgRows = db.prepare(
  `SELECT id, key, qq_msg_id, seq, filename, file_path, description, created_at
   FROM message_images ORDER BY id DESC LIMIT 5`,
).all() as Array<{ id: number; key: string; qq_msg_id: string; seq: number; filename: string; file_path: string; description: string | null; created_at: number }>;
if (imgRows.length === 0) {
  console.log("❌ message_images 是空表——没有图片行，下载环节全败（Bug2 主链）");
} else {
  for (const r of imgRows) {
    console.log(`id=${r.id} key=${r.key.slice(0, 14)}… seq=${r.seq} file=${r.filename}`,
      `desc=${r.description === null ? "❌ NULL（未识图）" : `✅ ${r.description.slice(0, 20)}…`}`,
      `path=${r.file_path === "" ? "❌ 空" : "✅"}`);
  }
}

console.log("\n========== ④ chat 行的 attachment_ids 联动 ==========");
const chatRowsWithImg = db.prepare(
  `SELECT id, content, attachment_ids FROM conversation_events
   WHERE attachment_ids IS NOT NULL ORDER BY id DESC LIMIT 5`,
).all() as Array<{ id: number; content: string; attachment_ids: string }>;
if (chatRowsWithImg.length === 0) {
  console.log("❌ 没有任何 chat 行带 attachment_ids——图片引用列从未被写入");
} else {
  for (const r of chatRowsWithImg) {
    console.log(`chat#${r.id} attachment_ids=${r.attachment_ids} content=${JSON.stringify((r.content ?? "").slice(0, 30))}`);
  }
}

console.log("\n========== ⑤ 识图调用实测（仅当 ② 有 key 且 ③ 有图时） ==========");
if (config.visionApiKey === "") {
  console.log("跳过：config.visionApiKey 为空——断点已定位在 ①/②（env 缺 key 或没传进进程）");
} else {
  const withFile = imgRows.find((r) => r.file_path !== "");
  if (withFile === undefined) {
    console.log("跳过：库里没有带文件路径的图片行");
  } else {
    console.log(`用 id=${withFile.id}（${withFile.filename}）实测 describeImage…`);
    try {
      const { readFileSync } = await import("node:fs");
      const { describeImage } = await import("../src/services/vision.js");
      const bytes = readFileSync(withFile.file_path);
      const desc = await describeImage(bytes, "image/png");
      console.log("✅ 识图成功：", desc.slice(0, 80));
    } catch (err) {
      console.log("❌ 识图调用失败：", err instanceof Error ? err.message : err);
    }
  }
}

console.log("\n========== 排查结论指引 ==========");
console.log("① 空 → .env 里没这行或名字写错（注意大小写/空格）");
console.log("① 有 ② 空 → pm2 启动方式没吃到 .env（见下方说明）");
console.log("② 有 ③ desc=NULL → 渲染环节没触发或识图抛错（看 ⑤）");
console.log("③ 空表 → 下载全败，Bug2 主链（看服务器 [images] warn 日志）");
console.log("⑤ 失败 → key 无效/过期，或 DashScope 端点不通");
console.log("\n⚠ pm2 注意：pm2 start npm -- run webhook 只继承 pm2 daemon 的环境，");
console.log("  .env 是否被加载取决于运行方式——tsx --env-file=.env 在 npm script 里才会传。");
process.exit(0);
