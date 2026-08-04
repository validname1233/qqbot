// handlers/GROUP_MESSAGE_CREATE.ts —— 群内全量消息（不限于@机器人）的编排层。
// 结构和 GROUP_AT_MESSAGE_CREATE handler 完全一致：解析 context → 并发跑命令+观察者 → 汇总回复。
// 开启"接收所有消息"后，原来的 @消息也会退化成这个事件（已实测确认），这个 handler
// 就顶替了原来 GROUP_AT_MESSAGE_CREATE handler 的实际职责。两个 handler 暂时并存，
// 是否要合并/是否要区分"有没有@机器人"留给后续设计，不在这次顺手决定。

import type { GroupMessageEvent } from "../events/GROUP_MESSAGE_CREATE/index.js";
import { replyGroupMessage } from "../qq/messages.js";
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

  let seq = 1;
  for (const reply of replies) {
    await replyGroupMessage(event.groupOpenid, reply, event.msgId, seq);
    seq += 1;
  }
}
