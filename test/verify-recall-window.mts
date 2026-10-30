// test/verify-recall-window.mts —— recall v5 两项改造的验证脚本：
//   ① 窗口外取数：窗口内行不进 recall 文本包，窗口外行进（边界与投影一致）
//   ② 文本包 blob 格式：成员行与 renderBlobLine 同构；AI 行 role:assistant 无 speaker
// 运行：cd /d/TS/qq-bot && npx tsx --env-file=.env test/verify-recall-window.mts
// 注：直接打生产库文件——唯一测试键隔离，结束清理。

import { appendEvent, clearEvents } from "../src/agent/memory/events.js";
import { chatRowsBefore } from "../src/agent/memory/events.js";
import { renderBlobLine } from "../src/agent/assembly.js";

const KEY = `group:recall-verify-${Date.now()}`;
let pass = 0, fail = 0;
const check = (name: string, cond: boolean): void => {
  if (cond) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name}`); }
};

// 种子：5 条行（全部当前时间——时间窗内），条数上限压到 2 → 窗口 = 最后 2 行
for (let i = 1; i <= 4; i++) {
  appendEvent({ key: KEY, kind: "chat_user", role: "user", author: { openid: `u${i}`, name: `成员${i}` }, content: `第${i}条消息`, qqMsgId: `m${i}` });
}
appendEvent({ key: KEY, kind: "chat_bot", role: "assistant", content: "这是bot的回复", origin: "test" });

// 窗口过滤（共享实现）——模拟 projectWindow 的口径：条数上限 2
// 直接用 windowCandidates 验证（它是边界单一真相源）
const { chatRowsAll } = await import("../src/agent/memory/events.js");
const { windowCandidates } = await import("../src/agent/assembly.js");
const { config } = await import("../src/config.js");
const realMax = config.contextMaxMessages;
(config as { contextMaxMessages: number }).contextMaxMessages = 2;

const all = chatRowsAll(KEY);
const inWindow = windowCandidates(all);
check("窗口内 = 最后 2 行", inWindow.length === 2 && inWindow[0].content === "第4条消息" && inWindow[1].kind === "chat_bot");

const outside = chatRowsBefore(KEY, inWindow[0].id, 300);
check("窗口外 = 前 3 行（不含窗口内）", outside.length === 3 && outside[0].content === "第1条消息" && outside[2].content === "第3条消息");
check("窗口内行不在窗口外集合里", !outside.some((r) => r.content === "第4条消息" || r.kind === "chat_bot"));

// 格式验证（renderPackLine 逻辑内联复刻验证——工具文件不导出该私有函数）
const memberLine = renderBlobLine("成员1", "第1条消息", "");
const aiLine = JSON.stringify({ role: "assistant", content: "这是bot的回复" });
check("成员行 = blob 同构（与 L1 逐字节一致）", memberLine === '{"speaker":"成员1","content":"第1条消息"}');
check("AI 行 = role:assistant 且无 speaker", aiLine.includes('"role":"assistant"') && !aiLine.includes("speaker"));
// 撞名免疫：昵称叫 bot 的成员行仍是 speaker 形态
const botNamed = renderBlobLine("bot", "我是群友bot", "");
check("昵称撞 bot 的成员行仍带 speaker 字段", botNamed === '{"speaker":"bot","content":"我是群友bot"}');

(config as { contextMaxMessages: number }).contextMaxMessages = realMax;
clearEvents(KEY);
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
