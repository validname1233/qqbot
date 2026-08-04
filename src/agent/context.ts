// agent/context.ts —— 「记忆装配」模块：单聊/群聊在 Agent 链路里的差异全部收在这里，
// 对外只暴露三个函数，loop.ts 的节点只管调用，不用各自判断 event.type。
//
// 三个函数各管一件事，互不依赖：
//   memoryKey               —— 短期记忆的会话键（隔离粒度）
//   formatSpeakerContent    —— 短期记忆的说话人格式化（写入时做一次，读取不再二次加工）
//   buildLongTermContextText —— 长期记忆注入文本（本次占位，恒定返回空字符串）

import type { BotEvent } from "../events/registry.js";

// 记忆专用的会话键：和状态机用的 sessionKey() 故意不同粒度。
// sessionKey() 群聊分支带 authorOpenid（群里各人独立锁状态机，互不干扰），
// 但记忆要的是"整群共享一份窗口"（AI 能看到群里其他人跟机器人说过什么），
// 所以这里把群聊的 authorOpenid 去掉，只保留 group:<groupOpenid>；
// 单聊没有这个问题，直接复用 sessionKey() 的结果。
// 不改 sessionKey() 本身：它同时被 session/runner.ts 的状态机锁定逻辑复用，
// 那边需要的仍然是"每人每群"的隔离粒度，两者语义不同，不能合并成一个函数。
export function memoryKey(event: BotEvent): string {
  if (event.type === "GROUP_AT_MESSAGE_CREATE" || event.type === "GROUP_MESSAGE_CREATE") {
    return `group:${event.groupOpenid}`;
  }
  return `c2c:${event.authorOpenid}`;
}

// 短期记忆的说话人格式化：群聊场景在 content 前拼"昵称："，单聊原样返回。
// 只在"写入"这一个时机调用一次（loop.ts 的 prepareContext 节点构造 userMessage 时），
// 存进短期记忆的内容已经带前缀，之后 sqlite.ts 读取不再二次处理，避免重复拼接。
export function formatSpeakerContent(
  content: string,
  authorName: string,
  event: BotEvent,
): string {
  if (event.type !== "GROUP_AT_MESSAGE_CREATE" && event.type !== "GROUP_MESSAGE_CREATE") {
    return content;
  }
  return `${authorName}：${content}`;
}

// 长期记忆注入文本。单聊：本人人格画像 + 关键事实；群聊：群公共关键事实
// （未来可能还有发言者本人的人格画像）。两种场景的内容来源不同，但对调用方
// 是同一个注入点、同一种字符串形态，因此对外只留一个函数签名，内部将来按
// event.type 分支取数据源。本次仅占位，恒定返回空字符串——真实实现见
// docs/long-term-memory-plan.md（该文档的单聊/群聊假设需要在实现时一并更新）。
export async function buildLongTermContextText(event: BotEvent): Promise<string> {
  return "";
}
