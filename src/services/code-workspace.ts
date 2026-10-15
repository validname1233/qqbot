// services/code-workspace.ts —— 命令型 service 壳："/代码 任务描述" 走这里。
// 决策八：这是兜底入口（主路径是主 Agent 的 workspace_task 委派）——模型漏路由
// 时用户强制直达；调试时也需要一个确定入口。与 runWorkspaceTask 的关系同
// deepSearchService 与 runDeepSearch：薄壳只做参数校验和模式选择（ownFlow=true）。

import type { CommandService, MessageContext } from "../types.js";
import { runWorkspaceTask } from "./workspace/run-task.js";
import { config } from "../config.js";

export const codeWorkspaceService: CommandService = {
  name: "代码",
  aliases: ["code"],

  async handle(ctx: MessageContext): Promise<string | null> {
    if (!config.workspaceEnabled) {
      return "工作台功能还没开启哦～（管理员配置 WORKSPACE_ENABLED=true 后可用）";
    }
    const task = ctx.args;
    if (task.trim() === "") {
      return "用法：/代码 要完成的任务\n例：/代码 读取 scores.csv 算出平均分和标准差";
    }
    // 独立模式：自己登记流程闸（与 /Agent、/深度检索 同款）。
    return runWorkspaceTask(task, ctx, { ownFlow: true });
  },
};
