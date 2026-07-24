// services/chat.ts —— 命令型 service：AI 聊天。
// 它是对底层 client（ai.ts）的一层业务包装：把"用户这次想聊什么"整理好，
// 交给 askAI，再把结果作为回复返回。ai.ts 只管调接口，不知道自己是被聊天功能用的。

import type { CommandService, MessageContext } from "../types.js";
import { askAI } from "./ai.js";

export const chatService: CommandService = {
  name: "聊天",
  aliases: ["chat"],

  async handle(ctx: MessageContext): Promise<string | null> {
    // 命令后面跟的才是要问 AI 的话。/聊天 今天天气 → 问"今天天气"。
    // 没带命令时（兜底走到这里），command 为 null，args 为空，
    // 此时把整条消息当作输入。
    const question = ctx.command === null ? ctx.text : ctx.args;

    // 空问题就提示一下，别拿空字符串去问 AI。
    if (question === "") {
      return "想聊点什么？直接发给我就行～";
    }

    // 这里不 try/catch：registry 的 runCommand 已统一兜错。
    // service 只管把正常路径写清楚，异常交给上层统一处理。
    return await askAI(question);
  },
};
