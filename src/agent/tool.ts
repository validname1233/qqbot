// agent/tool.ts —— 工具的统一契约。
// 和 CommandService 的关键区别：CommandService.handle 拿到的是用户直接打的原始字符串
// （args），而 Tool.run 拿到的是模型按 parameters（JSON Schema）自己决定吐出来的结构化参数——
// 调不调、传什么，都是模型在这一轮对话里自主判断的，不是用户手打命令。

import type { MessageContext } from "../types.js";

export interface Tool {
  name: string; // 工具名，模型靠它发起调用，同时是 registry 里的键
  description: string; // 给模型看的自然语言描述，决定模型「什么时候该调它」
  parameters: Record<string, unknown>; // JSON Schema，随请求一起发给模型，约束参数形状
  run(args: Record<string, unknown>, ctx: MessageContext): Promise<string>;
}
