// services/dm-probe.ts —— 探针命令：/私聊我（德州扑克双通道架构验证）。
// 背景：已真机验证同一账号 member_openid === user_openid（2026-09-30 群/单聊
// 各发一条消息对比 authorOpenid），所以群事件里的 authorOpenid 可以直接当
// 单聊推送目标——"群聊认人、私聊发牌"的通道由此成立。
// 本探针补上最后一环的实测：pushC2CMessage(群里的authorOpenid) 是否真能送达。
// 主动推送的平台约束（messages.ts 头注释）：未加好友 40054004、用户拒收
// 40054013、无权限 40034105——对扑克都是硬前提：玩家推不到就发不了底牌。
// 这是临时探针（德州扑克正式命令会是独立的 /开局 命令+群粒度状态机），
// 通道验证后删除。

import type { CommandService, MessageContext } from "../types.js";
import { pushC2CMessage } from "../qq/messages.js";
import { logger } from "./logger.js";

export const dmProbeService: CommandService = {
  name: "私聊我",

  async handle(ctx: MessageContext): Promise<string | null> {
    const event = ctx.event;
    if (event.type !== "GROUP_MESSAGE_CREATE" && event.type !== "GROUP_AT_MESSAGE_CREATE") {
      return "这个探针要在群里用哦～";
    }

    try {
      await pushC2CMessage(
        event.authorOpenid,
        "✅ 私聊通道打通：这条消息由你在群里的 /私聊我 触发（群 member_openid 直接作单聊推送目标）。将来你的底牌就走这条通道发到这里。",
      );
      logger.node("dm-probe", `群→单聊推送成功 (${event.authorOpenid.slice(0, 6)}...)`);
      return `已给 ${event.authorName} 私发一条消息，去单聊窗口看一眼～`;
    } catch (err) {
      // 失败原文直接回群——错误码（未加好友/拒收/无权限）正是本次要的数据。
      const raw = err instanceof Error ? err.message : String(err);
      logger.warn("dm-probe", `群→单聊推送失败: ${raw.slice(0, 400)}`);
      return `私聊发送失败 ❌\n错误原文：${raw.slice(0, 300)}`;
    }
  },
};
