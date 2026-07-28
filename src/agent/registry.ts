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

// 按名字执行一个工具。名字不存在或 run 抛错，都统一在这里兜成"工具执行失败"——
// 具体原因打日志排查，回给模型的内容保持固定短语，简单可靠。
export async function runTool(
  name: string,
  args: Record<string, unknown>,
  ctx: MessageContext,
): Promise<string> {
  const tool = tools.get(name);
  if (tool === undefined) {
    console.error(`[agent:tool] 未知工具：${name}`);
    return "工具执行失败";
  }
  try {
    return await tool.run(args, ctx);
  } catch (err) {
    console.error(`[agent:tool:${name}] 执行出错:`, err);
    return "工具执行失败";
  }
}
