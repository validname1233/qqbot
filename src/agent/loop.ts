// agent/loop.ts —— agent 的核心流程：用 for 循环撑住"可能多轮工具调用"的骨架，
//   循环轮数目前固定为 MAX_TOOL_TURNS = 1。以后想让模型连续调多轮工具，
//   改这个数字就行，不用动循环结构。
//   每轮：带 tools 调模型 —— 模型直接给文本就存进 reply 并 break；
//         模型给 tool_calls 就本地并发执行，结果拼回 messages，进入下一轮。
//   如果轮数用完了 reply 还是空（最后一轮模型给的还是 tool_calls，没来得及看到
//   工具结果就没轮次了），循环外再补一次不带 tools 的调用，逼模型看着工具结果
//   给出最终文本——这正是 MAX_TOOL_TURNS = 1 时的常见路径。
//
// 记忆：只存「短期记忆」（最近若干条消息），键用现成的 sessionKey(ctx.event)，
// 和状态机共享同一套「每人每场景」隔离粒度。长期记忆（数据库、跨会话）本次不做。

import type { MessageContext } from "../types.js";
import { sessionKey } from "../session/key.js";
import { callModelWithTools } from "./client.js";
import { runTool, toolSchemas } from "./registry.js";
import { inMemoryStore } from "./memory/in-memory.js";
import type { ChatMessage } from "./types.js";

const AGENT_SYSTEM_PROMPT =
  "你是一个可以调用工具完成任务的助手。需要用工具才能完成的请求，请调用合适的工具；不需要工具的问题直接正常回答即可。";

// 工具调用最多几轮。1 表示：调一次工具就必须收尾，不允许模型看完工具结果又申请下一轮工具。
const MAX_TOOL_TURNS = 1;

// 循环轮次用完但还没拿到最终文本时的收尾：单独拼一段提示词——人设 + 用户原始需求 +
// 工具结果——不带聊天历史、不带 tools，逼模型只根据这些信息给出一段干净的最终回复。
// 单开一个函数是因为这段提示词本身有点长，混在 runAgentTurn 里会显得臃肿。
async function synthesizeFinalReply(
  userText: string,
  history: ChatMessage[],
  toolResults: ChatMessage[],
): Promise<string> {
  const historyText =
    history.length === 0
      ? "（无历史对话）"
      : history
          .map((msg) => `${msg.role}：${msg.content ?? "(无内容)"}`)
          .join("\n");

  const toolResultsText = toolResults
    .map((msg, i) => `工具结果 ${i + 1}：${msg.content ?? "(无内容)"}`)
    .join("\n\n");

  const prompt = `${AGENT_SYSTEM_PROMPT}

以下是最近的对话记录（供参考上下文）：
${historyText}

用户现在想要实现的需求是：${userText}

以下是为完成这个需求而调用工具得到的结果：
${toolResultsText}

请你根据以上对话记录和工具结果，直接给用户一段完整、自然的最终回复，不要再调用任何工具。`;

  const final = await callModelWithTools([{ role: "user", content: prompt }]);
  return final.content ?? "（Agent 没有返回内容）";
}

export async function runAgentTurn(
  userText: string,
  ctx: MessageContext,
): Promise<string> {
  const key = sessionKey(ctx.event);
  const history = await inMemoryStore.get(key);

  const userMessage: ChatMessage = { role: "user", content: userText };
  const messages: ChatMessage[] = [
    { role: "system", content: AGENT_SYSTEM_PROMPT },
    ...history,
    userMessage,
  ];

  let reply: string | null = null;
  const allToolMessages: ChatMessage[] = [];

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    const response = await callModelWithTools(messages, toolSchemas());

    // 模型没有发起工具调用：这就是最终回复，收尾退出循环。
    if (response.tool_calls === undefined || response.tool_calls.length === 0) {
      reply = response.content ?? "（Agent 没有返回内容）";
      messages.push({ role: "assistant", content: reply });
      break;
    }

    // 模型发起了工具调用：本地并发执行，每个结果包成一条 role:"tool" 消息，
    // 拼回 messages 后进入下一轮循环（如果还有轮次剩余）。
    // 单个工具失败不影响其它工具——runTool 内部已把异常兜成固定短语"工具执行失败"。
    const toolCalls = response.tool_calls;
    messages.push({
      role: "assistant",
      content: response.content,
      tool_calls: toolCalls,
    });

    const toolMessages = await Promise.all(
      toolCalls.map(async (call): Promise<ChatMessage> => {
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(call.function.arguments) as Record<string, unknown>;
        } catch {
          args = {};
        }
        const result = await runTool(call.function.name, args, ctx);
        return { role: "tool", content: result, tool_call_id: call.id };
      }),
    );
    messages.push(...toolMessages);
    allToolMessages.push(...toolMessages);
  }

  // 轮次用完，模型最后一次给的还是 tool_calls：单独整理一段「人设+需求+工具结果」
  // 的提示词，逼模型只根据这些信息给出最终文本。
  if (reply === null) {
    reply = await synthesizeFinalReply(userText, history, allToolMessages);
    messages.push({ role: "assistant", content: reply });
  }

  // messages 里 [0] 是 system prompt，[1..history.length] 是历史，
  // 从 userMessage 开始往后的都是这一轮新增的——直接切片存进短期记忆。
  await inMemoryStore.append(key, ...messages.slice(1 + history.length));

  return reply;
}
