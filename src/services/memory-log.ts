// services/memory-log.ts —— 观察型 service：把没有命中任何命令的群聊消息按顺序落库，
// 让 /Agent 未来能看到"群里其他人说过什么"，不止是过去 /Agent 自己的问答记录。
//
// 为什么只处理 ctx.command === null 的消息：命令型消息（如 /Agent ...）已经在各自
// service 的处理链路里落过库了（/Agent 见 agent/loop.ts 的 runAgentTurn），这里再记
// 一遍会导致同一句话重复入库。command === null 和 command !== null 天然不重叠，
// 两条写入路径互不打架，不需要额外加锁或去重判断。

import type { ObserverService } from "../types.js";
import { memoryKey, formatSpeakerContent } from "../agent/context.js";
import { sqliteMemoryStore } from "../agent/memory/sqlite.js";

export const memoryLogObserver: ObserverService = {
  name: "记忆落库",

  async observe(ctx): Promise<string | null> {
    if (ctx.command !== null) {
      return null;
    }

    const event = ctx.event;
    const content = formatSpeakerContent(ctx.text, event.authorName, event);
    await sqliteMemoryStore.append(
      memoryKey(event),
      { openid: event.authorOpenid, name: event.authorName },
      { role: "user", content },
    );
    return null;
  },
};
