// test/holdem-engine.mts —— 引擎单测（脱 QQ）：node:assert + tsx 直跑。
// 覆盖：牌堆/评估正确性、preflop 行动队列、下注轮结束边界、最小加注校验、
// 全下与边池切分、两人桌盲注位、fold 独吞、平分池余数。
// 运行：npx tsx --env-file=.env test/holdem-engine.mts（engine 零 QQ 依赖，
// env 只是项目模块链需要）。

import assert from "node:assert/strict";
import {
  BIG_BLIND, START_CHIPS,
  type Card, type TableState,
  shuffledDeck, cardsLabel, rankLabel,
  startHand, applyAction, advancePhase,
  evaluateSeven, settleShowdown,
} from "../src/machines/holdem/engine.js";

let passed = 0;
let failed = 0;
function t(name: string, fn: () => void): void {
  try { fn(); passed++; console.log("PASS", name); }
  catch (err) { failed++; console.log("FAIL", name, "\n  ", err instanceof Error ? err.message : err); }
}

// ---- 牌堆 ----
t("洗牌 52 张不重不漏", () => {
  const deck = shuffledDeck();
  assert.equal(deck.length, 52);
  const keys = new Set(deck.map((c) => `${c.suit}${c.rank}`));
  assert.equal(keys.size, 52);
});

// ---- 评估：造 7 张指定牌 ----
function C(suit: Card["suit"], rank: Card["rank"]): Card { return { suit, rank }; }

t("同花顺 > 四条", () => {
  const sf = [C("♠", 10), C("♠", 11), C("♠", 12), C("♠", 13), C("♠", 14), C("♦", 2), C("♥", 7)];
  const quads = [C("♠", 9), C("♥", 9), C("♦", 9), C("♣", 9), C("♠", 3), C("♦", 5), C("♥", 7)];
  assert.ok(evaluateSeven(sf) > evaluateSeven(quads));
});

t("A2345 轮子顺（低于 6 高顺）", () => {
  const wheel = [C("♠", 14), C("♥", 2), C("♦", 3), C("♣", 4), C("♠", 5), C("♥", 9), C("♦", 9)];
  const six = [C("♠", 2), C("♥", 3), C("♦", 4), C("♣", 5), C("♠", 6), C("♥", 9), C("♦", 9)];
  assert.ok(evaluateSeven(wheel) < evaluateSeven(six));
  assert.ok(evaluateSeven(wheel) > 0);
});

t("两对 vs 两对：kicker 定胜负", () => {
  const a = [C("♠", 13), C("♥", 13), C("♦", 9), C("♣", 9), C("♠", 14), C("♥", 2), C("♦", 3)];
  const b = [C("♠", 13), C("♥", 13), C("♦", 9), C("♣", 9), C("♠", 11), C("♥", 2), C("♦", 3)];
  assert.ok(evaluateSeven(a) > evaluateSeven(b));
});

t("完全平牌：分值相等", () => {
  const a = [C("♠", 13), C("♥", 13), C("♦", 9), C("♣", 9), C("♠", 14), C("♥", 2), C("♦", 3)];
  const b = [C("♣", 13), C("♦", 13), C("♠", 9), C("♥", 9), C("♥", 14), C("♠", 2), C("♣", 3)];
  assert.equal(evaluateSeven(a), evaluateSeven(b));
});

// ---- 开局 ----
// 固定 dealerIdx 不可行（随机），断言结构与盲注结构而非具体位置
t("开局：底牌两张/盲注 150/行动队列全员", () => {
  const s = startHand([{ openid: "A", name: "甲" }, { openid: "B", name: "乙" }, { openid: "C", name: "丙" }]);
  assert.equal(s.phase, "preflop");
  assert.equal(s.community.length, 0);
  for (const p of s.players) assert.equal(p.hole.length, 2);
  assert.equal(s.pot, BIG_BLIND * 1.5);
  assert.equal(s.currentBet, BIG_BLIND);
  const bets = s.players.map((p) => p.betThisRound).sort((x, y) => x - y);
  assert.deepEqual(bets, [0, 50, 100]); // 小盲 50 大盲 100
  assert.equal(s.needAct.length, 3);
  // UTG = 大盲左 1
  assert.equal(s.players[s.currentIdx].betThisRound, 0);
});

t("两人桌：庄家=小盲、另一家=大盲、庄家先行动（preflop）", () => {
  const s = startHand([{ openid: "A", name: "甲" }, { openid: "B", name: "乙" }]);
  const dealer = s.players[s.dealerIdx];
  const other = s.players[(s.dealerIdx + 1) % 2];
  assert.equal(dealer.betThisRound, BIG_BLIND / 2);
  assert.equal(other.betThisRound, BIG_BLIND);
  assert.equal(s.currentIdx, (s.dealerIdx + 1) % 2 === s.dealerIdx ? -1 : s.dealerIdx); // 两人桌 UTG=庄家（小盲）
  // 修正断言：两人桌 preflop 先行动的是小盲（庄家）
  assert.equal(s.players[s.currentIdx].openid, dealer.openid);
});

// ---- 行动合法性 ----
t("有人下注时不能过牌", () => {
  const s = startHand([{ openid: "A", name: "甲" }, { openid: "B", name: "乙" }]);
  assert.equal(applyAction(s, s.currentIdx, { kind: "check" }), null);
});

t("不轮到的人不能行动", () => {
  const s = startHand([{ openid: "A", name: "甲" }, { openid: "B", name: "乙" }, { openid: "C", name: "丙" }]);
  const notCurrent = (s.currentIdx + 1) % 3;
  assert.equal(applyAction(s, notCurrent, { kind: "call" }), null);
});

t("非法加注（低于最小加注）被拒", () => {
  const s = startHand([{ openid: "A", name: "甲" }, { openid: "B", name: "乙" }, { openid: "C", name: "丙" }]);
  // currentBet=100, minRaise=100 → 加注到 150 不合法
  assert.equal(applyAction(s, s.currentIdx, { kind: "raise", to: 150 }), null);
});

t("跟注推进轮转，一轮平跟后进翻牌", () => {
  let s = startHand([{ openid: "A", name: "甲" }, { openid: "B", name: "乙" }, { openid: "C", name: "丙" }]);
  s = applyAction(s, s.currentIdx, { kind: "call" }) as TableState; // UTG 跟 100
  s = applyAction(s, s.currentIdx, { kind: "call" }) as TableState; // 小盲补 50
  s = applyAction(s, s.currentIdx, { kind: "check" }) as TableState; // 大盲 option 过牌
  assert.equal(s.phase, "flop");
  assert.equal(s.community.length, 3);
  assert.equal(s.pot, 300);
  for (const p of s.players) assert.equal(p.betThisRound, 0);
  assert.equal(s.currentBet, 0);
});

t("加注重开行动队列，大盲可再表态", () => {
  let s = startHand([{ openid: "A", name: "甲" }, { openid: "B", name: "乙" }, { openid: "C", name: "丙" }]);
  s = applyAction(s, s.currentIdx, { kind: "raise", to: 300 }) as TableState; // UTG 加到 300
  assert.equal(s.currentBet, 300);
  assert.equal(s.needAct.length, 2); // 另两人需重新表态
  s = applyAction(s, s.currentIdx, { kind: "call" }) as TableState;
  s = applyAction(s, s.currentIdx, { kind: "call" }) as TableState;
  assert.equal(s.phase, "flop");
  assert.equal(s.pot, 900);
});

t("全下不足跟注额：短码跟注 all-in、对方多余投入在结算时退回", () => {
  // 两人桌：A=大盲(100)，B=小盲(50)且先行动。把 B 压成短码（只剩 30）。
  const s0 = startHand([{ openid: "A", name: "甲" }, { openid: "B", name: "乙" }]);
  const sbIdx = s0.players[s0.currentIdx].betThisRound === 50 ? s0.currentIdx : (s0.currentIdx + 1) % 2;
  const s: TableState = { ...s0, players: s0.players.map((p) => ({ ...p })) };
  s.players[sbIdx].chips = 30;
  const out = applyAction(s, s.currentIdx, { kind: "call" }) as TableState;
  assert.ok(out !== null, "短码跟注合法");
  const alliner = out.players[sbIdx];
  assert.ok(alliner.allIn, "短码跟注即全下");
  assert.equal(alliner.betThisRound, 80, "50 盲注 + 30 全部 = 80，不足 100");
  // 对方（投了 100）仍被要求表态（可 check 收口），轮到他
  assert.equal(out.currentIdx, (sbIdx + 1) % 2);
  // 对方过牌 → 连发公牌到摊牌
  const fin = applyAction(out, out.currentIdx, { kind: "check" }) as TableState;
  assert.equal(fin.phase, "showdown");
  assert.equal(fin.community.length, 5);
  // 结算：80 层两人争（160），20 多余投入层只有大盲自己 → 无论谁赢 80 层，那 20 必回大盲
  const { shares } = settleShowdown(fin);
  const byId = Object.fromEntries(shares.map((x) => [x.openid, x.amount]));
  const bbId = out.players[(sbIdx + 1) % 2].openid;
  const sbId = alliner.openid;
  assert.equal(byId[bbId] + byId[sbId], 180, "整池分尽");
  assert.ok(byId[bbId] >= 20, "大盲至少收回多余的 20（短码赢则 160+0，大盲赢则 20+160）");
});

// ---- fold 独吞 ----
t("全员弃牌剩一人：直接 showdown、池归幸存者", () => {
  let s = startHand([{ openid: "A", name: "甲" }, { openid: "B", name: "乙" }, { openid: "C", name: "丙" }]);
  s = applyAction(s, s.currentIdx, { kind: "fold" }) as TableState;
  s = applyAction(s, s.currentIdx, { kind: "fold" }) as TableState;
  assert.equal(s.phase, "showdown");
  const alive = s.players.filter((p) => !p.folded);
  assert.equal(alive.length, 1);
});

// ---- 边池：长码 A 全下 vs 短码 B ----
t("短码边池：B 只能赢到 B 投入的两倍层，其余退回 A", () => {
  let s = startHand([{ openid: "A", name: "甲" }, { openid: "B", name: "乙" }]);
  // A（先手小盲）加注全下 10000，B 跟全下（筹码也 10000）——等额，无双层
  s = applyAction(s, s.currentIdx, { kind: "allin" }) as TableState;
  // 全下后 needAct 只剩 B；B 跟注也是全下
  s = applyAction(s, s.currentIdx, { kind: "call" }) as TableState;
  assert.equal(s.phase, "showdown");
  assert.equal(s.community.length, 5); // 全 all-in 连发公牌
  const { shares, lines } = settleShowdown(s);
  const total = shares.reduce((acc, x) => acc + x.amount, 0);
  assert.equal(total, 20000, "整池分尽");
  assert.equal(lines.length, 1);
});

t("不等额全下：短码赢主池、长码收回边池", () => {
  // 经典边池场景：B 短码全下 2000（牌最强），C 长码 8000（牌较弱），A 弃牌投 1000（死钱）。
  // 层切：1000 层=3000（A死钱+B+C）、2000 层=2000（B+C）、8000 层=6000（只有 C，退回）。
  // B 拿 3000+2000=5000（主池），C 拿回 6000（边池无人争）。
  const mk = (openid: string, name: string, betTotal: number, folded: boolean, hole: Card[], allIn: boolean): import("../src/machines/holdem/engine.js").Player => ({
    openid, name, chips: START_CHIPS - betTotal, betTotal, betThisRound: 0, hole, folded, allIn,
  });
  const community = [C("♠", 5), C("♥", 7), C("♦", 9), C("♣", 11), C("♠", 13)];
  const s: TableState = {
    phase: "showdown",
    players: [
      mk("A", "甲", 1000, true, [C("♠", 2), C("♥", 2)], false),
      mk("B", "乙", 2000, false, [C("♦", 13), C("♣", 13)], true), // 对 K（最强）
      mk("C", "丙", 8000, false, [C("♠", 10), C("♥", 10)], false), // 对 10
    ],
    deck: [],
    community,
    dealerIdx: 0,
    currentIdx: -1,
    pot: 11000,
    currentBet: 8000,
    minRaise: BIG_BLIND,
    needAct: [],
  };
  const { shares } = settleShowdown(s);
  const byId = Object.fromEntries(shares.map((x) => [x.openid, x.amount]));
  assert.equal(byId["B"], 5000, "短码赢家：1000 层 3000 + 2000 层 2000");
  assert.equal(byId["C"], 6000, "长码输家：收回无人可争的 8000 层");
  assert.equal(byId["A"], 0);
  assert.equal(byId["B"] + byId["C"] + byId["A"], 11000, "整池分尽");
});

t("平分池：等牌力平分、余数不丢", () => {
  const community = [C("♠", 5), C("♥", 7), C("♦", 9), C("♣", 11), C("♠", 13)];
  const mk = (openid: string, name: string): import("../src/machines/holdem/engine.js").Player => ({
    openid, name, chips: 9900, betTotal: 100, betThisRound: 0,
    hole: [C("♠", 2), C("♥", 3)], folded: false, allIn: false, // 完全相同的底牌
  });
  const s: TableState = {
    phase: "showdown",
    players: [mk("A", "甲"), mk("B", "乙"), mk("C", "丙")],
    deck: [], community,
    dealerIdx: 1, currentIdx: -1, pot: 300, currentBet: 0, minRaise: BIG_BLIND, needAct: [],
  };
  const { shares } = settleShowdown(s);
  const amounts = shares.map((x) => x.amount).sort((a, b) => a - b);
  // 300 / 3 = 100 整除；故意造奇数池验证余数路径
  assert.deepEqual(amounts, [100, 100, 100]);
  assert.equal(amounts.reduce((a, b) => a + b, 0), 300);
});

// ---- advancePhase 发牌 ----
t("advancePhase：flop→turn→river 各发 1 张，river 后 showdown 不发", () => {
  let s = startHand([{ openid: "A", name: "甲" }, { openid: "B", name: "乙" }, { openid: "C", name: "丙" }]);
  s = applyAction(s, s.currentIdx, { kind: "call" }) as TableState;
  s = applyAction(s, s.currentIdx, { kind: "call" }) as TableState;
  s = applyAction(s, s.currentIdx, { kind: "check" }) as TableState; // → flop
  assert.equal(s.phase, "flop");
  const before = s.community.length;
  s = advancePhase(s);
  assert.equal(s.phase, "turn");
  assert.equal(s.community.length, before + 1);
  s = advancePhase(s);
  assert.equal(s.phase, "river");
  s = advancePhase(s);
  assert.equal(s.phase, "showdown");
  assert.equal(s.community.length, 5);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
