// handlers/C2C_MESSAGE_CREATE.ts —— 单聊消息的编排层。
// 它不认识任何具体功能，只做两件事：
//   ① 跑一次命令路由（二选一：命中的命令，或兜底聊天）
//   ② 跑一遍所有观察者（全体，如成就统计）
// 具体功能全部登记在 services/registry 里，加功能时本文件一行都不用改。
//
// 统一约定：每个 handler 都长成 handleXxx(event): Promise<void>——
// 输入一个强类型事件，自己负责回消息，不返回值。签名统一，dispatcher 才能一致地调。

import type { C2CMessageEvent } from "../events/C2C_MESSAGE_CREATE/index.js";
import { replyC2CMessage, replyC2CMarkdown } from "../qq/messages.js";
import { logger } from "../services/logger.js";
import {
  buildContext,
  runCommand,
  runObservers,
} from "../registry.js";

export async function handleC2CMessage(event: C2CMessageEvent): Promise<void> {
  // 消息只解析一次，命令和观察者共用这个 context。
  const ctx = buildContext(event);

  // 命令路由和观察者互不依赖，并发跑。
  // runCommand 最多产出一条回复，runObservers 可能产出多条。
  const [commandReply, observerReplies] = await Promise.all([
    runCommand(ctx),
    runObservers(ctx),
  ]);

  // 汇总所有想说的话，过滤掉 null / 空串。命令回复排在观察者之前。
  const replies = [commandReply, ...observerReplies].filter(
    (r): r is string => r !== null && r !== "",
  );

  // Markdown 优先，失败回退纯文本。单聊客户端的 Markdown 渲染支持不如群聊稳定，
  // 回退尤其重要——宁可降级成纯文本也不能让回复丢失。
  let seq = 1;
  for (const reply of replies) {
    try {
      await replyC2CMarkdown(event.authorOpenid, reply, event.msgId, seq);
    } catch (err) {
      logger.warn(
        "webhook",
        `单聊 Markdown 回复失败，回退纯文本（msgId=${event.msgId} seq=${seq}）: ${err instanceof Error ? err.message : err}`,
      );
      await replyC2CMessage(event.authorOpenid, reply, event.msgId, seq);
    }
    seq += 1;
  }
}
