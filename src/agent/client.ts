// agent/client.ts —— 调用大模型的底层传输，agent 专用，和 services/ai.ts 的 askAI 分开。
// 区别于 askAI：这里要发 tools 字段、要读回完整的 assistant message（可能带 tool_calls），
// 而 askAI 的响应类型只声明了 content，装不下 tool_calls，所以单独定义一份响应类型。

import { config } from "../config.js";
import type { ChatMessage, ToolSchema } from "./types.js";

const API_URL = "https://api.siliconflow.cn/v1/chat/completions";

interface ChatCompletionResponse {
  choices?: Array<{ message?: ChatMessage }>;
}

// tools 传 undefined（或省略）时，请求体里就不带 tools 字段——
// 这是 loop.ts 实现"第二轮强制不再调用工具"的手段：不传 tools，模型就没有工具可选，
// 只能老实吐文本，天然达成"循环一次就出最终成果"，不需要 while 循环或轮次上限。
// model 选填：不传就用普通对话模型（config.aiModel）；传了就换成指定模型——
// 目前 loop.ts 只在 synthesizeFinalReply 收尾时传 config.agentModel，换一个更强的模型。
// enableThinking 选填：默认 false（工具调用判断不需要，思考只会拖慢速度）；
// synthesizeFinalReply 收尾时传 true，让模型多想一步再给最终回复。
// content 常常很长（人设回复、finalize 阶段拼的大段提示词回复），日志里全打出来会刷屏，
// 只截前 150 字，够看出这次回复大致是什么内容即可。
function truncateContent(content: string | null): string {
  if (content === null) {
    return "null";
  }
  return content.length > 150 ? `${content.slice(0, 150)}...` : content;
}

// label：调用方传入的标识（通常是发起调用的节点名，如 "llmCall"/"plainReply"），
// 纯粹用来在日志里区分"这次调用是谁发起的"，不影响请求内容，不传就打印 "unknown"。
export async function callModel(
  messages: ChatMessage[],
  tools?: ToolSchema[],
  model: string = config.aiModel,
  enableThinking: boolean = false,
  label = "unknown",
): Promise<ChatMessage> {
  const t0 = Date.now();
  console.debug(
    `[agent:debug] [${label}] 请求大模型调用 model=${model} enableThinking=${enableThinking} tools=${tools?.length ?? 0} messages=${messages.length}`,
  );

  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.aiApiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
      enable_thinking: enableThinking,
    }),
  });

  const elapsed = Date.now() - t0;

  if (!response.ok) {
    const detail = await response.text();
    console.debug(`[agent:debug] [${label}] 大模型调用失败 (+${elapsed}ms) status=${response.status} detail=${detail}`);
    throw new Error(`AI 接口返回 ${response.status}: ${detail}`);
  }

  const data = (await response.json()) as ChatCompletionResponse;
  const message = data.choices?.[0]?.message;
  if (message === undefined) {
    console.debug(`[agent:debug] [${label}] 大模型调用失败 (+${elapsed}ms) 返回里没有 message 字段`);
    throw new Error("AI 接口返回里没有 message 字段");
  }

  // tool_calls 只打印名字+参数（不打 id，排查时用不上，反而占地方）。
  const toolCallsSummary =
    message.tool_calls === undefined
      ? "无"
      : message.tool_calls.map((call) => `${call.function.name}(${call.function.arguments})`).join(", ");
  console.debug(
    `[agent:debug] [${label}] 大模型调用返回 (+${elapsed}ms) content=${truncateContent(message.content)} tool_calls=${toolCallsSummary}`,
  );

  return message;
}
