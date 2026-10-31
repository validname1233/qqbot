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
  // 描述按七模块格式（提示词方案 §10.2 委派类，2026-10-30）：四模块基础 +
  // 委派特有的三块（不适用/规格书/预期）——子 Agent 看不到主对话，全部信息
  // 必须经规格书传递。schema 的 task 参数描述保持精简（详写会与 description
  // 重复；参数结构化待真机验证委派质量后另议，方案 §10.6）。
  description:
    "[Purpose]把数据分析/写代码/跑脚本类任务委派给工作台子执行者（独立 Docker 沙箱，" +
    "预装 python3、numpy/pandas/matplotlib，无网络访问）。\n" +
    "[Usage]用户要算数据、处理文件、写并运行脚本、修改 workspace 里已有的脚本再跑——" +
    "需要真实执行代码才能得到结果的任务。\n" +
    "[NotFor]查网络信息（用 search）；闲聊、简单问答、口算能解决的计算（直接回答）；" +
    "用户只是描述想法没要求执行时，先确认再委派。\n" +
    "[Brief]task 是子执行者能看到的全部信息——它看不到我们的对话，规格书必须自包含：" +
    "①目标（做什么、产出什么）；②数据来源（workspace 里的文件名，或注明「用户接下来会提供」）；" +
    "③期望输出（存到哪个文件/返回什么格式）；④相关背景与约束（对话里出现过的数据、口径、" +
    "特殊要求都写进去）。示例：'读取 workspace 里 scores.csv（两列：姓名,成绩），统计平均分" +
    "和标准差，按分数降序列出前 5 名，完整结果存到 result.md'。\n" +
    "[Params]task：完整的任务规格书（写法见 [Brief] 一节）。\n" +
    "[Expect]执行可能需要几分钟（期间会有进度提示）；返回一份报告（含精确数字，转述时保留）。" +
    "用户执行了 /stop 或预算耗尽时任务中止，返回中止说明。\n" +
    "[Limits]沙箱无网络，任务只能用 workspace 内的文件和预装库；执行失败时报告会写明失败原因。",
  parameters: {
    type: "object",
    properties: {
      task: {
        type: "string",
        description:
          "完整的任务规格书，写法见工具说明的[Brief]一节（自包含：目标、数据来源、期望输出、背景约束）。",
      },
    },
    required: ["task"],
  },
  // progressNote 不声明（2026-10-31 清理）：run-task.ts 内部的"工作台任务开始…"
  // 紧随其后且信息量更大，壳层再推一条构成同秒连发（双子 Agent 工具化方案 §2.5）。

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
