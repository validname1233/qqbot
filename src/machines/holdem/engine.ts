// machines/holdem/engine.ts —— 德州扑克牌局引擎：纯函数、零 QQ 依赖。
// 方案：docs/features/2026-09-30-德州扑克实现方案.md §2.2。
// 这里只懂牌：洗牌、下注轮推进、边池切分、牌力评估。指令解析、播报拼接、
// openid/messageContext 一概不认识——因此可以脱离 QQ 单测（test/holdem-engine.mts）。
//
// 引擎不抛业务异常：非法行动一律返回 null 由调用方（机器适配层）回提示。
// 状态一律「拷贝后改」再返回新对象（reducer 风格），不原地修改入参——
// 转移失败时旧状态可安全复用（step 返回原 state 即"这步没走"）。

// ---------- 牌 ----------

export type Suit = "♠" | "♥" | "♦" | "♣";
export type Rank = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14; // 14=A

export interface Card {
  suit: Suit;
  rank: Rank;
}

export const SUITS: readonly Suit[] = ["♠", "♥", "♦", "♣"];
export const RANKS: readonly Rank[] = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];

// 2~A、J=11 Q=12 K=13 A=14（A 在 2345 顺子里当 1，见 evaluateHand）。
export function rankLabel(rank: Rank): string {
  if (rank === 14) return "A";
  if (rank === 13) return "K";
  if (rank === 12) return "Q";
  if (rank === 11) return "J";
  return String(rank);
}

export function cardLabel(card: Card): string {
  return `${card.suit}${rankLabel(card.rank)}`;
}

export function cardsLabel(cards: readonly Card[]): string {
  return cards.map(cardLabel).join(" ");
}

// 52 张洗好的牌堆（Fisher-Yates）。Math.random 与 guess.ts 的谜底同款先例。
export function shuffledDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ suit, rank });
    }
  }
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// ---------- 玩家与桌面状态 ----------

export interface Player {
  openid: string;
  name: string;
  chips: number; // 剩余筹码（局内）
  betTotal: number; // 本局累计投入（边池按它切）
  betThisRound: number; // 本下注轮已投入
  hole: Card[]; // 底牌两张（发牌前为空）
  folded: boolean;
  allIn: boolean;
}

export type Phase = "preflop" | "flop" | "turn" | "river" | "showdown";

export interface TableState {
  phase: Phase;
  players: Player[];
  deck: Card[]; // 发牌机（从尾pop）
  community: Card[]; // 公牌
  dealerIdx: number; // 庄家位
  currentIdx: number; // 轮到谁（未被 fold/allIn 跳过）
  pot: number; // 当前池（= 各玩家 betTotal 之和，摊牌切池以此为准）
  currentBet: number; // 本轮最高投入（跟注目标）
  minRaise: number; // 最小加注增量（上次加注量，盲注起算）
  needAct: number[]; // 本轮还需行动的玩家下标（已跟平/未行动者）
}

// ---------- 行动 ----------

export type Action =
  | { kind: "fold" }
  | { kind: "check" } // 过牌（仅无人下注时合法）
  | { kind: "call" } // 跟注（补齐到 currentBet，不足则 all-in）
  | { kind: "raise"; to: number } // 加注到 to（本轮总投入目标，>= currentBet+minRaise；超出筹码即全下）
  | { kind: "allin" };

// 下一步轮到谁：从 from+1 起找第一个未弃牌未全下的玩家。
function nextToAct(state: TableState, from: number): number {
  const n = state.players.length;
  for (let step = 1; step <= n; step++) {
    const idx = (from + step) % n;
    const p = state.players[idx];
    if (!p.folded && !p.allIn) return idx;
  }
  return -1; // 无人可行动（全员弃牌/全下）
}

// 下注轮是否结束：needAct 清空即结束。
function roundDone(state: TableState): boolean {
  return state.needAct.length === 0;
}

// 进入下一个阶段（翻牌/转牌/河牌/摊牌）。发牌、清本轮投入、重置行动队列。
export function advancePhase(state: TableState): TableState {
  const s = cloneState(state);
  // 本轮投入已在行动时计入 betTotal，这里只清轮内字段
  for (const p of s.players) p.betThisRound = 0;
  s.currentBet = 0;
  s.minRaise = BIG_BLIND;

  const cardsToDeal: Record<Phase, number> = { preflop: 3, flop: 1, turn: 1, river: 0, showdown: 0 };
  const take = cardsToDeal[s.phase];
  for (let i = 0; i < take; i++) s.community.push(s.deck.pop() as Card);

  s.phase = s.phase === "preflop" ? "flop" : s.phase === "flop" ? "turn" : s.phase === "turn" ? "river" : "showdown";

  if (s.phase === "showdown") return s; // 摊牌不再建行动队列

  // 只剩 0 或 1 个可行动玩家：没有对抗性下注轮了（对手已 all-in），后续街
  // 全部 run-out 到摊牌——单人"行动"没有意义（无人可对他下注，只能干看）。
  // 队列留空，finishAction 的推进循环（needAct 空 → 继续 advancePhase）会连发公牌。
  const actionable = s.players.filter((p) => !p.folded && !p.allIn);
  if (actionable.length <= 1) {
    s.needAct = [];
    s.currentIdx = -1;
    return s;
  }
  const first = nextToAct(s, s.dealerIdx);
  s.currentIdx = first;
  s.needAct = actionablePlayers(s, first);
  return s;
}

// 从 first 起（含）绕一圈收所有可行动玩家；也用于 preflop 初始化。
function actionablePlayers(s: TableState, first: number): number[] {
  const n = s.players.length;
  const list: number[] = [];
  for (let step = 0; step < n; step++) {
    const idx = (first + step) % n;
    const p = s.players[idx];
    if (!p.folded && !p.allIn) list.push(idx);
  }
  return list;
}

// 深拷贝（deck/hole/community 里的 Card 是值对象，浅拷即可，拷一层引用防改动）。
function cloneState(s: TableState): TableState {
  return {
    ...s,
    players: s.players.map((p) => ({ ...p, hole: [...p.hole] })),
    deck: [...s.deck],
    community: [...s.community],
    needAct: [...s.needAct],
  };
}

// ---------- 开局 ----------

export const BIG_BLIND = 100;
export const START_CHIPS = 10000;
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 8;

// 从 waiting 的玩家名单开局：洗牌、发底牌、扣盲注、建 preflop 行动队列。
// 庄家随机；小盲=庄家左1（两人桌特殊：庄家自己是小盲，先行动）。
export function startHand(players: Array<{ openid: string; name: string }>): TableState {
  const deck = shuffledDeck();
  const ps: Player[] = players.map((p) => ({
    ...p,
    chips: START_CHIPS,
    betTotal: 0,
    betThisRound: 0,
    hole: [deck.pop() as Card, deck.pop() as Card],
    folded: false,
    allIn: false,
  }));
  const n = ps.length;
  const dealerIdx = Math.floor(Math.random() * n);
  const sbIdx = n === 2 ? dealerIdx : (dealerIdx + 1) % n; // 两人桌按钮位=小盲
  const bbIdx = (dealerIdx + (n === 2 ? 1 : 2)) % n;

  postBlind(ps, sbIdx, BIG_BLIND / 2);
  postBlind(ps, bbIdx, BIG_BLIND);

  // preflop 从大盲左侧（UTG）起行动；所有人（含盲注位）都在行动队列——
  // 盲注只是垫底投入，轮到时仍可选择加注/弃牌；无人加注时大盲可 check（option）。
  const first = (bbIdx + 1) % n;
  const seeded: TableState = {
    phase: "preflop",
    players: ps,
    deck,
    community: [],
    dealerIdx,
    currentIdx: first,
    pot: BIG_BLIND * 1.5,
    currentBet: BIG_BLIND,
    minRaise: BIG_BLIND,
    needAct: [],
  };
  seeded.needAct = actionablePlayers(seeded, first);
  return seeded;
}

function postBlind(ps: Player[], idx: number, amount: number): void {
  const p = ps[idx];
  const take = Math.min(amount, p.chips); // 筹码不足盲注 = 全下
  p.chips -= take;
  p.betThisRound = take;
  p.betTotal = take;
  if (p.chips === 0) p.allIn = true;
}

// ---------- 执行一次行动 ----------
// 返回 null = 非法行动（状态未被消费，调用方回提示）。合法则返回新状态。
// 下注轮结束后自动进入下一阶段（含连发公牌到摊牌的全 all-in 场景）。
export function applyAction(state: TableState, playerIdx: number, action: Action): TableState | null {
  const actor = state.players[playerIdx];
  if (actor === undefined || playerIdx !== state.currentIdx || actor.folded || actor.allIn) {
    return null;
  }

  const s = cloneState(state);

  // 校验并算出本次投入
  let invest = 0;
  if (action.kind === "check") {
    if (s.currentBet !== actor.betThisRound) return null; // 有人下注时不能过牌
  } else if (action.kind === "fold") {
    s.players[playerIdx].folded = true;
    return finishAction(s, playerIdx);
  } else if (action.kind === "call") {
    invest = Math.min(s.currentBet - actor.betThisRound, actor.chips); // 不足则全下
  } else if (action.kind === "raise") {
    const target = Math.min(action.to, actor.betThisRound + actor.chips); // 超筹码封顶为全下
    if (target < s.currentBet + s.minRaise && target < actor.betThisRound + actor.chips) {
      return null; // 不满足最小加注，且不是全下
    }
    invest = target - actor.betThisRound;
    if (invest <= 0) return null;
  } else {
    invest = actor.chips; // allin
  }

  const p = s.players[playerIdx];
  p.chips -= invest;
  p.betThisRound += invest;
  p.betTotal += invest;
  s.pot += invest;
  if (p.chips === 0) p.allIn = true;

  // 加注（含全下超过当前注）抬高注线和最小加注量，并重开行动队列
  if (p.betThisRound > s.currentBet) {
    const raiseSize = p.betThisRound - s.currentBet;
    s.minRaise = Math.max(s.minRaise, raiseSize);
    s.currentBet = p.betThisRound;
    // 其它未弃牌未全下者都要重新表态（行动者自己除外）
    s.needAct = actionablePlayers(s, s.currentIdx).filter((i) => i !== playerIdx);
  } else if (action.kind === "call" || action.kind === "check") {
    s.needAct = s.needAct.filter((i) => i !== playerIdx);
  } else {
    s.needAct = s.needAct.filter((i) => i !== playerIdx); // 全下但未超注线：出队
  }

  return finishAction(s, playerIdx);
}

// 行动落地后的公共收尾：本轮结束则进下一阶段；只剩一人则直接摊牌。
function finishAction(s: TableState, actorIdx: number): TableState {
  // 只剩一名未弃牌者：整池归他，阶段终结（不用比牌）
  const alive = s.players.filter((p) => !p.folded);
  if (alive.length === 1) {
    s.phase = "showdown";
    return s;
  }

  if (roundDone(s)) {
    // 本轮收口。注意"无人还需行动"≠"全员 all-in"：短码全下被平跟后，长码玩家
    // 有筹码但已投到注线、needAct 已清空——他不该再被要求行动，直接连发公牌
    // 到摊牌。advancePhase 建队后若 needAct 仍空（无人可行动）即属此景，继续推进。
    let t = advancePhase(s);
    while (t.phase !== "showdown" && t.needAct.length === 0) {
      t = advancePhase(t);
    }
    return t;
  }

  // 轮到下一个还需行动的人
  const next = nextToAct(s, actorIdx);
  if (next === -1) {
    return advancePhase(s);
  }
  s.currentIdx = next;
  return s;
}

// ---------- 牌力评估（7 选 5） ----------

// 五张牌 → 可比较分值：类别码 << 20 | kicker 们按位打包。
// 类别：8=同花顺 7=四条 6=葫芦 5=同花 4=顺子 3=三条 2=两对 1=一对 0=高牌。
function scoreFive(cards: Card[]): number {
  const ranks = cards.map((c) => c.rank).sort((a, b) => b - a); // 大→小
  const flush = cards.every((c) => c.suit === cards[0].suit);

  // 顺子判定（含 A2345 = 5 高顺）：ranks 去重后连续，或恰为 14,5,4,3,2
  let straightHigh = 0;
  const uniq = [...new Set(ranks)];
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) straightHigh = uniq[0];
    else if (uniq[0] === 14 && uniq[1] === 5 && uniq[1] - uniq[4] === 3) straightHigh = 5; // wheel
  }

  // 点数分组：rank → 张数，再按（张数, rank）排
  const groups = new Map<number, number>();
  for (const r of ranks) groups.set(r, (groups.get(r) ?? 0) + 1);
  const ordered = [...groups.entries()].sort((a, b) => (b[1] - a[1]) || (b[0] - a[0]));

  const pack = (cat: number, kickers: number[]): number =>
    kickers.slice(0, 5).reduce((acc, r, i) => acc | (r << (16 - i * 4)), cat << 20);

  if (flush && straightHigh !== 0) return pack(8, [straightHigh]);
  if (ordered[0][1] === 4) return pack(7, [ordered[0][0], ordered[1][0]]);
  if (ordered[0][1] === 3 && ordered[1][1] === 2) return pack(6, [ordered[0][0], ordered[1][0]]);
  if (flush) return pack(5, ranks);
  if (straightHigh !== 0) return pack(4, [straightHigh]);
  if (ordered[0][1] === 3) return pack(3, [ordered[0][0], ordered[1][0], ordered[2][0]]);
  if (ordered[0][1] === 2 && ordered[1][1] === 2) return pack(2, [ordered[0][0], ordered[1][0], ordered[2][0]]);
  if (ordered[0][1] === 2) return pack(1, [ordered[0][0], ordered[1][0], ordered[2][0], ordered[3][0]]);
  return pack(0, ranks);
}

// 7 张（底牌 2 + 公牌 5）选最强 5 张。C(7,5)=21 种组合枚举。
export function evaluateSeven(cards: Card[]): number {
  let best = -1;
  for (let a = 0; a < 7; a++) {
    for (let b = a + 1; b < 7; b++) {
      // 跳过 a、b 两张，取其余 5 张
      const five = cards.filter((_, i) => i !== a && i !== b);
      const score = scoreFive(five);
      if (score > best) best = score;
    }
  }
  return best;
}

// 牌型大类名（scoreFive 的类别码 → 中文名）。摊牌播报用：只报大类（"四条""一对"），
// 不展开具体牌面/kicker——类别码就在分值高位（cat << 20），右移取出查表即可，
// 无需重算任何东西。
const CATEGORY_LABELS = ["高牌", "一对", "两对", "三条", "顺子", "同花", "葫芦", "四条", "同花顺"] as const;

export function handCategoryLabel(score: number): string {
  return CATEGORY_LABELS[score >> 20] ?? "高牌";
}

// ---------- 摊牌结算（边池） ----------

export interface PotShare {
  openid: string;
  amount: number; // 赢得的筹码（含本金返还语义：负者为 0）
}

// 按标准边池规则切池：按各玩家 betTotal 升序切层，每层由投入 ≥ 该层的
// 未弃牌玩家中牌力最高者（可并列）平分；余数筹码给最靠近庄家左侧的赢家。
// 返回各玩家赢额 + 每层的描述行（机器层拼播报用）。
export function settleShowdown(state: TableState): { shares: PotShare[]; lines: string[] } {
  const s = state;
  const inHand = s.players.filter((p) => !p.folded);
  const shares = new Map<string, number>(s.players.map((p) => [p.openid, 0]));
  const lines: string[] = [];

  // 切层：all-in 者的 betTotal 是天然层界
  const levels = [...new Set(s.players.filter((p) => p.betTotal > 0).map((p) => p.betTotal))].sort((a, b) => a - b);
  let prev = 0;
  for (const level of levels) {
    // 本层总额：每个投入超过 prev 的玩家贡献 min(level, betTotal) - prev
    let potLevel = 0;
    for (const p of s.players) {
      potLevel += Math.max(0, Math.min(p.betTotal, level) - prev);
    }
    prev = level;
    if (potLevel === 0) continue;

    // 有资格争本层的：投入 ≥ level 且未弃牌
    const eligible = inHand.filter((p) => p.betTotal >= level);
    if (eligible.length === 0) continue; // 弃牌者独吞层（下层再分）

    let bestScore = -1;
    for (const p of eligible) {
      const score = evaluateSeven([...p.hole, ...s.community]);
      if (score > bestScore) bestScore = score;
    }
    const winners = eligible.filter((p) => evaluateSeven([...p.hole, ...s.community]) === bestScore);
    const base = Math.floor(potLevel / winners.length);
    let remainder = potLevel - base * winners.length;
    // 余数：从庄家左侧起第一个赢家
    const ordered = [...s.players].map((_, i) => s.players[(s.dealerIdx + 1 + i) % s.players.length]);
    for (const w of ordered) {
      if (remainder === 0) break;
      if (winners.includes(w)) {
        shares.set(w.openid, (shares.get(w.openid) ?? 0) + 1);
        remainder -= 1;
      }
    }
    for (const w of winners) {
      shares.set(w.openid, (shares.get(w.openid) ?? 0) + base);
    }
    lines.push(
      `${potLevel} 筹码层：${winners.map((w) => w.name).join("、")} 平分（各 ${base}${remainder > 0 ? "，余数已给庄家左侧赢家" : ""}）`,
    );
  }
  return { shares: s.players.map((p) => ({ openid: p.openid, amount: shares.get(p.openid) ?? 0 })), lines };
}

// 只剩一人时的整池归属（无需比牌）。
export function settleFoldWin(state: TableState, winnerIdx: number): number {
  return state.pot;
}
