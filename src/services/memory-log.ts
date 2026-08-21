// services/memory-log.ts —— 观察型 service：把没有命中任何命令的群聊消息按顺序落库，
// 让 /Agent 未来能看到"群里其他人说过什么"，不止是过去 /Agent 自己的问答记录。
//
// 为什么只处理 ctx.command === null 的消息：命令型消息（如 /Agent ...）已经在各自
// service 的处理链路里落过库了（/Agent 见 agent/loop.ts 的 runAgentTurn），这里再记
// 一遍会导致同一句话重复入库。command === null 和 command !== null 天然不重叠，
// 两条写入路径互不打架，不需要额外加锁或去重判断。
//
// 图片懒加载：普通消息的图片在这下载存盘（不识图，识图延迟到 /Agent 触发）。
// 落库的 content 带 [图片:<id>] 占位符——存"引用"不存描述，/Agent 读取时才展开成
// [图片]{描述}（见 agent/memory/images.ts 的 expandImagePlaceholders）。
// /Agent 消息自带的图片由 agentService.handle 自己持久化，两条路径互不重叠。

import type { ObserverService } from "../types.js";
import { memoryKey, formatSpeakerContent } from "../agent/context.js";
import { sqliteMemoryStore } from "../agent/memory/sqlite.js";
import { persistEventImages } from "../agent/memory/images.js";

// 消息正文 + 图片占位符拼成落库 content：图片占位符在前、文字在后
//（"/Agent 看这只猫"+图 → "[图片:17] 看这只猫"；纯图消息 → "[图片:17]"）。
// 下载失败的图片不产生占位符（persist 没返回它的 id），Agent 无感知降级。
function buildContentWithPlaceholders(text: string, imageIds: number[]): string {
  const parts: string[] = imageIds.map((id) => `[图片:${id}]`);
  if (text !== "") parts.push(text);
  return parts.join(" ");
}

export const memoryLogObserver: ObserverService = {
  name: "记忆落库",

  async observe(ctx): Promise<string | null> {
    if (ctx.command !== null) {
      return null;
    }

    const event = ctx.event;
    // 先下载图片拿占位符 id，再拼 content 落库（顺序不能反，占位符要进 content）。
    // prune 在 persist 内部跑：此刻本条消息还没入库，窗口边界偏旧一格——方向是
    // 少删（新图时间戳最新不会被误删），该删的旧图下轮 prune 补偿，最终一致。
    const imageIds = await persistEventImages(event);
    const content = formatSpeakerContent(
      buildContentWithPlaceholders(ctx.text, imageIds),
      event.authorName,
      event,
    );
    await sqliteMemoryStore.append(
      memoryKey(event),
      { openid: event.authorOpenid, name: event.authorName },
      { role: "user", content },
    );
    return null;
  },
};
