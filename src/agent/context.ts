// agent/context.ts —— 「记忆装配」模块：单聊/群聊在 Agent 链路里的差异全部收在这里，
// 对外只暴露两个函数，loop.ts 的节点只管调用，不用各自判断 event.type。
//
// 两个函数各管一件事，互不依赖：
//   formatSpeakerContent    —— 短期记忆的说话人格式化（写入时做一次，读取不再二次加工）
//   buildLongTermContextText —— 长期记忆注入文本，读 long-term.ts 该租户键下的全部记忆
//
// 租户键（tenantKey）已在 2026-10-14 键统一中收编至 session/key.ts——本文件曾经的
// memoryKey 与其值完全相同（群一群一份/单聊一人一份），是统一的历史来源之一。

import type { BotEvent } from "../events/registry.js";
import { longTermMemoryStore } from "./memory/long-term.js";
import { tenantKey } from "../session/key.js";
import { pushC2CMessage, pushGroupMessage } from "../qq/messages.js";

// 短期记忆的说话人格式化：所有场景统一在 content 前拼"昵称："，不再区分群聊/单聊——
// 单聊也拼是为了让"昵称："前缀成为恒定格式，functional.ts 的 SPEAKER_NOTE 才能写成
// 一条无分支的通用规则（不用再解释"单聊没有前缀"的例外），agent_judge 等共用场景
// 的提示词也无需按场景分叉。只在"写入"这一个时机调用一次（loop.ts 的 prepareContext
// 节点构造 userMessage 时），存进短期记忆的内容已经带前缀，之后 sqlite.ts 读取
// 不再二次处理，避免重复拼接。群成员昵称可能为空（C2C 事件示例里 username 就是
// 空串），空时用"用户"兜底，保证前缀格式恒存在。
export function formatSpeakerContent(
  content: string,
  authorName: string,
  _event: BotEvent,
): string {
  const speaker = authorName.trim() !== "" ? authorName : "用户";
  return `${speaker}：${content}`;
}

// 长期记忆注入文本。单聊/群聊不分支：都是对 tenantKey(event) 这个 key 下的记忆做
// RAG 相关度召回（queryText 做 embedding 查询，见 memory/long-term.ts 的 search()），
// 取 top-K 条格式化成一段 system 文本。
// 单聊场景下"由XX记录"的 XX 恒等于该用户自己，信息冗余但无害，不必为此单独分支。
const TOP_K = 5;

export async function buildLongTermContextText(event: BotEvent, queryText: string): Promise<string> {
  const memories = await longTermMemoryStore.search(tenantKey(event), queryText, TOP_K);
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
