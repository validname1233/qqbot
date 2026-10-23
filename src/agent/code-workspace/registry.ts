// agent/code-workspace/registry.ts —— 工作台子 Agent 的独立工具注册表。
// 照 deep-search/registry.ts 的隔离模式：与全局表（agent/registry.ts）刻意分开，
// 六件套绝不进全局表——日常 /Agent 的模型看不到它们，工作台子 Agent 也只看这六个。
// 与深检表的差异：结果落 detail 日志时只记摘要（方案 §3.9——执行类工具的代码
// 全文与完整 stdout 默认不落盘，代码/输出可能含敏感内容且体量大）。

import type { MessageContext } from "../../types.js";
import type { Tool } from "../tool.js";
import type { ToolSchema } from "../types.js";
import { readFileTool } from "./tools/read-file.js";
import { writeFileTool } from "./tools/write-file.js";
import { editFileTool } from "./tools/edit-file.js";
import { globTool } from "./tools/glob.js";
import { grepTool } from "./tools/grep.js";
import { execTool } from "./tools/exec.js";
import { emitProgress } from "../../services/progress-bus.js";
import { config } from "../../config.js";
import { logger } from "../../services/logger.js";

const tools = new Map<string, Tool>();

export function registerTool(tool: Tool): void {
  tools.set(tool.name, tool);
}

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

// 按名字执行。工具自己 catch 成可自纠文案（与深检同款约定——"工具执行失败"
// 统一兜底会抹掉自愈信号，模型要靠具体错误信息修正下一轮）。
export async function runTool(
  name: string,
  args: Record<string, unknown>,
  ctx: MessageContext,
): Promise<string> {
  const tool = tools.get(name);
  if (tool === undefined) {
    return `没有名为 ${name} 的工具，可用：${[...tools.keys()].join("、")}。`;
  }
  if (tool.progressNote !== undefined) {
    emitProgress(
      ctx.event,
      typeof tool.progressNote === "string" ? tool.progressNote : tool.progressNote(args),
    );
  }
  const t0 = Date.now();
  const argSummary = JSON.stringify(args).slice(0, 60);
  const result = await tool.run(args, ctx);
  logger.node("tool", `→ ${name}(${argSummary}) 完成 (+${Date.now() - t0}ms, ${result.length} 字)`);
  // 摘要日志（方案 §3.9）：结果只记头 120 字符，全文不落盘——执行输出可能很大
  // 且可能含敏感内容；排错需要全文时用下面的 debug 全量流水。
  logger.detail("tool", `name=${name} args=${argSummary}\n结果摘要：${result.slice(0, 120)}`);
  // debug 全量流水：LOG_LEVEL=debug 时，完整参数与完整结果落文件日志——排查
  // "模型到底发了什么命令、拿到了什么"。两个选择各有理由：
  //   detail 通道而非 logger.debug()——detail 只进文件，不会把 64KB 的 exec
  //     输出刷上 pm2 控制台（debug() 是 trace 事件，LOG_LEVEL=debug 时进控制台）；
  //   logLevel===debug 门控——默认 info 时不产生任何输出，维持 §3.9
  //     "全量含用户数据、默认不落盘"的决策，排查时知情打开、用完即关。
  if (config.logLevel === "debug") {
    const cap = 256 * 1024; // 单条上限：write_file 的 content 可达 1MB，防日志膨胀
    const clip = (s: string): string =>
      s.length > cap ? `${s.slice(0, cap)}\n[全量已截断，原文 ${s.length} 字符]` : s;
    logger.detail("tool", `name=${name}\nargs 全文：${clip(JSON.stringify(args))}\n结果全文：${clip(result)}`);
  }
  return result;
}

registerTool(readFileTool);
registerTool(writeFileTool);
registerTool(editFileTool);
registerTool(globTool);
registerTool(grepTool);
registerTool(execTool);
