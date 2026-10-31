// services/agent.ts —— 命令型 service："/Agent 聊天内容" 走这里，进入 agent 链路。
// 本文件只是把 CommandService 这层薄壳接到 runAgentTurn 上，并在这里登记工具——
// 具体工具实现放在 agent/tools/ 下，加新工具只需在这里补一行 registerTool。
//
// 2026-10-28 记忆重构：图片持久化职责上移 dispatcher（transcript.recordInbound
// → persistEventImages），本文件不再下载图片——u_now 的图片由装配层按
// (key, msgId) 反查展开（assembly.buildCurrentUserMessage）。

import type { CommandService, MessageContext } from "../types.js";
import { runAgentTurn } from "../agent/loop.js";
import { registerTool } from "../agent/registry.js";
import { setReminderTool } from "../agent/tools/set-reminder.js";
import { searchTool } from "../agent/tools/search.js";
import { agentOpenPageTool } from "../agent/tools/open-page.js";
import { getTimeTool } from "../agent/tools/get-time.js";
import { recallMemoryTool } from "../agent/tools/recall-memory.js";
import { workspaceTaskTool } from "../agent/tools/workspace-task.js";
import { deepSearchTaskTool } from "../agent/tools/deep-search-task.js";
import { config } from "../config.js";

registerTool(setReminderTool);
registerTool(searchTool);
// fetch_tool：用户直接给 URL 时打开阅读（复用深检的 open_page 能力层）。
registerTool(agentOpenPageTool);
// get_time：拿服务器当前时间。模型对"今天几号"没有可靠感知（训练数据截止），
// 日期类问题必须靠工具而不是猜。
registerTool(getTimeTool);
// recall_memory：L2 档案回看（v4：零参数、固定 N 条 + flash 检索式摘要）。
registerTool(recallMemoryTool);
// workspace_task：工作台委派入口。受总开关控制——关闭时模型看不到它。
if (config.workspaceEnabled) {
  registerTool(workspaceTaskTool);
}
// deep_search：深度检索委派入口（双子 Agent 工具化方案 §2.1）。无外部依赖
// 恒注册——显式 /深度检索 命令与它双入口共用同一个图核心。
registerTool(deepSearchTaskTool);

export const agentService: CommandService = {
  name: "Agent",

  async handle(ctx: MessageContext): Promise<string | null> {
    // 入口可以是显式 /Agent，也可以是自动路由（单聊直说/群里@）转发的
    // {command:"Agent", args:question}——两种形态 args 都是问题文本。
    const question = ctx.args;
    if (question.trim() === "") {
      return "用法：/Agent 你想说的话～";
    }
    return runAgentTurn(question, ctx);
  },
};
