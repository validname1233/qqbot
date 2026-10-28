// test/context-rebuild-smoke.mts —— 记忆重构一期冒烟测试。
// 验证（总方案实施顺序第 4 步）：
//   ① 入站收口：一条事件恰好一行 chat_user；QQ 重推（同 msgId）只落一行
//   ② blob 投影：批仅含 user 行、chat_bot 裸 assistant 隔断、排除当前消息行
//   ③ reset：预算超限追加 reset 行，投影清空
//   ④ 就地 process：llmCall/toolsNode 的行落库（以直接调 appendEvent 模拟形状）
// 运行：cd /d/TS/qq-bot && npx tsx test/context-rebuild-smoke.mts
// 注：直接打生产库文件（data/memory.sqlite）——用唯一测试键隔离，结束清理。

import { appendEvent, clearEvents, chatRowsAfterReset, chatRows, latestResetId } from "../src/agent/memory/events.js";
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
check("② 投影 2 条消息（1 批 + 1 裸 assistant）", proj.messages.length === 2);
check("② 首条是 user 批（blob）", proj.messages[0]?.role === "user" && proj.messages[0].content.includes('"speaker":"小明"'));
check("② 批内含两行（m1+m2，m3 已排除）", (proj.messages[0]?.content.match(/\n/g) ?? []).length === 1);
check("② 次条是裸 assistant", proj.messages[1]?.role === "assistant" && proj.messages[1].content === "还没呢，刚准备去");

// ③ reset：把预算临时压到极小，投影应触发 reset 并清空
const realBudget = config.contextTokenBudget;
(config as { contextTokenBudget: number }).contextTokenBudget = 1;
const projReset = await projectWindow(ctx);
(config as { contextTokenBudget: number }).contextTokenBudget = realBudget;
check("③ 超预算触发 reset 行", latestResetId(KEY) > 0);
check("③ reset 后投影为空", projReset.messages.length === 0 && projReset.estimatedTokens === 0);
const after = chatRowsAfterReset(KEY);
check("③ reset 之后的 chat 行为空", after.rows.length === 0);

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
check("④ process 不进 L1 投影", chatRowsAfterReset(KEY).rows.every((r) => r.kind !== "process"));

// ⑤ 估算函数合理性
const zh = estimateTokens("今天天气不错".repeat(10));
const en = estimateTokens("hello world ".repeat(10));
check(`⑤ 估算（中文${zh}/英文${en} tokens，均 >0 且量级合理）`, zh > 0 && en > 0 && zh > en);

clearEvents(KEY);
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
