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
export async function callModelWithTools(
  messages: ChatMessage[],
  tools?: ToolSchema[],
  model: string = config.aiModel,
  enableThinking: boolean = false,
): Promise<ChatMessage> {
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

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`AI 接口返回 ${response.status}: ${detail}`);
  }

  const data = (await response.json()) as ChatCompletionResponse;
  const message = data.choices?.[0]?.message;
  if (message === undefined) {
    throw new Error("AI 接口返回里没有 message 字段");
  }
  return message;
}
