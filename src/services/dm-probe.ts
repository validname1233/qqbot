// services/dm-probe.ts —— 探针命令：/私聊我。
// 用途：真机验证两件事（知识库权限方案的决策依据）——
//   1. 群事件的 author.user_openid 是否实际下发（官方 User 类型声明了该字段，
//      但文档群事件示例里不带——示例非规范，需要真机定案）；
//   2. 拿群事件里的 user_openid 能否向该用户主动推送单聊（pushC2CMessage
//      不带 msg_id，走主动消息通道，权限/频控错误码见 messages.ts 头注释）。
// 顺手验 member_role 是否下发（同一份 author 原文里，detail 日志有全文）。
//
// 命令语义：群里发 "/私聊我" → bot 尝试用 user_openid 主动私发一条测试消息，
// 群里回一条探测结果报告。单聊场景发这个命令没有意义（user_openid 已知可用），
// 直接说明。这是临时探针，验证结束后可整文件删除。

import type { CommandService, MessageContext } from "../types.js";
import { pushC2CMessage } from "../qq/messages.js";
import { logger } from "./logger.js";

export const dmProbeService: CommandService = {
  name: "私聊我",
  aliases: ["dm"],

  async handle(ctx: MessageContext): Promise<string | null> {
    const event = ctx.event;
    if (event.type !== "GROUP_MESSAGE_CREATE" && event.type !== "GROUP_AT_MESSAGE_CREATE") {
      return "这个探针要在群里用哦（单聊里 user_openid 已知可用，没东西可测）～";
    }

    // 探针 1：事件里有没有 user_openid。没有就到此为止——这本身就是实验结果。
    if (event.authorUserOpenid === null) {
      logger.warn("dm-probe", `群事件未携带 user_openid（author=${event.authorName}），私聊通道无从建立`);
      return [
        "探测结果①：这条群事件里没有 user_openid 字段。",
        "（author 原文已写入 detail 日志，可确认实际下发了哪些字段）",
      ].join("\n");
    }

    // 探针 2：用它主动推单聊。成败都回群里报告——错误码就是实验数据。
    const masked = `${event.authorUserOpenid.slice(0, 6)}...${event.authorUserOpenid.slice(-4)}`;
    try {
      await pushC2CMessage(
        event.authorUserOpenid,
        "✅ 群→单聊通道探测成功：这条消息是你刚在群里发 /私聊我 触发的主动私发。",
      );
      logger.node("dm-probe", `群→单聊推送成功 (${masked})`);
      return [
        "探测结果②：user_openid 有值，主动私发成功 ✅",
        `（收件人 openid ${masked}，去单聊窗口看一眼有没有收到）`,
      ].join("\n");
    } catch (err) {
      // pushC2CMessage 失败会抛（apiRequest 统一错误，含 QQ 错误码）。
      // 这里不兜底成"稍后再试"——错误原文就是本次实验要的数据。
      const raw = err instanceof Error ? err.message : String(err);
      logger.warn("dm-probe", `群→单聊推送失败 (${masked}): ${raw.slice(0, 400)}`);
      return `探测结果②：user_openid 有值，但主动私发失败 ❌\n错误原文：${raw.slice(0, 300)}`;
    }
  },
};
