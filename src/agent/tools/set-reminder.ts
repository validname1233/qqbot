// agent/tools/set-reminder.ts —— 把定时提醒包装成 Agent 可调用的工具。
// 校验/排期/推送逻辑全部复用 services/reminder.ts 的 scheduleReminder，这里只做
// 「模型给的结构化参数 → 调用同一份核心逻辑」的转换，不重复实现。

import type { Tool } from "../tool.js";
import { scheduleReminder } from "../../services/reminder.js";

export const setReminderTool: Tool = {
  name: "set_reminder",
  description:
    "设置一个定时提醒。延时秒数必须是 10 到 86400（一天）之间的整数，到点后会主动提醒用户。",
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
