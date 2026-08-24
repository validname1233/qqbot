// handlers/GROUP_AT_MESSAGE_CREATE.ts —— 群@消息的编排层。
// 结构和 C2C_MESSAGE_CREATE handler 完全一致：解析 context → 并发跑命令+观察者 → 汇总回复。
// 唯一差别在最后一步：回复用 replyGroupMarkdown 发到群，收件人是 groupOpenid。
// service 层（registry / chat / 观察者）被两个 handler 共用，不用为群聊重写一遍。

import type { GroupAtMessageEvent } from "../events/GROUP_AT_MESSAGE_CREATE/index.js";
import { replyGroupMessage, replyGroupMarkdown } from "../qq/messages.js";
import { logger } from "../services/logger.js";
import { buildContext, runCommand, runObservers } from "../registry.js";

export async function handleGroupAtMessage(
  event: GroupAtMessageEvent,
): Promise<void> {
  const ctx = buildContext(event);

  const [commandReply, observerReplies] = await Promise.all([
    runCommand(ctx),
    runObservers(ctx),
  ]);

  const replies = [commandReply, ...observerReplies].filter(
    (r): r is string => r !== null && r !== "",
  );

  // Markdown 优先，失败回退纯文本（同 GROUP_MESSAGE_CREATE handler）。
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
