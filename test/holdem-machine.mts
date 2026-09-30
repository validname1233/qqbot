// test/holdem-machine.mts —— 机器适配层单测（脱 QQ）：伪造 MessageContext 喂
// start/step，验证指令流、passThrough、底牌 effects、非法行动提示、整局走到摊牌。
// 运行：npx tsx --env-file=.env test/holdem-machine.mts

import assert from "node:assert/strict";
import type { MessageContext } from "../src/types.js";
import { holdemMachine } from "../src/machines/holdem.js";

type GroupEvent = {
  type: "GROUP_MESSAGE_CREATE";
  content: string;
  attachments: [];
  groupOpenid: string;
  authorOpenid: string;
  authorRole: "member" | "admin" | "owner" | null;
  authorName: string;
  msgId: string;
};

function msg(openid: string, name: string, text: string): MessageContext {
  const event: GroupEvent = {
    type: "GROUP_MESSAGE_CREATE",
    content: text,
    attachments: [],
    groupOpenid: "G1",
    authorOpenid: openid,
    authorRole: null,
    authorName: name,
    msgId: "m",
  };
  return { event, text, command: text.startsWith("/") ? text.slice(1) : null, args: "" };
}

let passed = 0, failed = 0;
function t(name: string, fn: () => void): void {
  try { fn(); passed++; console.log("PASS", name); }
  catch (err) { failed++; console.log("FAIL", name, "\n  ", err instanceof Error ? err.message : err); }
}

const A = ["A", "小明"], B = ["B", "小红"], C = ["C", "小华"] as const;

// 非空收窄辅助：这些用例的转移逻辑上必非空（合法开局/合法行动）
function st(tr: { nextState: unknown }): HoldemStateT {
  if (tr.nextState === null) throw new Error("意外终局");
  return tr.nextState as HoldemStateT;
}
type HoldemStateT = NonNullable<ReturnType<typeof holdemMachine.start>["nextState"]>;

t("开局：非群场景拒绝", () => {
  // 单聊事件形状不同，直接验证 start 的分支（构造最小假事件）
  const tr = holdemMachine.start({ event: { type: "C2C_MESSAGE_CREATE", content: "/德州扑克", attachments: [], authorOpenid: "X", authorName: "X", msgId: "m" }, text: "/德州扑克", command: "德州扑克", args: "" });
  assert.equal(tr.nextState, null);
  assert.ok(tr.reply.includes("群里"));
});

t("waiting：加入/重复加入/人数播报", () => {
  const s0 = st(holdemMachine.start(msg(A[0], A[1], "/德州扑克")));
  assert.ok(s0.stage === "waiting" && s0.players.length === 1);
  const t1 = holdemMachine.step(s0, msg(B[0], B[1], "加入"));
  const s1 = st(t1);
  assert.ok(s1.players.length === 2);
  assert.ok(t1.reply.includes("开始"));
  const t2 = holdemMachine.step(s1, msg(A[0], A[1], "加入"));
  assert.equal(st(t2).players.length, 2);
  assert.ok(t2.reply.includes("已经在桌上"));
  // 入座 dm effect（可达性探测）
  assert.ok((t1.effects ?? []).some((e) => e.kind === "dm" && e.openid === B[0]));
});

t("waiting：人数不足不能开始；闲聊 passThrough", () => {
  const s0 = st(holdemMachine.start(msg(A[0], A[1], "/德州扑克")));
  const t1 = holdemMachine.step(s0, msg(A[0], A[1], "开始"));
  assert.ok(t1.reply.includes("至少"));
  const t2 = holdemMachine.step(s0, msg(C[0], C[1], "今天天气不错"));
  assert.equal(t2.passThrough, true);
});

t("开始：底牌 dm effects ×2、群播报含庄家/快照", () => {
  let s = st(holdemMachine.start(msg(A[0], A[1], "/德州扑克")));
  s = st(holdemMachine.step(s, msg(B[0], B[1], "加入")));
  const t = holdemMachine.step(s, msg(A[0], A[1], "开始"));
  const sp = st(t);
  assert.ok(sp.stage === "playing");
  const dms = (t.effects ?? []).filter((e) => e.kind === "dm");
  assert.equal(dms.length, 2);
  assert.ok(dms.every((e) => e.kind === "dm" && e.text.includes("底牌")));
  assert.ok(t.reply.includes("庄家"));
  assert.ok(t.reply.includes("行动"));
});

t("playing：非行动指令 passThrough；未轮到的人说跟注也 passThrough", () => {
  let s = st(holdemMachine.start(msg(A[0], A[1], "/德州扑克")));
  s = st(holdemMachine.step(s, msg(B[0], B[1], "加入")));
  s = st(holdemMachine.step(s, msg(A[0], A[1], "开始")));
  const chat = holdemMachine.step(s, msg(C[0], C[1], "哈哈哈哈"));
  assert.equal(chat.passThrough, true);
  // 找一个没轮到的人发跟注
  const cur = s.table!.currentIdx;
  const other = (cur + 1) % 2;
  const imposter = holdemMachine.step(s, msg(s.table!.players[other].openid, "路人", "跟注"));
  assert.equal(imposter.passThrough, true);
});

t("非法行动：回提示且状态不动", () => {
  let s = st(holdemMachine.start(msg(A[0], A[1], "/德州扑克")));
  s = st(holdemMachine.step(s, msg(B[0], B[1], "加入")));
  s = st(holdemMachine.step(s, msg(A[0], A[1], "开始")));
  const cur = s.table!.currentIdx;
  const who = s.table!.players[cur];
  const bad = holdemMachine.step(s, msg(who.openid, who.name, "加注 150"));
  assert.ok(bad.reply.includes("不合法"), bad.reply);
  assert.equal(bad.nextState, s); // 同引用：状态未变
});

t("解散：任何人任何阶段", () => {
  let s = st(holdemMachine.start(msg(A[0], A[1], "/德州扑克")));
  s = st(holdemMachine.step(s, msg(B[0], B[1], "加入")));
  s = st(holdemMachine.step(s, msg(A[0], A[1], "开始")));
  const d = holdemMachine.step(s, msg(C[0], C[1], "解散")); // 旁观者也能解散
  assert.equal(d.nextState, null);
});

t("整局冒烟：平跟到底到摊牌、结算播报完播", () => {
  let s = st(holdemMachine.start(msg(A[0], A[1], "/德州扑克")));
  s = st(holdemMachine.step(s, msg(B[0], B[1], "加入")));
  let t = holdemMachine.step(s, msg(A[0], A[1], "开始"));
  s = st(t);
  // 循环行动直到摊牌（最多 20 步防死循环）
  for (let i = 0; i < 20 && s.stage === "playing"; i++) {
    const table = s.table!;
    const who = table.players[table.currentIdx];
    if (who === undefined) break; // 无行动者（全下 run-out 中间态）
    // 全员只会 check/call 的傻瓜策略
    const need = table.currentBet - who.betThisRound;
    const act = need > 0 ? "跟注" : "过牌";
    t = holdemMachine.step(s, msg(who.openid, who.name, act));
    if (t.nextState === null) break; // 摊牌终局
    s = t.nextState;
  }
  // 走到 null（终局播报）或 needAct 空的 run-out 态——断言终局
  // run-out 中间态：step "状态" 不改变状态；真正断言是 loop 结束后 s 为 null
  // （playing 中每次行动都会推进；连 check 也推进 needAct）
  assert.ok(t.nextState === null, "20 步内应到摊牌终局");
  assert.ok(t.reply.includes("摊牌") || t.reply.includes("showdown"), t.reply.slice(0, 80));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
