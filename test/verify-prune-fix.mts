// test/verify-prune-fix.mts —— Bug2 修复验证：prune 挪到 chat 行落库后，新图不再被误删。
// 模拟完整链路（绕过下载：手动插图片行 + recordInbound 的关键顺序）。
// 运行：cd /d/TS/qq-bot && npx tsx --env-file=.env test/verify-prune-fix.mts

process.env.MEMORY_DB_PATH = "memory.sqlite"; // 生产库文件（用唯一测试键隔离）
const { appendEvent, clearEvents, chatRows } = await import("../src/agent/memory/events.js");
const { db } = await import("../src/agent/memory/events.js");
const { pruneImagesOutsideWindow } = await import("../src/agent/memory/images.js");

const KEY = `group:prune-fix-${Date.now()}`;
clearEvents(KEY);

// 手动模拟 persistEventImages 成功后的状态（绕过真实下载）：
// 在 message_images 插一行（图片行已建，chat 行还没写——旧 bug 的引爆时点）
const ins = db.prepare(`
  INSERT INTO message_images (key, qq_msg_id, seq, fileid, filename, content_type, file_path, description, created_at)
  VALUES (?, 'FIX-M1', 0, 'fid-fix', 'fix.png', 'image/png', '', NULL, ?)
`);
const r = ins.run(KEY, Date.now());
const imgId = Number(r.lastInsertRowid);
console.log("模拟图片入库 id =", imgId);

// 旧 bug 时序：此刻 prune（chat 行未写）→ 图被删。先复现确认：
pruneImagesOutsideWindow(KEY);
const afterOld = db.prepare(`SELECT COUNT(*) c FROM message_images WHERE id = ?`).get(imgId) as { c: number };
console.log("① 旧时序复现（落行前 prune，此时无引用）:", afterOld.c === 0 ? "图被误删 ❌（bug 复现）" : "图存活（意外）");

// 重新插一张，走新时序：先落 chat 行（建立引用）→ 再 prune
const r2 = ins.run(KEY, Date.now());
const imgId2 = Number(r2.lastInsertRowid);
appendEvent({
  key: KEY, kind: "chat_user", role: "user",
  author: { openid: "u-fix", name: "验证" },
  content: "看这只猫", attachmentIds: [imgId2], qqMsgId: "FIX-M2",
});
pruneImagesOutsideWindow(KEY);
const afterNew = db.prepare(`SELECT COUNT(*) c FROM message_images WHERE id = ?`).get(imgId2) as { c: number };
const chatRow = chatRows(KEY, 1)[0];
console.log("② 新时序（落行后 prune，引用已建立）:", afterNew.c === 1 ? "图存活 ✅" : "图被删 ❌");
console.log("③ chat 行 attachment_ids:", chatRow?.attachmentIds, Array.isArray(chatRow?.attachmentIds) && chatRow.attachmentIds[0] === imgId2 ? "✅ 引用一致" : "❌");

clearEvents(KEY);
db.prepare(`DELETE FROM message_images WHERE key = ?`).run(KEY);
console.log("\n结论：", afterNew.c === 1 ? "修复有效——prune 必须在引用建立后调用" : "仍有问题");
process.exit(afterNew.c === 1 ? 0 : 1);
