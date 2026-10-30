// services/stop.ts —— 命令型 service：/stop 强制中断本会话进行中的长流程（Agent/深度检索）。
// 只是 interrupt.ts 注册表的一个薄壳：按 tenantKey 拉闸——群聊粒度（2026-10-14
// 键统一），任何群员都可停掉本群正在跑的任务；单聊就是用户停自己的。abort
// 发起人记审计日志。

import type { CommandService, MessageContext } from "../types.js";
import { tenantKey } from "../session/key.js";
import { abortFlow } from "../session/interrupt.js";
import { logger } from "./logger.js";


export const stopService: CommandService = {
  name: "stop",
  aliases: ["停止"],

  async handle(ctx: MessageContext): Promise<string | null> {
    const aborted = abortFlow(tenantKey(ctx.event));
    if (aborted) {
      // 审计：谁拉的闸。群粒度中止下，任务发起者可能不是 /stop 的发送者——
      // 被停的人只会看到任务终止，这条日志是事后查"是谁停的"的唯一线索。
      logger.info(
        "stop",
        `/stop 中止任务，发起人=${ctx.event.authorOpenid}（${ctx.event.authorName}）`,
      );
      // 拉闸成功 ≠ 流程已完全停下（abort 异步生效，被中断流程的收尾还要跑一会，
      // 但它识别 AbortError 后不会再发误导性的失败消息），这里立刻给用户确认。
      return `---进行中的任务已终止---`;
    }
    return `现在没有在跑的任务哦～（/Agent 和 /深度检索 运行时才能用 /stop 打断）`;
  },
};
