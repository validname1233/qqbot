// handlers/GROUP_MESSAGE_CREATE.ts —— 群消息的编排层。
// 结构和 C2C_MESSAGE_CREATE handler 完全一致：解析 context → 并发跑命令+观察者 → 汇总回复。
// 唯一差别在最后一步：回复用 replyGroupMessage 发到群，收件人是 groupOpenid。
// service 层（registry / chat / 观察者）被两个 handler 共用，不用为群聊重写一遍。

import type { GroupMessageEvent } from "../events/GROUP_MESSAGE_CREATE/index.js";
import { replyGroupMessage } from "../qq/messages.js";
import { buildContext, runCommand, runObservers } from "../registry.js";

export async function handleGroupMessage(
  event: GroupMessageEvent,
): Promise<void> {
  const ctx = buildContext(event);

  const [commandReply, observerReplies] = await Promise.all([
    runCommand(ctx),
    runObservers(ctx),
  ]);

  const replies = [commandReply, ...observerReplies].filter(
    (r): r is string => r !== null && r !== "",
  );

  let seq = 1;
  for (const reply of replies) {
    await replyGroupMessage(event.groupOpenid, reply, event.msgId, seq);
    seq += 1;
  }
}
