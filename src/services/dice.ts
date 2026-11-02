// services/dice.ts —— 命令型 service：/r 掷骰子（TRPG 风格骰子表达式）。
// 纯本地计算（crypto.randomInt），不调模型不碰记忆库——回复经发送层照常
// 落 chat_bot 行（所有命令回复的通用行为），除此之外与记忆层零交集。

import { randomInt } from "node:crypto";
import type { CommandService, MessageContext } from "../types.js";

// 上限保护：防"999999d999999"式输入把回复刷成万行。
const MAX_DICE = 100;
const MAX_SIDES = 1_000_000;
const MAX_MOD = 1_000_000;

// 表达式：<骰数>d<面数>[±<修正>]。骰数可省（d100 = 1d100），d 大小写均可。
// 只支持单段骰子——多段组合（2d6+1d8）不做，用法提示里说清。
const DICE_RE = /^(\d*)d(\d+)([+-]\d+)?$/i;

export const diceService: CommandService = {
  name: "r",
  aliases: ["roll", "骰子"],

  async handle(ctx: MessageContext): Promise<string | null> {
    // 空白全剥（"1d100 + 20" 与 "1d100+20" 等价），回显用剥完的原样。
    const expr = ctx.args.replace(/\s+/g, "");
    const m = DICE_RE.exec(expr);
    if (m === null) {
      return "用法：/r <骰数>d<面数>[+/-<修正>]，如 /r 1d100、/r 2d20+10";
    }

    const count = m[1] === "" ? 1 : Number(m[1]);
    const sides = Number(m[2]);
    const mod = m[3] === undefined ? 0 : Number(m[3]);
    if (count < 1 || count > MAX_DICE || sides < 1 || sides > MAX_SIDES || Math.abs(mod) > MAX_MOD) {
      return `骰子参数超范围：骰数 1~${MAX_DICE}，面数 1~${MAX_SIDES}，修正 ±${MAX_MOD} 以内`;
    }

    // 掷骰子用 randomInt（无偏均匀）；"先随机后加"：每颗独立掷完再加修正。
    const rolls = Array.from({ length: count }, () => randomInt(1, sides + 1));
    const total = rolls.reduce((sum, r) => sum + r, 0) + mod;

    // 展示：单骰无修正只报点数（/r 1d100 的主用法，输出最短）；多骰或带修正
    // 列出算式，过程可见。
    if (rolls.length === 1 && mod === 0) {
      return `${expr}结果：${total}`;
    }
    const formula =
      rolls.join(" + ") + (mod === 0 ? "" : mod > 0 ? ` + ${mod}` : ` - ${-mod}`);
    return `${expr}结果：${formula} = ${total}`;
  },
};
