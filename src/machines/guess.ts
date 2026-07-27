// machines/guess.ts —— 第一个状态机：猜数字。用来验证整条「模式锁」链路。
// 谜底 1~100，用户每发一个数字回「太大/太小」，猜中结束；发「退出」中途放弃。
// 全部逻辑集中在 step（纯 reducer）：不发消息、不碰网络，只算「新状态 + 回什么话」。

import type { MessageContext } from "../types.js";
import type { StateMachine, Transition } from "./types.js";

// 状态极简：谜底 + 已猜次数。
interface GuessState {
  answer: number;
  tries: number;
}

const MIN = 1;
const MAX = 100;

export const guessMachine: StateMachine<GuessState> = {
  name: "猜数字",

  start(): Transition<GuessState> {
    // Math.random 在实际运行的 Node 里正常可用。谜底取 [MIN, MAX] 闭区间整数。
    const answer = Math.floor(Math.random() * (MAX - MIN + 1)) + MIN;
    return {
      nextState: { answer, tries: 0 },
      reply: `猜数字开始啦～我心里想了一个 ${MIN} 到 ${MAX} 的整数，直接发数字来猜。想中途放弃就发「退出」。`,
    };
  },

  step(state: GuessState, ctx: MessageContext): Transition<GuessState> {
    const input = ctx.text.trim();

    // 主动退出：结束会话（nextState=null），不消耗谜底。
    if (input === "退出") {
      return { nextState: null, reply: `不玩啦？答案是 ${state.answer}，下次再来～` };
    }

    // ⚠️ 坑：Number("") === 0（不是 NaN），空串会被当成猜了 0。
    // 所以先挡空串，再用 Number.isInteger 卡住非整数/小数/NaN，状态原样不变、不计次数。
    if (input === "" || !Number.isInteger(Number(input))) {
      return { nextState: state, reply: "发一个整数来猜嘛，别的我看不懂～" };
    }

    const n = Number(input);
    if (n < MIN || n > MAX) {
      return { nextState: state, reply: `只猜 ${MIN} 到 ${MAX} 之间的数哦。` };
    }

    const tries = state.tries + 1;
    if (n < state.answer) {
      return { nextState: { answer: state.answer, tries }, reply: "太小了，往大猜。" };
    }
    if (n > state.answer) {
      return { nextState: { answer: state.answer, tries }, reply: "太大了，往小猜。" };
    }
    // 猜中：结束会话。
    return { nextState: null, reply: `猜中了！答案就是 ${state.answer}，你用了 ${tries} 次。` };
  },
};
