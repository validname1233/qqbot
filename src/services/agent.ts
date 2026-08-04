// services/agent.ts —— 命令型 service："/Agent 聊天内容" 走这里，进入 agent 链路。
// 本文件只是把 CommandService 这层薄壳接到 runAgentTurn 上，并在这里登记工具——
// 具体工具实现放在 agent/tools/ 下，加新工具只需在这里补一行 registerTool。

import type { CommandService, MessageContext } from "../types.js";
import { runAgentTurn } from "../agent/loop.js";
import { registerTool } from "../agent/registry.js";
import { setReminderTool } from "../agent/tools/set-reminder.js";
import { searchTool } from "../agent/tools/search.js";

registerTool(setReminderTool);
registerTool(searchTool);

export const agentService: CommandService = {
  name: "Agent",

  async handle(ctx: MessageContext): Promise<string | null> {
    // 现在是 registry.ts 的默认兜底 service（没带 / 命令时走这里），
    // command 为 null 时取整条消息 ctx.text；带命令时取命令后的部分 ctx.args——
    // 和原 chatService 的取值方式对齐，兼容以后加 /闲聊 之类命令复用同一个 handler。
    const question = ctx.command === null ? ctx.text : ctx.args;
    if (question.trim() === "") {
      return "跟本鲸鱼说点什么吧～";
    }
    return runAgentTurn(question, ctx);
  },
};
