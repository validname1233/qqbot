// agent/mcp/adapters.ts —— 适配器层（设计方案 §3.4）：对 MCP 返回内容的加工管线。
// 可插拔、默认直通：不注册适配器的服务器/工具零加工透传（对 GitHub/数据库类
// 原语无害的服务器零成本接入）；不满意的工具按 "server" 或 "server:tool" 注册
// 适配器加工（如浏览器服务器返回原始 HTML → 复用 extractPage 压成三段式）。
//
// 适配器的边界：只救"格式不满意"（太长/太原始/结构不对），救不了"信息已丢失"
// （服务器返回内容本身缺信息——那种要在调用参数或工具选型层面解决）。

import type { MessageContext } from "../../types.js";

// 适配器签名：拿拍扁后的文本 + 调用上下文（服务器/工具/参数）+ 会话 ctx，
// 返回最终给模型的字符串。async 允许做副作用（如浏览器工具的结果入页面池）。
export type McpAdapter = (
  raw: string,
  info: { server: string; tool: string; args: Record<string, unknown> },
  ctx: MessageContext,
) => Promise<string>;

// 默认适配器：什么都不做
const identity: McpAdapter = async (raw) => raw;

// 注册表：key 为 "server"（粗粒度）或 "server:tool"（细粒度，优先匹配）。
// 模块级 const Map——锁指向不锁内部，运行期可以继续注册新适配器。
const adapters = new Map<string, McpAdapter>();

export function registerMcpAdapter(key: string, adapter: McpAdapter): void {
  adapters.set(key, adapter);
}

// 取适配器：细粒度 "server:tool" > 粗粒度 "server" > identity 直通。
export function getAdapter(server: string, tool: string): McpAdapter {
  return adapters.get(`${server}:${tool}`) ?? adapters.get(server) ?? identity;
}
