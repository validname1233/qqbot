// services/agent.ts —— 命令型 service："/Agent 聊天内容" 走这里，进入 agent 链路。
// 本文件只是把 CommandService 这层薄壳接到 runAgentTurn 上，并在这里登记工具——
// 具体工具实现放在 agent/tools/ 下，加新工具只需在这里补一行 registerTool。

import type { CommandService, MessageContext } from "../types.js";
import { runAgentTurn } from "../agent/loop.js";
import { registerTool } from "../agent/registry.js";
import { setReminderTool } from "../agent/tools/set-reminder.js";
import { searchTool } from "../agent/tools/search.js";
import { addMemoryTool } from "../agent/tools/add-memory.js";
import { deleteMemoryTool } from "../agent/tools/delete-memory.js";
import { clearAllMemoriesTool } from "../agent/tools/clear-all-memories.js";

registerTool(setReminderTool);
registerTool(searchTool);
registerTool(addMemoryTool);
registerTool(deleteMemoryTool);
registerTool(clearAllMemoriesTool);

export const agentService: CommandService = {
  name: "Agent",

  async handle(ctx: MessageContext): Promise<string | null> {
    // 现在必须显式 /Agent 触发（registry.ts 不再有兜底 service），
    // ctx.command 恒不为 null，取命令后的部分即可。
    const question = ctx.args;
    if (question.trim() === "") {
      return "用法：/Agent 你想说的话～";
    }
    return runAgentTurn(question, ctx);
  },
};
