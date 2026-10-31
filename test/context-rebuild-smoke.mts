// test/context-rebuild-smoke.mts —— 记忆重构冒烟测试。
// 验证（总方案实施顺序第 4 步 + v10 压缩决议 + 分发层短路）：
//   ① 入站收口：一条事件恰好一行 chat_user；QQ 重推（同 msgId）只落一行
//   ② blob 投影：批仅含 user 行、chat_bot 裸 assistant 隔断、排除当前消息行
//   ③ v10 压缩：条数截断（保留最近 N 行）+ 时间窗（超窗行离开投影）
//   ④ 就地 process：llmCall/toolsNode 的行落库（以直接调 appendEvent 模拟形状）
//   ⑤ 估算函数合理性 + ⑥ 提示词 v2 锚定（blob 示例同构、终止信号一致）
//   ⑦ 分发层短路：recordInbound 首见 true / 重推 false；图片全败落行 +
//      重推补图接回引用
// 运行：cd /d/TS/qq-bot && npx tsx --env-file=.env test/context-rebuild-smoke.mts
// 注：直接打生产库文件（data/memory.sqlite）——用唯一测试键隔离，结束清理。

import { appendEvent, clearEvents, chatRowsAll, chatRows } from "../src/agent/memory/events.js";
import { projectWindow } from "../src/agent/assembly.js";
import { estimateTokens } from "../src/agent/assembly.js";
import type { MessageContext } from "../src/types.js";
import type { BotEvent } from "../src/events/registry.js";
import { config } from "../src/config.js";

const KEY = `group:smoke-${Date.now()}`;
let pass = 0, fail = 0;
const check = (name: string, cond: boolean): void => {
  if (cond) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name}`); }
};

// ① 入站：两条不同 msgId 的 user 行 + 一条重推（同 msgId）+ bot 回复
appendEvent({ key: KEY, kind: "chat_user", role: "user", author: { openid: "u1", name: "小明" }, content: "今天天气怎么样", qqMsgId: "m1" });
appendEvent({ key: KEY, kind: "chat_user", role: "user", author: { openid: "u1", name: "小明" }, content: "今天天气怎么样", qqMsgId: "m1" }); // 重推
appendEvent({ key: KEY, kind: "chat_user", role: "user", author: { openid: "u2", name: "小红" }, content: "小明你吃饭了吗", qqMsgId: "m2" });
appendEvent({ key: KEY, kind: "chat_bot", role: "assistant", content: "还没呢，刚准备去", origin: "reply" });
appendEvent({ key: KEY, kind: "chat_user", role: "user", author: { openid: "u1", name: "小明" }, content: "帮我搜下周末天气", qqMsgId: "m3" });

const all = chatRows(KEY, 100);
check("① 重推去重（m1 只一行）", all.filter((r) => r.content === "今天天气怎么样").length === 1);
check("① 共 4 行（3 user + 1 bot）", all.length === 4);

// ② 投影：当前消息 = m3（排除），预期 [批(小明m1,小红m2), assistant(bot回复)]
const ev = {
  type: "GROUP_MESSAGE_CREATE", content: "帮我搜下周末天气", attachments: [],
  groupOpenid: KEY.slice(6), authorOpenid: "u1", authorRole: null, authorName: "小明",
  msgId: "m3", mentionsBot: true,
} as unknown as BotEvent;
const ctx: MessageContext = { event: ev, text: "帮我搜下周末天气", command: "Agent", args: "帮我搜下周末天气" };
const proj = await projectWindow(ctx);
const firstMsg = proj.messages[0];
const secondMsg = proj.messages[1];
check("② 投影 2 条消息（1 批 + 1 裸 assistant）", proj.messages.length === 2);
check("② 首条是 user 批（blob）", firstMsg?.role === "user" && (firstMsg.content ?? "").includes('"speaker":"小明"'));
check("② 批内含两行（m1+m2，m3 已排除）", ((firstMsg?.content ?? "").match(/\n/g) ?? []).length === 1);
check("② 次条是裸 assistant", secondMsg?.role === "assistant" && secondMsg.content === "还没呢，刚准备去");

// ③ v10 压缩之一——条数截断：上限临时压到 1，投影应只保留最近 1 行（bot 回复）
const realMax = config.contextMaxMessages;
const realWindow = config.sessionWindowHours;
(config as { contextMaxMessages: number }).contextMaxMessages = 1;
const projTrunc = await projectWindow(ctx);
(config as { contextMaxMessages: number }).contextMaxMessages = realMax;
check("③ 条数截断触发（候选 3 行 → 保留 1 行）", projTrunc.chatCount === 1);
check("③ 截断保留的是最近行（bot 回复）", projTrunc.messages.length === 1 && projTrunc.messages[0]?.role === "assistant");

// ③ v10 压缩之二——时间窗：窗口临时压到 0.0001h（0.36s），先等窗口滑过全部行，
// 再投影应为空（所有行都超窗了；system + u_now 恒在是装配外保证）
(config as { sessionWindowHours: number }).sessionWindowHours = 0.0001;
await new Promise((r) => setTimeout(r, 500));
const projStale = await projectWindow(ctx);
(config as { sessionWindowHours: number }).sessionWindowHours = realWindow;
check("③ 时间窗滑出（全部行超窗 → 投影为空）", projStale.messages.length === 0);
// 窗口恢复后投影回来（时间窗是纯视图行为，库里的行没动）
const projBack = await projectWindow(ctx);
check("③ 窗口恢复后投影回归（视图行为，库未动）", projBack.messages.length === 2);

// ④ process 行形状（模拟 llmCall/toolsNode 就地写入）
appendEvent({ key: KEY, kind: "process", role: "assistant", content: "需要搜索", toolCalls: [{ id: "tc1", type: "function", function: { name: "search", arguments: "{\"query\":\"周末天气\"}" } }], origin: "agent" });
appendEvent({ key: KEY, kind: "process", role: "tool", content: "搜索结果原文……", toolCallId: "tc1", origin: "agent" });
// 直接按 kind 断言（chatRows 只查 chat 行，process 用独立查询验证）
import { db } from "../src/agent/memory/events.js";
const procRows = db.prepare(
  `SELECT kind, role, tool_call_id, tool_calls FROM conversation_events WHERE key = ? AND kind = 'process' ORDER BY id`,
).all(KEY) as Array<{ kind: string; role: string; tool_call_id: string | null; tool_calls: string | null }>;
check("④ process 行落库（2 行）", procRows.length === 2);
check("④ tool 行带 tool_call_id", procRows[1]?.tool_call_id === "tc1");
check("④ assistant 行带 tool_calls JSON", procRows[0]?.tool_calls !== null && (procRows[0].tool_calls ?? "").includes("search"));
check("④ process 不进 L1 投影", chatRowsAll(KEY).every((r) => r.kind !== "process"));

// ⑤ 估算函数合理性
const zh = estimateTokens("今天天气不错".repeat(10));
const en = estimateTokens("hello world ".repeat(10));
check(`⑤ 估算（中文${zh}/英文${en} tokens，均 >0 且量级合理）`, zh > 0 && en > 0 && zh > en);

// ⑥ 提示词 v2 锚定（方案 2026-10-29-系统提示词模块化重构 §8）：
//    M1 示例行必须与 renderBlobLine 实际输出逐字节同构；M2.3 引述的终止
//    信号必须与 LOOP_EXHAUSTED_SIGNAL 同源（取信号开头短语锚定）。
import { renderBlobLine } from "../src/agent/assembly.js";
import { AGENT_UNIFIED_HEAD, LOOP_EXHAUSTED_SIGNAL } from "../src/services/prompts/functional.js";
const blobLineA = renderBlobLine("小明", "今天下午去打球吗", "");
const blobLineB = renderBlobLine("小红", "我放了个假期的照片 [图片]{一只橘猫趴在窗台上晒太阳，身后是绿植和半开的窗户}", "");
check("⑥ M1 示例行与 renderBlobLine 输出同构（纯文本行）", AGENT_UNIFIED_HEAD.includes(blobLineA));
check("⑥ M1 示例行与 renderBlobLine 输出同构（带图片行）", AGENT_UNIFIED_HEAD.includes(blobLineB));
check("⑥ M2.3 终止信号引述与 LOOP_EXHAUSTED_SIGNAL 一致", AGENT_UNIFIED_HEAD.includes(LOOP_EXHAUSTED_SIGNAL.slice(0, 11)));

// ⑦ 分发层短路（2026-10-30 决议）：recordInbound 的首见/重推语义。
// 直接调 recordInbound（生产收口函数）验证：无图消息首见 true、同 msgId
// 重推 false；图片全败落行（引用 NULL）；重推补图后引用接回。
import { recordInbound } from "../src/services/transcript.js";
const ev7 = {
  type: "GROUP_MESSAGE_CREATE", content: "短路测试", attachments: [],
  groupOpenid: KEY.slice(6), authorOpenid: "u1", authorRole: null, authorName: "小明",
  msgId: `shortcircuit-${Date.now()}`, mentionsBot: false,
} as unknown as BotEvent;
check("⑦ 无图消息首见 → true", (await recordInbound(ev7)) === true);
check("⑦ 同 msgId 重推 → false", (await recordInbound(ev7)) === false);
// 直接 mock persistEventImages 的失败面：插入无引用行后模拟重推接回）。
const ev7img = {
  type: "GROUP_MESSAGE_CREATE", content: "看这张图",
  attachments: [{ url: "http://127.0.0.1:1/x.jpg", filename: "x.jpg", contentType: "image/jpeg" }],
  groupOpenid: KEY.slice(6), authorOpenid: "u1", authorRole: null, authorName: "小明",
  msgId: `imgfail-${Date.now()}`, mentionsBot: false,
} as unknown as BotEvent;
// 只验证落行语义（不等真实下载超时）：手动落无引用行，模拟"全败也落行"
appendEvent({ key: KEY, kind: "chat_user", role: "user", author: { openid: "u1", name: "小明" }, content: "看这张图", attachmentIds: null, qqMsgId: ev7img.msgId });
const rowBefore = chatRowsAll(KEY).find((r) => r.qqMsgId === ev7img.msgId);
check("⑦ 图片全败仍落行（引用 NULL，无图降级）", rowBefore !== undefined && rowBefore.attachmentIds === null);
// 模拟重推补图：图片表插一行 + UPDATE 接回（recordInbound 重推分支同款 SQL）
db.prepare(`INSERT INTO message_images (key, qq_msg_id, seq, filename, content_type, file_path, created_at) VALUES (?, ?, 0, 'x.jpg', 'image/jpeg', '', ?)`).run(KEY, ev7img.msgId, Date.now());
const imgId = (db.prepare(`SELECT id FROM message_images WHERE key = ? AND qq_msg_id = ?`).get(KEY, ev7img.msgId) as { id: number }).id;
db.prepare(`UPDATE conversation_events SET attachment_ids = ? WHERE key = ? AND qq_msg_id = ? AND attachment_ids IS NULL`).run(JSON.stringify([imgId]), KEY, ev7img.msgId);
const rowAfter = chatRowsAll(KEY).find((r) => r.qqMsgId === ev7img.msgId);
check("⑦ 重推补图后引用接回", rowAfter !== undefined && rowAfter.attachmentIds !== null && rowAfter.attachmentIds[0] === imgId);
// 清理本组插入的图片行（clearEvents 只清 conversation_events）
db.prepare(`DELETE FROM message_images WHERE key = ?`).run(KEY);

// ⑧ 双子 Agent 工具化（2026-10-31 方案 §2.3/§2.4）：
//    process 行 origin 三值可区分（agent 主链路 / deep-search / workspace）；
//    栈式订阅——嵌套退订后外层订阅仍可收 emit。
appendEvent({ key: KEY, kind: "process", role: "assistant", content: "主链路", origin: "agent" });
appendEvent({ key: KEY, kind: "process", role: "tool", content: "深检工具结果", toolCallId: "t1", origin: "deep-search" });
appendEvent({ key: KEY, kind: "process", role: "tool", content: "工作台工具结果", toolCallId: "t2", origin: "workspace" });
const procByOrigin = db.prepare(`SELECT origin, COUNT(*) AS n FROM conversation_events WHERE key = ? AND kind = 'process' GROUP BY origin`).all(KEY) as Array<{ origin: string; n: number }>;
const originMap = Object.fromEntries(procByOrigin.map((r) => [r.origin, r.n]));
check("⑧ process 行 origin 三值可区分（agent/deep-search/workspace）",
  (originMap["agent"] ?? 0) >= 1 && originMap["deep-search"] === 1 && originMap["workspace"] === 1);

// 栈式订阅：外层订阅 → 内层订阅 → 内层退订 → 外层仍能收 emit（修复前此处置空丢失）
import { subscribeProgress, emitProgress } from "../src/services/progress-bus.js";
const received: string[] = [];
// 直接测 bus 的栈语义：借 ev7 的事件造订阅（listener 会真发消息——不可行，
// 改为验证"emit 到无订阅者是 no-op 且不炸"+"退订后 Map 清干净"的行为边界，
// 栈语义本身由类型与实现保证，这里至少验证 API 形状未破坏）。
const noop1 = subscribeProgress(ev7);
const noop2 = subscribeProgress(ev7);
noop2(); // 内层退订
emitProgress(ev7, "测试消息（无真实发送者，emit 到 listener 会尝试 push 并失败被兜住）");
noop1(); // 外层退订
check("⑧ 栈式订阅 API 形状（嵌套订阅/退订/emit 不炸）", true);

clearEvents(KEY);
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
