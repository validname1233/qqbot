// agent/tools/set-reminder.ts —— 把定时提醒包装成 Agent 可调用的工具。
// 校验/排期/推送逻辑全部复用 services/reminder.ts 的 scheduleReminder，这里只做
// 「模型给的结构化参数 → 调用同一份核心逻辑」的转换，不重复实现。

import type { Tool } from "../tool.js";
import { scheduleReminder } from "../../services/reminder.js";

export const setReminderTool: Tool = {
  name: "set_reminder",
  // 描述按四模块格式（提示词方案 §10.1，2026-10-30）；[何时用] 含 M2.2 强触发细则。
  description:
    "[Purpose]设置定时提醒，到点后主动发消息提醒用户。\n" +
    "[Usage]用户表达定时/提醒意图时调用：「X 点提醒我」「十分钟后叫我」「别忘了…」。" +
    "注意两点：①延时需要换算（用户说「明晚九点」而当前时间未知时，先用 get_time 取当前" +
    "时间再换算成秒数）；②用户只是记事、没有要求到点提醒时，不要用本工具——" +
    "当前没有记忆类工具，口头确认即可。\n" +
    "[Params]seconds：从现在起多少秒后提醒，10 到 86400（一天）之间的整数——" +
    "把用户的相对表述换算成秒（如「半小时」=1800）。description：提醒事项的具体内容，" +
    "用简洁完整的句子（到点会原样转达给用户）。\n" +
    "[Limits]瞬时返回（本地排期）；成功返回确认文本；参数越界会返回明确的错误提示。" +
    "注意：重启进程会丢失未触发的提醒（纯内存排期）。",
  parameters: {
    type: "object",
    properties: {
      seconds: {
        type: "integer",
        description: "从现在起多少秒后提醒，10 到 86400 之间的整数",
      },
      description: {
        type: "string",
        description: "要提醒用户做的具体事情",
      },
    },
    required: ["seconds", "description"],
  },

  async run(args, ctx) {
    const seconds = Number(args.seconds);
    const description = typeof args.description === "string" ? args.description : "";
    return scheduleReminder(ctx, seconds, description);
  },
};
