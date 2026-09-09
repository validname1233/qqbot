// agent/registry.ts —— 工具的注册中心（照抄 src/registry.ts 里 CommandService 那套 Map 思路）。
// loop.ts 只跟这里打交道：拿 schemas 发给模型、按名字执行工具，不认识任何具体工具实现。

import type { MessageContext } from "../types.js";
import type { Tool } from "./tool.js";
import type { ToolSchema } from "./types.js";

const tools = new Map<string, Tool>();

export function registerTool(tool: Tool): void {
  tools.set(tool.name, tool);
}

// 发给模型的 tools 字段：把注册过的工具逐个转成 ToolSchema 形状。
export function toolSchemas(): ToolSchema[] {
  return [...tools.values()].map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

// 声明了 skipMemory 的工具名集合：loop.ts 落库前用它过滤"不该进短期记忆"的
// tool 消息（身份判定走 tool_call_id 反查，不猜内容）。每次调用现算——工具表
// 是启动期注册的小 Map，几十次落库调用各建一个 Set 的成本可忽略，不值得缓存。
export function memoryExemptToolNames(): Set<string> {
  return new Set(
    [...tools.values()].filter((tool) => tool.skipMemory === true).map((tool) => tool.name),
  );
}

// 按名字执行一个工具。名字不存在或 run 抛错，都统一在这里兜成"工具执行失败"，
// 回给模型的内容保持固定短语，简单可靠。
export async function runTool(
  name: string,
  args: Record<string, unknown>,
  ctx: MessageContext,
): Promise<string> {
  const tool = tools.get(name);
  if (tool === undefined) {
    return "工具执行失败";
  }
  try {
    return await tool.run(args, ctx);
  } catch {
    return "工具执行失败";
  }
}
