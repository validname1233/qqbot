// services/stop.ts —— 命令型 service：/stop 强制中断当前会话的长流程（Agent/深度检索）。
// 只是 interrupt.ts 注册表的一个薄壳：按人粒度 sessionKey 拉闸，只能停自己的任务。

import type { CommandService, MessageContext } from "../types.js";
import { sessionKey } from "../session/key.js";
import { abortFlow } from "../session/interrupt.js";

export const stopService: CommandService = {
  name: "stop",
  aliases: ["停止"],

  async handle(ctx: MessageContext): Promise<string | null> {
    const aborted = abortFlow(sessionKey(ctx.event));
    if (aborted) {
      // 拉闸成功 ≠ 流程已完全停下（abort 异步生效，被中断流程的收尾还要跑一会，
      // 但它识别 AbortError 后不会再发误导性的失败消息），这里立刻给用户确认。
      return "---流程已终止---";
    }
    return "现在没有在跑的任务哦～（/Agent 和 /深度检索 运行时才能用 /stop 打断）";
  },
};
