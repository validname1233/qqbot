// agent/tool.ts —— 工具的统一契约。
// 和 CommandService 的关键区别：CommandService.handle 拿到的是用户直接打的原始字符串
// （args），而 Tool.run 拿到的是模型按 parameters（JSON Schema）自己决定吐出来的结构化参数——
// 调不调、传什么，都是模型在这一轮对话里自主判断的，不是用户手打命令。

import type { MessageContext } from "../types.js";

export interface Tool {
  name: string; // 工具名，模型靠它发起调用，同时是 registry 里的键
  description: string; // 给模型看的自然语言描述，决定模型「什么时候该调它」
  parameters: Record<string, unknown>; // JSON Schema，随请求一起发给模型，约束参数形状
  // 可选声明：true = 该工具的 tool 结果消息不落短期记忆（loop.ts 落库时按
  // tool_call_id 反查工具名后查这里的名单，见 registry.ts 的 memoryExemptToolNames）。
  // 适用场景：工具返回的是"已有记忆的复印件"或超大正文，入库会挤爆热窗口、
  // 污染后续检索。默认缺省 = 照常入库（所有既有工具行为不变）。
  skipMemory?: boolean;
  run(args: Record<string, unknown>, ctx: MessageContext): Promise<string>;
}
