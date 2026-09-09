// services/agent.ts —— 命令型 service："/Agent 聊天内容" 走这里，进入 agent 链路。
// 本文件只是把 CommandService 这层薄壳接到 runAgentTurn 上，并在这里登记工具——
// 具体工具实现放在 agent/tools/ 下，加新工具只需在这里补一行 registerTool。

import type { CommandService, MessageContext } from "../types.js";
import { runAgentTurn } from "../agent/loop.js";
import { persistEventImages } from "../agent/memory/images.js";
import { registerTool } from "../agent/registry.js";
import { setReminderTool } from "../agent/tools/set-reminder.js";
import { searchTool } from "../agent/tools/search.js";
import { addMemoryTool } from "../agent/tools/add-memory.js";
import { deleteMemoryTool } from "../agent/tools/delete-memory.js";
import { clearAllMemoriesTool } from "../agent/tools/clear-all-memories.js";
import { agentOpenPageTool } from "../agent/tools/open-page.js";
import { getTimeTool } from "../agent/tools/get-time.js";
import { recallMemoryTool } from "../agent/tools/recall-memory.js";

registerTool(setReminderTool);
registerTool(searchTool);
registerTool(addMemoryTool);
registerTool(deleteMemoryTool);
registerTool(clearAllMemoriesTool);
// fetch_tool：用户直接给 URL 时打开阅读（复用深检的 open_page 能力层，fetch_tool
// 方案见 docs/features/2026-09-02-fetch-tool实现方案.md）。日常版 description 无
// interact_page 引用；深检注册表另持原版，同一 run 逻辑单一维护。
registerTool(agentOpenPageTool);
// get_time：拿服务器当前时间。模型对"今天几号"没有可靠感知（训练数据截止），
// 日期类问题必须靠工具而不是猜。
registerTool(getTimeTool);
// recall_memory：冷存储检索（300 条原始对话按需翻查，两级记忆方案
// docs/features/2026-09-05-短期记忆两级化方案.md）。只挂全局表——深检不翻用户旧对话。
registerTool(recallMemoryTool);

export const agentService: CommandService = {
  name: "Agent",

  async handle(ctx: MessageContext): Promise<string | null> {
    // 现在必须显式 /Agent 触发（registry.ts 不再有兜底 service），
    // ctx.command 恒不为 null，取命令后的部分即可。
    const question = ctx.args;
    if (question.trim() === "") {
      return "用法：/Agent 你想说的话～";
    }
    // /Agent 消息自带的图片要先下载入库（占位符拼进当前 userMessage，当轮展开识图）。
    // 普通消息的图片走 memory-log observer，两条写入路径互不重叠。
    const imageIds = await persistEventImages(ctx.event);
    return runAgentTurn(question, ctx, imageIds);
  },
};
