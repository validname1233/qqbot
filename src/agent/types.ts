// agent/types.ts —— agent 内部用到的消息/工具类型，镜像 SiliconFlow（OpenAI 兼容）的
// function-calling 数据形状。loop.ts 用 ChatMessage 拼 messages 数组，memory 存的也是这个类型。

// 模型发起的一次工具调用：带 id（第二轮要用它把结果对应回去）和工具名+参数。
export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // JSON 字符串，模型吐出来的原始参数，用前要自己 JSON.parse
  };
}

// role 用字面量联合，配合可选字段区分几种消息的形状：
// - system/user：只有 content
// - assistant：可能只有 content，也可能带 tool_calls（此时 content 常是 null）
// - tool：必须带 tool_call_id，是对某一次具体工具调用的回答
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

// 发给模型的 tools 字段的形状（SiliconFlow/OpenAI 的 function-calling 契约）。
// client.ts 发请求、registry.ts 组装这个数组时共用同一个类型，避免各写一遍结构。
export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON Schema
  };
}
