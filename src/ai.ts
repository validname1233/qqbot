// ai.ts —— 调用大模型对话接口（硅基流动 SiliconFlow）。
// 职责单一：给一句用户输入，返回模型的回复文本。
// 和 messages.ts 平级：那个是"把消息发回 QQ"，这个是"问大模型"，都是对外部服务的调用。
// handler 只管"要不要调、拿到回复怎么用"，不关心这里的 URL、鉴权、body 细节。

import { config } from "./config.js";

const API_URL = "https://api.siliconflow.cn/v1/chat/completions";

// 模型返回的结构里，我们只关心 choices[0].message.content。
// 只声明用得到的字段，其余忽略——比把整个响应类型写全省事，也够安全。
interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

// 问一句，得一句。system 提示词固定，messages 只带当前这一句 user 输入——
// 也就是"无上下文的单轮对话"。以后要多轮记忆，再把历史消息拼进 messages 数组。
export async function askAI(userText: string): Promise<string> {
  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.aiApiKey}`,
    },
    body: JSON.stringify({
      model: config.aiModel,
      messages: [
        { role: "system", content: "你是一个有用的助手。" },
        { role: "user", content: userText },
      ],
    }),
  });

  // fetch 不会因 4xx/5xx 抛错，要自己检查 response.ok（这点和 QQ 那边不同，需留意）。
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`AI 接口返回 ${response.status}: ${detail}`);
  }

  // response.json() 的返回类型是 any/unknown，用 as 断言成我们声明的形状。
  const data = (await response.json()) as ChatCompletionResponse;
  const reply = data.choices?.[0]?.message?.content;

  // 万一模型返回了空内容，给个兜底文案，别让用户收到空消息。
  if (reply === undefined || reply === "") {
    return "（AI 没有返回内容）";
  }
  return reply;
}
