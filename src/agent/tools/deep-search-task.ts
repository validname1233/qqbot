// agent/tools/deep-search-task.ts —— 主 Agent 的深度检索委派工具（双子 Agent
// 工具化方案 §2.1，2026-10-31）。
// 壳层只做三件事：七模块描述（教主模型何时委派/怎么写问题）、参数校验、
// ownFlow:false 调核心（委派模式——借父闸，见 deep-search.ts 的 runDeepSearch）。
// progressNote 不声明：深检内部的进度文案（规划/搜索/打开页面）经 progress-bus
// 直达同一会话，壳层再推一条只会同秒连发（方案 §2.5 同款清理）。

import type { Tool } from "../tool.js";
import type { MessageContext } from "../../types.js";
import { runDeepSearch } from "../deep-search.js";
import { asString } from "../code-workspace/tools/shared.js";

export const deepSearchTaskTool: Tool = {
  name: "deep_search",
  description:
    "[Purpose]把问题交给深度调研子执行者——它会多轮搜索+打开网页阅读+汇总，" +
    "产出一份约 1500 字、注明来源链接的调研报告。\n" +
    "[Usage]用户需要深入调研的复杂问题：「深度调研一下X」「帮我全面了解X」" +
    "「对比一下A和B」这类需要多来源交叉信息的主题；或用户明确要求" +
    "「深度搜索/深入查一下」时。\n" +
    "[NotFor]查一个简单事实（用 search 一次就够）；闲聊、简单问答（直接回答）；" +
    "用户只要快速答案不要报告时别用它。\n" +
    "[Brief]question 是子执行者能看到的全部任务信息——它看不到我们的对话。" +
    "把用户的调研主题写成自包含的完整问题：主题是什么、用户关心哪些方面、" +
    "对话里出现过的相关背景都浓缩进去。示例：用户说「帮我深度查一下上次聊的那个" +
    "新能源车补贴政策」而对话里有地域线索，question 应写成「2026年XX省新能源车" +
    "补贴政策：额度、条件、申领流程」而非只写「新能源车补贴」。\n" +
    "[Params]question：完整的调研问题（自包含，写法见 [Brief]）。\n" +
    "[Expect]耗时 30~60 秒（期间会推送进度提示）；返回完整调研报告（含来源链接，" +
    "转述时可保留关键结论与链接）。用户执行 /stop 时调研中止，返回中止说明。\n" +
    "[Limits]依赖网络抓取，部分网站可能读不到（报告会注明）；调研深度受轮次与" +
    "时间预算限制，超长主题报告会聚焦核心部分。",
  parameters: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "完整的调研问题，写法见工具说明的 [Brief] 一节（自包含：主题、用户关心的方面、相关背景）。",
      },
    },
    required: ["question"],
  },

  async run(args, ctx: MessageContext): Promise<string> {
    const question = asString(args, "question");
    if (question === undefined || question.trim() === "") {
      return "[失败] deep_search：缺少 question 参数（调研问题不能为空）";
    }
    // 委派模式：ownFlow:false——主流程已持闸，深检内部反查父 signal 挂进图。
    const report = await runDeepSearch(question, ctx, { ownFlow: false });
    if (report === "") {
      return "[任务被中止]（用户执行了 /stop 或预算耗尽）";
    }
    return report;
  },
};
