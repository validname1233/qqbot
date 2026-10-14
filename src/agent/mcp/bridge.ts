// agent/mcp/bridge.ts —— 桥接层（设计方案 §3.2/§3.3）：MCP 工具定义 → 本项目 Tool 契约。
// 模型对 MCP 的存在无感知：工具表里它就是一个普通工具，run 内部转发 tools/call，
// 结果拍扁成字符串（Tool 契约是 Promise<string>）再过适配器加工。
//
// 错误约定：一切失败转成可自愈文案返回，绝不抛异常——抛了会撞上全局 runTool 的
// "工具执行失败"统一兜底，抹掉"服务器没连上/超时"这类对模型有用的细节。

import type { Tool } from "../tool.js";
import type { MessageContext } from "../../types.js";
import { callTool, type McpToolDefinition } from "./client.js";
import { getAdapter } from "./adapters.js";
import { stripHiddenParams } from "../tools/arg-injectors.js";
import { logger } from "../../services/logger.js";

// 未配置 progressNotes 的 MCP 工具的默认进度文案（配置驱动优先，这是兜底）
const DEFAULT_PROGRESS_NOTE = "正在调用远程工具…";

// 前置参数注入已上浮为统一机制（tools/arg-injectors.ts + 两个注册表的
// runTool 净化切面）：key 用 MCP 包装名（mcp_<server>_<tool>），kb_search
// 的 scope 注入器也注册在那里。本文件只保留 schema 剥离的接线——server 端
// 声明的 inputSchema 我们改不了，包装成 Tool 时过一遍 stripHiddenParams，
// 声明了 hideFromModel 的字段（如 scope）不进模型视野。

// 拍扁层：MCP 结构化 content → 字符串（§3.3）。
// text 块取文字拼接；image/resource 块给占位说明（本链路识图走懒加载管线，
// 不吃 base64）；isError 时包装成带指引的文案（模型可据此放弃或换工具）。
export function flattenMcpResult(result: {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}): string {
  const blocks = result.content ?? [];
  const texts = blocks.filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string);
  const others = blocks.filter((b) => b.type !== "text");

  let text = texts.join("\n");
  if (others.length > 0) {
    const kinds = [...new Set(others.map((b) => b.type))].join("/");
    text += `${text === "" ? "" : "\n"}（另有 ${others.length} 个 ${kinds} 类型的结果块，当前链路暂不支持展示，已省略）`;
  }
  if (text === "") text = "（MCP 工具没有返回文本内容）";

  if (result.isError === true) {
    return `MCP 工具执行出错：${text.slice(0, 500)}。可以调整参数重试，或换用其它工具。`;
  }
  return text;
}

// 桥接核心：包装一个 MCP 工具为本地 Tool（§3.2）。
// name 加 mcp_<server>_ 前缀防与原生工具撞名（DeepSeek 工具名字符集安全）；
// inputSchema 与 parameters 同构直传；ctx 透传给适配器（浏览器类适配器需要
// event 做页面池租户隔离——B 档演进口子）。
// progressNote 来自 mcp.json 该服务器的 progressNotes 配置（工具名 → 文案，
// 与服务器注册同源，不在代码里硬编码工具名）；未配置的工具落默认文案。
export function wrapMcpTool(
  serverName: string,
  mcpTool: McpToolDefinition,
  progressNotes?: Record<string, string>,
): Tool {
  const wrappedName = `mcp_${serverName}_${mcpTool.name}`;
  return {
    name: wrappedName,
    description: mcpTool.description,
    parameters: stripHiddenParams(wrappedName, mcpTool.inputSchema),
    // 进度推送切面（progress-bus）：按 mcp.json 配置取文案（无订阅者时 emit 是 no-op）。
    progressNote: progressNotes?.[mcpTool.name] ?? DEFAULT_PROGRESS_NOTE,

    async run(args: Record<string, unknown>, ctx: MessageContext): Promise<string> {
      const t0 = Date.now();
      // 参数注入由注册表的 runTool 净化切面统一完成（applyArgInjector，
      // 见 tools/arg-injectors.ts）——这里收到的 args 已是净化后的最终参数。
      const outcome = await callTool(serverName, mcpTool.name, args);

      if (!outcome.ok) {
        logger.warn("mcp", `mcp_${serverName}_${mcpTool.name} 调用失败 (+${Date.now() - t0}ms): ${outcome.errorText.slice(0, 150)}`);
        return `${outcome.errorText}。可以稍后重试（服务器可能重启中），或换用其它工具。`;
      }

      const flat = flattenMcpResult(outcome.result);
      const adapted = await getAdapter(serverName, mcpTool.name)(
        flat,
        { server: serverName, tool: mcpTool.name, args },
        ctx,
      );
      logger.node("mcp", `mcp_${serverName}_${mcpTool.name} 完成 (+${Date.now() - t0}ms) 返回 ${adapted.length} 字`);
      return adapted;
    },
  };
}
