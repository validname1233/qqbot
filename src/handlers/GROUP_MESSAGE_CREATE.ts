// handlers/GROUP_MESSAGE_CREATE.ts —— 群内全量消息（不限于@机器人）的编排层。
// 结构和 GROUP_AT_MESSAGE_CREATE handler 完全一致：解析 context → 并发跑命令+观察者 → 汇总回复。
// 开启"接收所有消息"后，原来的 @消息也会退化成这个事件（已实测确认），这个 handler
// 就顶替了原来 GROUP_AT_MESSAGE_CREATE handler 的实际职责。两个 handler 暂时并存，
// 是否要合并/是否要区分"有没有@机器人"留给后续设计，不在这次顺手决定。

import type { GroupMessageEvent } from "../events/GROUP_MESSAGE_CREATE/index.js";
import { replyGroupMessage, replyGroupMarkdown } from "../qq/messages.js";
import { logger } from "../services/logger.js";
import { buildContext, runCommand, runObservers } from "../registry.js";

export async function handleGroupMessage(event: GroupMessageEvent): Promise<void> {
  const ctx = buildContext(event);

  const [commandReply, observerReplies] = await Promise.all([
    runCommand(ctx),
    runObservers(ctx),
  ]);

  const replies = [commandReply, ...observerReplies].filter(
    (r): r is string => r !== null && r !== "",
  );

  // Markdown 优先，失败回退纯文本：Markdown 消息受平台权限/频控约束（说变就变），
  // 发送失败时不能让回复整个丢失——降级用纯文本再发一次，保证内容可达。
  let seq = 1;
  for (const reply of replies) {
    try {
      await replyGroupMarkdown(event.groupOpenid, reply, event.msgId, seq);
    } catch (err) {
      logger.warn(
        "webhook",
        `群 Markdown 回复失败，回退纯文本（msgId=${event.msgId} seq=${seq}）: ${err instanceof Error ? err.message : err}`,
      );
      await replyGroupMessage(event.groupOpenid, reply, event.msgId, seq);
    }
    seq += 1;
  }
}
