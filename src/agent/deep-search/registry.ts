// agent/deep-search/registry.ts —— 深检图的独立工具注册表。
// 和 agent/registry.ts（全局注册表）刻意分开：全局表是单例，loop.ts 的 toolSchemas()
// 拿的是"全部注册工具"，深检工具如果注册进去会被日常 /Agent 的闲聊模型看到——
// 违背"深检必须显式命令触发"的隔离设计（总设计 §3.1/§4）。
// 接口形状与全局表一致（registerTool / toolSchemas / runTool），loop.ts 式的调用习惯
// 可以直接照搬过来；差异是 runTool 不做"工具执行失败"统一兜底——深检工具自己
// catch 成细粒度文案（如"打开 xxx 失败：403，可改用 interact_page"），模型靠这些
// 文案自愈重试，统一兜底会抹掉自愈信号。

import type { MessageContext } from "../../types.js";
import type { Tool } from "../tool.js";
import type { ToolSchema } from "../types.js";
import { openPageTool } from "../tools/open-page.js";
import { interactPageTool } from "../tools/interact-page.js";
import { searchTool } from "../tools/search.js";
import { emitProgress } from "../../services/progress-bus.js";
import { applyArgInjector } from "../tools/arg-injectors.js";
import { logger } from "../../services/logger.js";

const tools = new Map<string, Tool>();

export function registerTool(tool: Tool): void {
  tools.set(tool.name, tool);
}

// 发给模型的 tools 字段：把注册过的工具逐个转成 ToolSchema 形状（与全局表同款）。
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

// 按名字执行一个工具。名字不存在仍返回固定提示（模型读到可换工具），
// 但 run 的异常不兜底——注册进来的深检工具约定自己 catch（见文件头注释）。
export async function runTool(
  name: string,
  args: Record<string, unknown>,
  ctx: MessageContext,
): Promise<string> {
  const tool = tools.get(name);
  if (tool === undefined) {
    return `没有名为 ${name} 的工具，可用：${[...tools.keys()].join("、")}。`;
  }
  // 进度推送切面（progress-bus）：深检一期未挂订阅，emit 到无订阅者是 no-op；
  // 切面先埋好，二期 runDeepSearch 挂订阅即生效（方案 §4）。
  if (tool.progressNote !== undefined) {
    emitProgress(
      ctx.event,
      typeof tool.progressNote === "string" ? tool.progressNote : tool.progressNote(args),
    );
  }
  // 参数净化切面：与全局注册表同款（arg-injectors.ts 统一机制，两张表一体生效）。
  const finalArgs = applyArgInjector(name, args, ctx);
  const result = await tool.run(finalArgs, ctx);
  // detail 流水：工具结果全文（与全局 runTool 同款打点）。
  logger.detail("tool", `name=${name} args=${JSON.stringify(finalArgs)}\n结果全文：${result}`);
  return result;
}

registerTool(openPageTool);
registerTool(interactPageTool);
// search 也进深检表：planNode 自寻起点（无 URL 入口）要用——起点检索由确定性
// 代码移交给模型判断（用户方案：planNode 带三工具，自行决定搜什么、搜几次）。
// searchTool 同时注册在全局表（/Agent 用），双表共用同一对象，零额外维护。
registerTool(searchTool);
