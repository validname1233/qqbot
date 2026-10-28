// agent/registry.ts —— 工具的注册中心（照抄 src/registry.ts 里 CommandService 那套 Map 思路）。
// loop.ts 只跟这里打交道：拿 schemas 发给模型、按名字执行工具，不认识任何具体工具实现。

import type { MessageContext } from "../types.js";
import type { Tool } from "./tool.js";
import type { ToolSchema } from "./types.js";
import { emitProgress } from "../services/progress-bus.js";
import { applyArgInjector, stripHiddenParams } from "./tools/arg-injectors.js";
import { logger } from "../services/logger.js";

const tools = new Map<string, Tool>();

export function registerTool(tool: Tool): void {
  tools.set(tool.name, tool);
}

// 发给模型的 tools 字段：把注册过的工具逐个转成 ToolSchema 形状。
// parameters 过 stripHiddenParams：声明了 hideFromModel 的工具（如租户身份
// 字段）在渲染时剔除——模型看不见的字段就不会试着填，注入器的覆盖成为
// 双保险而不是唯一防线。
export function toolSchemas(): ToolSchema[] {
  return [...tools.values()].map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: stripHiddenParams(tool.name, tool.parameters),
    },
  }));
}

// 按名字执行一个工具。名字不存在或 run 抛错，都统一在这里兜成"工具执行失败"，
// 回给模型的内容保持固定短语，简单可靠。
// 进度推送切面（progress-bus.ts）：声明了 progressNote 的工具在执行前 emit 一条
// 进度文案，无订阅者（非 /Agent 请求期间）时 no-op。推送失败由 bus 内部兜住，
// 不影响工具执行。
export async function runTool(
  name: string,
  args: Record<string, unknown>,
  ctx: MessageContext,
): Promise<string> {
  const tool = tools.get(name);
  if (tool === undefined) {
    return "工具执行失败";
  }
  if (tool.progressNote !== undefined) {
    emitProgress(
      ctx.event,
      typeof tool.progressNote === "string" ? tool.progressNote : tool.progressNote(args),
    );
  }
  // 参数净化切面（arg-injectors.ts，租户身份透传的统一机制）：命中注入表的
  // 工具在执行前改写 args（身份字段无条件覆盖模型传参）。原生与 MCP 工具
  // 经同一处分发，机制对两者一体生效；未注册的工具原样透传。
  const finalArgs = applyArgInjector(name, args, ctx);
  // 轨迹行（控制台）：工具进出的一行结论——名称 + 参数摘要（≤60 字，正文不进
  // 控制台）。耗时以"开始→完成"计（progressNote 的推送也算在执行前，与它分工：
  // bus 给用户推送，node 给运维留迹）。
  const t0 = Date.now();
  const argSummary = JSON.stringify(finalArgs).slice(0, 60);
  try {
    const result = await tool.run(finalArgs, ctx);
    logger.node("tool", `→ ${name}(${argSummary}) 完成 (+${Date.now() - t0}ms, ${result.length} 字)`);
    // detail 流水（只进文件）：工具结果全文不截断。打点在注册表层（与
    // progressNote/参数净化同层）——所有原生与 MCP 工具的结果统一在此留痕。
    logger.detail("tool", `name=${name} args=${JSON.stringify(finalArgs)}\n结果全文：${result}`);
    return result;
  } catch {
    logger.warn("tool", `→ ${name}(${argSummary}) 执行失败 (+${Date.now() - t0}ms)`);
    return "工具执行失败";
  }
}
