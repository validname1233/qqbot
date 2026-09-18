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
import { logger } from "../../services/logger.js";
import { kbScope } from "../../services/knowledge-base.js";

// 前置参数注入表：key 为 "server:tool"，注入器在 callTool 之前有机会改写 args。
// 与适配器层（后置结果加工）互补——参数层面的强制语义必须发生在调用前，
// 适配器拿到的是结果，改 args 已经晚了。kb_search 的 scope 注入是第一个用户
// （方案 §6.2：租户隔离靠适配器/桥接层，不靠模型传参）。
type ArgInjector = (args: Record<string, unknown>, ctx: MessageContext) => Record<string, unknown>;
const argInjectors = new Map<string, ArgInjector>();

export function registerArgInjector(key: string, injector: ArgInjector): void {
  argInjectors.set(key, injector);
}

function injectMcpArgs(
  serverName: string,
  toolName: string,
  args: Record<string, unknown>,
  ctx: MessageContext,
): Record<string, unknown> {
  const injector = argInjectors.get(`${serverName}:${toolName}`);
  if (injector === undefined) return args;
  return injector(args, ctx);
}

// kb:kb_search —— scope 强制注入（方案 §6.2）：模型传的 scope 一律丢弃，
// 用当前会话事件算出的隔离键覆盖。模型只保留 query/top_k 的发言权。
registerArgInjector("kb:kb_search", (args, ctx) => ({
  ...args,
  scope: kbScope(ctx.event),
}));

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
// event 做页面池人粒度隔离——B 档演进口子）。
export function wrapMcpTool(serverName: string, mcpTool: McpToolDefinition): Tool {
  return {
    name: `mcp_${serverName}_${mcpTool.name}`,
    description: mcpTool.description,
    parameters: mcpTool.inputSchema,

    async run(args: Record<string, unknown>, ctx: MessageContext): Promise<string> {
      const t0 = Date.now();
      // 前置参数注入（kb_search 的 scope 强制覆盖）：租户标识不许模型传参——
      // 模型会瞎编/猜别人的 scope。在进 callTool 之前从当前会话事件算出并覆盖。
      const finalArgs = injectMcpArgs(serverName, mcpTool.name, args, ctx);
      const outcome = await callTool(serverName, mcpTool.name, finalArgs);

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
      logger.debug("mcp", `mcp_${serverName}_${mcpTool.name} 完成 (+${Date.now() - t0}ms) 返回 ${adapted.length} 字`);
      return adapted;
    },
  };
}
