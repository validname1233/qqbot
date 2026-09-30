// machines/holdem.ts —— 德州扑克状态机（机器适配层）。
// 职责：把群消息翻译成引擎调用、把引擎状态拼成播报、把秘密信息（底牌）声明成
// dm effects。规则计算全在 holdem/engine.ts（纯函数、零 QQ 依赖、已单测覆盖），
// 这里不出现任何牌规则——只有"谁说了什么指令 → 调引擎哪个函数 → 拼什么话"。
//
// 指令集（v1 精确匹配，不做自然语言——状态机保持确定性，语义理解是 Agent 的事）：
//   /德州扑克        开桌（waiting）
//   加入 | 退出      waiting 阶段入座/离座（退出仅 waiting）
//   开始            waiting → 发牌进 preflop（≤8 人，≥2 人）
//   过牌 | 跟注 | 弃牌 | 加注 <数> | 全下    行动（仅轮到的人）
//   解散            任何人任何时候：整局作废（用户决策：所有人都可以）
//   状态            查看当前桌面（轮到谁/公牌/池/各人筹码）
// 非指令、或指令但说话人不对 → passThrough（闲聊放行，不吐槽）。
//
// 双通道（方案 §1.2）：公牌/播报走群（reply），底牌走 dm effects（openid 直推，
// 依据已验证事实：member_openid === user_openid 且主动推送可达）。

import type { MessageContext } from "../types.js";
import type { StateMachine, Transition, Effect } from "./types.js";
import type { Action, TableState } from "./holdem/engine.js";
import {
  BIG_BLIND, START_CHIPS, MIN_PLAYERS, MAX_PLAYERS,
  startHand, applyAction, settleShowdown, evaluateSeven, handCategoryLabel,
  cardsLabel, cardLabel,
} from "./holdem/engine.js";

// 机器状态：waiting 阶段还没进引擎（引擎只认开始后的牌局）。
interface HoldemState {
  stage: "waiting" | "playing";
  groupOpenid: string; // 开桌的群（播报 effect 用）
  players: Array<{ openid: string; name: string }>; // waiting 期的座位表
  table: TableState | null; // playing 期的引擎状态
}

// 行动指令解析："跟注"→call 等；非行动指令返回 null。
function parseAction(text: string): Action | null {
  if (text === "过牌" || text === "过") return { kind: "check" };
  if (text === "跟注" || text === "跟") return { kind: "call" };
  if (text === "弃牌" || text === "弃") return { kind: "fold" };
  if (text === "全下" || text === "梭哈") return { kind: "allin" };
  const raise = /^(?:加注|加到)\s*(\d+)$/.exec(text);
  if (raise !== null) return { kind: "raise", to: Number(raise[1]) };
  return null;
}

// 拼桌面快照（"状态"指令和每轮播报共用）。
function tableSnapshot(s: TableState): string {
  const phaseName = { preflop: "翻牌前", flop: "翻牌圈", turn: "转牌圈", river: "河牌圈", showdown: "摊牌" }[s.phase];
  const lines = [
    `【${phaseName}】池 ${s.pot} | 注线 ${s.currentBet} | 公牌 ${s.community.length > 0 ? cardsLabel(s.community) : "—"}`,
  ];
  for (let i = 0; i < s.players.length; i++) {
    const p = s.players[i];
    const marks = [
      i === s.dealerIdx ? "庄" : "",
      p.folded ? "弃" : "",
      p.allIn ? "全下" : "",
      i === s.currentIdx && !p.folded ? "▶行动" : "",
    ].filter((m) => m !== "").join("");
    lines.push(`${p.name}（${p.chips}）${marks === "" ? "" : ` ${marks}`}`);
  }
  return lines.join("\n");
}

// 当前该谁行动的提示行。
function whoseTurn(s: TableState): string {
  const p = s.players[s.currentIdx];
  return p === undefined ? "" : `轮到 ${p.name}（可：过牌/跟注/加注 数字/全下/弃牌）`;
}

// 摊牌结算 → 播报（含每人最终筹码），返回播报文本。局结束（nextState=null）。
function showdownReport(table: TableState): string {
  const alive = table.players.filter((p) => !p.folded);
  const lines: string[] = ["** showdown 摊牌 **", `公牌：${cardsLabel(table.community)}`];
  for (const p of alive) {
    const score = evaluateSeven([...p.hole, ...table.community]);
    lines.push(`${p.name} 的底牌：${p.hole.map(cardLabel).join(" ")}（${handCategoryLabel(score)}）`);
  }
  if (alive.length === 1) {
    lines.push(`其余玩家全部弃牌，${alive[0].name} 独得底池 ${table.pot}！`);
    alive[0].chips += table.pot;
  } else {
    const { shares, lines: potLines } = settleShowdown(table);
    lines.push(...potLines);
    for (const sh of shares) {
      const p = table.players.find((x) => x.openid === sh.openid);
      if (p !== undefined) p.chips += sh.amount;
    }
  }
  lines.push("本局结束（v1 无跨局积分）。想再来一局发 /德州扑克 重开～");
  return lines.join("\n");
}

// 进入新一街时给"发公牌"的播报头。
function streetHeader(table: TableState): string {
  if (table.phase === "flop") return `翻牌！公牌：${cardsLabel(table.community)}`;
  if (table.phase === "turn") return `转牌！公牌：${cardsLabel(table.community)}`;
  if (table.phase === "river") return `河牌！公牌：${cardsLabel(table.community)}`;
  return "";
}

export const holdemMachine: StateMachine<HoldemState> = {
  name: "德州扑克",

  start(ctx): Transition<HoldemState> {
    const event = ctx.event;
    if (event.type !== "GROUP_MESSAGE_CREATE" && event.type !== "GROUP_AT_MESSAGE_CREATE") {
      // 单聊开局无意义：桌是群资产。返回 null 开局即结束。
      return { nextState: null, reply: "德州扑克要在群里开桌哦～（单聊没有牌桌的概念）" };
    }
    return {
      nextState: {
        stage: "waiting",
        groupOpenid: event.groupOpenid,
        players: [{ openid: event.authorOpenid, name: event.authorName }],
        table: null,
      },
      reply: [
        "**牌桌已开！**",
        `发起人 ${event.authorName} 已入座。发「加入」上桌（${MIN_PLAYERS}~${MAX_PLAYERS} 人），`,
        `人齐后发「开始」开局。盲注 ${BIG_BLIND}，每人每局 ${START_CHIPS} 筹码。`,
        "发「解散」随时取消牌局。牌局进行中请回群里行动（私聊里说的话不进牌局）。",
      ].join("\n"),
    };
  },

  step(state, ctx): Transition<HoldemState> {
    const event = ctx.event;
    // 只在群里玩；单聊消息键不上这桌（conversationKey 是 c2c:），理论到不了这里，
    // 防御性放行。
    if (event.type !== "GROUP_MESSAGE_CREATE" && event.type !== "GROUP_AT_MESSAGE_CREATE") {
      return { nextState: state, reply: "", passThrough: true };
    }
    const text = ctx.text.trim();
    const openid = event.authorOpenid;

    // ---- 全局指令：解散（任何人任何时候） ----
    if (text === "解散" || text === "/解散") {
      return { nextState: null, reply: "牌局已解散，筹码不留存（v1 无跨局积分）。下次再玩～" };
    }

    // ---- waiting 阶段：加入/退出/开始 ----
    if (state.stage === "waiting") {
      if (text === "加入" || text === "上桌") {
        if (state.players.some((p) => p.openid === openid)) {
          return { nextState: state, reply: `${event.authorName} 已经在桌上了～` };
        }
        if (state.players.length >= MAX_PLAYERS) {
          return { nextState: state, reply: `桌上满员（${MAX_PLAYERS} 人）了，下局再来～` };
        }
        const players = [...state.players, { openid, name: event.authorName }];
        return {
          nextState: { ...state, players },
          reply: `${event.authorName} 上桌（${players.length}/${MAX_PLAYERS}）。${players.length >= MIN_PLAYERS ? "人已够，发「开始」开局。" : `还差 ${MIN_PLAYERS - players.length} 人。`}`,
          // 入座即验私聊可达性（方案 §5.1 倾向项）：发不到底牌的人不该开局后才发现
          effects: [{ kind: "dm", openid, text: `你已加入 ${state.groupOpenid.slice(-4)} 群的牌桌。开局后你的底牌会发到这里；行动请回群里说（这里回复不进牌局）。` }] as Effect[],
        };
      }
      if (text === "退出" || text === "离座") {
        const players = state.players.filter((p) => p.openid !== openid);
        if (players.length === state.players.length) {
          return { nextState: state, reply: "你本来就不在桌上哦～" };
        }
        return { nextState: { ...state, players }, reply: `${event.authorName} 离座（剩 ${players.length} 人）。` };
      }
      if (text === "开始") {
        if (state.players.length < MIN_PLAYERS) {
          return { nextState: state, reply: `至少 ${MIN_PLAYERS} 人才能开局，现在 ${state.players.length} 人。` };
        }
        const table = startHand(state.players);
        const dms: Effect[] = table.players.map((p) => ({
          kind: "dm",
          openid: p.openid,
          text: `你的底牌：${p.hole.map(cardLabel).join(" ")}\n（本局盲注 ${BIG_BLIND}；行动回群里说，这里回复不进牌局）`,
        }));
        const sb = table.players.find((p) => p.betThisRound === BIG_BLIND / 2);
        const bb = table.players.find((p) => p.betThisRound === BIG_BLIND);
        return {
          nextState: { ...state, stage: "playing", table },
          reply: [
            "**开局！底牌已私聊发给各位玩家**",
            `庄家：${table.players[table.dealerIdx].name}，小盲 ${sb?.name ?? "?"}（${BIG_BLIND / 2}），大盲 ${bb?.name ?? "?"}（${BIG_BLIND}）`,
            tableSnapshot(table),
            whoseTurn(table),
          ].join("\n"),
          effects: dms,
        };
      }
      return { nextState: state, reply: "", passThrough: true };
    }

    // ---- playing 阶段 ----
    const table = state.table;
    if (table === null) {
      // 不可达防御：stage=playing 必有 table。出现即结束避免死锁。
      return { nextState: null, reply: "牌局状态异常，已关闭。请重新 /德州扑克 开桌。" };
    }

    if (text === "状态") {
      return { nextState: state, reply: `${tableSnapshot(table)}\n${whoseTurn(table)}` };
    }

    const action = parseAction(text);
    if (action === null) {
      return { nextState: state, reply: "", passThrough: true };
    }

    // 行动只认轮到的人：其他人说"跟注"当闲聊放行（方案 §2.3 冲突原则）
    const playerIdx = table.players.findIndex((p) => p.openid === openid);
    if (playerIdx !== table.currentIdx || table.players[playerIdx].folded) {
      return { nextState: state, reply: "", passThrough: true };
    }

    const next = applyAction(table, playerIdx, action);
    if (next === null) {
      // 非法行动（该 check 时 raise 数字不够等）：提示本人，状态不动
      const need = table.currentBet - table.players[playerIdx].betThisRound;
      return {
        nextState: state,
        reply: `${event.authorName}：这个行动现在不合法哦（当前注线 ${table.currentBet}，你还差 ${need}；过牌仅无人下注时可用；加注至少到 ${table.currentBet + table.minRaise}）。`,
      };
    }

    // 摊牌即终局
    if (next.phase === "showdown") {
      return { nextState: null, reply: showdownReport(next) };
    }

    // 跨街（flop/turn/river）时播公牌头 + 新街行动提示
    const crossed = next.phase !== table.phase;
    const parts = crossed ? [streetHeader(next), tableSnapshot(next), whoseTurn(next)] : [`${event.authorName} ${actionText(action)}。`, tableSnapshot(next), whoseTurn(next)];

    return {
      nextState: { ...state, table: next },
      reply: parts.join("\n"),
    };
  },
};

function actionText(a: Action): string {
  if (a.kind === "fold") return "弃牌";
  if (a.kind === "check") return "过牌";
  if (a.kind === "call") return "跟注";
  if (a.kind === "allin") return "全下";
  return `加注到 ${a.to}`;
}
