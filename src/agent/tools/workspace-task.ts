// agent/tools/workspace-task.ts —— 主 Agent 的委派工具（决策八）。
// task 参数就是任务规格书：主模型填参数时把群聊历史/长期记忆里与任务相关的
// 信息蒸馏进去——子 Agent 只看到这段文字（状态完全隔离）。schema 描述就是
// "怎么写规格书"的使用说明，措辞直接决定委派质量。

import type { Tool } from "../tool.js";
import type { MessageContext } from "../../types.js";
import { runWorkspaceTask } from "../../services/workspace/run-task.js";
import { asString } from "../code-workspace/tools/shared.js";

export const workspaceTaskTool: Tool = {
  name: "workspace_task",
  description:
    "委派一个数据分析/写代码/跑脚本的任务给工作台子执行者（独立沙箱，预装 python3、" +
    "numpy/pandas/matplotlib，无网络）。适用：算数据、处理文件、写并运行脚本、" +
    "修改 workspace 里已有的脚本再跑等。不适用：查网络信息、闲聊、简单问答。" +
    "task 是子执行者能看到的全部信息（它看不到我们的对话）——必须自包含：" +
    "目标、数据来源（文件名，或注明'用户接下来会提供'）、期望输出、相关背景与约束。" +
    "执行可能需要几分钟，结果会以报告形式返回（含精确数字，转述时保留）。",
  parameters: {
    type: "object",
    properties: {
      task: {
        type: "string",
        description:
          "完整的任务规格书。示例：'读取 workspace 里 scores.csv（两列：姓名,成绩），" +
          "统计平均分和标准差，按分数降序列出前 5 名，把完整结果存到 result.md'。" +
          "把本任务需要的上下文（用户在对话里给过的数据、文件名、口径）都写进去。",
      },
    },
    required: ["task"],
  },
  progressNote: "正在委派工作台任务…",
  skipMemory: true, // 规格书与报告都是"过程产物"，报告由主 Agent 转述后落库——原文不进热窗口

  async run(args, ctx: MessageContext): Promise<string> {
    const task = asString(args, "task");
    if (task === undefined || task.trim() === "") {
      return "[失败] workspace_task：缺少 task 参数（任务规格书不能为空）";
    }
    // 委派模式：不传 ownFlow（主流程已持闸），runWorkspaceTask 内部反查父 signal。
    const report = await runWorkspaceTask(task, ctx);
    if (report === "") {
      return "[任务被中止]（用户执行了 /stop 或预算耗尽）";
    }
    return report;
  },
};
