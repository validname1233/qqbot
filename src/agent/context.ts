// agent/context.ts —— 「记忆装配」模块：单聊/群聊在 Agent 链路里的差异全部收在这里，
// 对外只暴露三个函数，loop.ts 的节点只管调用，不用各自判断 event.type。
//
// 三个函数各管一件事，互不依赖：
//   memoryKey               —— 短期记忆/长期记忆共用的会话键（隔离粒度）
//   formatSpeakerContent    —— 短期记忆的说话人格式化（写入时做一次，读取不再二次加工）
//   buildLongTermContextText —— 长期记忆注入文本，读 long-term.ts 该 key 下的全部记忆

import type { BotEvent } from "../events/registry.js";
import { longTermMemoryStore } from "./memory/long-term.js";
import { pushC2CMessage, pushGroupMessage } from "../qq/messages.js";

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

// 长期记忆注入文本。单聊/群聊不分支：都是对 memoryKey(event) 这个 key 下的记忆做
// RAG 相关度召回（queryText 做 embedding 查询，见 memory/long-term.ts 的 search()），
// 取 top-K 条格式化成一段 system 文本。
// 单聊场景下"由XX记录"的 XX 恒等于该用户自己，信息冗余但无害，不必为此单独分支。
const TOP_K = 5;

export async function buildLongTermContextText(event: BotEvent, queryText: string): Promise<string> {
  const memories = await longTermMemoryStore.search(memoryKey(event), queryText, TOP_K);
  if (memories.length === 0) {
    return "";
  }
  const lines = memories.map((m) => `- （由${m.authorName}记录）${m.content}`);
  return `以下是关于当前对话的长期记忆（可能有助于理解上下文）：\n${lines.join("\n")}`;
}

// 长期记忆增删的主动通知：单聊推给对应用户，群聊推回对应群。复用现有的主动推送
// service（pushC2CMessage/pushGroupMessage），不依附于某条消息（不带 msgId），
// 所以这里不是"回复"，是独立的一条主动消息——和 add_memory/delete_memory 工具
// return 给模型的确认话术是两件事：return 值会被模型拼进这一轮的最终回复，
// 这里另外单独发一条，确保"记忆变更"这件事本身有一条明确、格式固定的通知。
export async function pushMemoryNotice(event: BotEvent, text: string): Promise<void> {
  if (event.type === "GROUP_AT_MESSAGE_CREATE" || event.type === "GROUP_MESSAGE_CREATE") {
    await pushGroupMessage(event.groupOpenid, text);
    return;
  }
  await pushC2CMessage(event.authorOpenid, text);
}
