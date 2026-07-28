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
    if (ctx.args.trim() === "") {
      return "跟本鲸鱼说点什么吧，格式：/Agent 你想说的话～";
    }
    return runAgentTurn(ctx.args, ctx);
  },
};
