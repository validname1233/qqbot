// services/deep-search.ts —— 命令型 service 壳："/深度检索 问题" 走这里。
// 与 agentService（/Agent）平行的独立入口——深检有自己的图（agent/deep-search.ts）、
// 自己的工具表和预算，不与日常 Agent 链路共享任何状态。
// 参数支持两种：普通问题（Tavily 起点检索）或直接给 http(s):// URL（跳过搜索）。

import type { CommandService, MessageContext } from "../types.js";
import { runDeepSearch } from "../agent/deep-search.js";

export const deepSearchService: CommandService = {
  name: "深度检索",
  aliases: ["ds", "deepsearch"],

  async handle(ctx: MessageContext): Promise<string | null> {
    const question = ctx.args;
    if (question.trim() === "") {
      return "用法：/深度检索 想深入调研的问题（也可以直接给一个网址作起点）";
    }
    return runDeepSearch(question, ctx);
  },
};
