// agent/mcp/client.ts —— MCP 连接层：哑管道单例（设计方案 §3.1）。
// 只管收发：建连、tools/list 拉工具定义、tools/call 转发调用；断线重连一次、
// 每调用超时控制。不做任何结果加工（那是 bridge/adapters 的职责）——
// interact_page 远程内核路径需要原始数据，管道里加工会污染它。
//
// 可用性隔离：单个服务器连不上只记 warn、标记不可用，绝不连累 bot 启动
// （家里的设备随时可能重启，MCP 是增强能力不是核心依赖）。

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { config, type McpServerConfig } from "../../config.js";
import { logger } from "../../services/logger.js";

// 一个已连接的服务器条目：Client 实例 + 服务器名（工具名前缀用）
interface ServerEntry {
  name: string;
  client: Client;
}

// name → 连接。模块级单例（类比 browser.ts）：连接是长连接（Streamable HTTP），
// 不能每次调用重建；初始化（initializeMcpTools）建立，进程存活期间复用。
const servers = new Map<string, ServerEntry>();

// MCP tools/list 返回的工具定义（我们只消费这三个字段）
export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// tools/call 返回的原始结构（SDK 类型简化到我们需要看的部分）
export interface McpCallResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

// 建一个客户端连接（不发送任何请求，握手在 connect 时完成）。
// apiKey 非空时以 Authorization: Bearer 头随每个 HTTP 请求发送（握手/列表/调用
// 全带）——公网 MCP 服务器（如托管服务、知识库端侧节点）的鉴权就靠这层；
// 内网自部署不鉴权的服务器 apiKey 留空，行为与旧版一致。
async function createConnection(server: McpServerConfig): Promise<ServerEntry> {
  const client = new Client({ name: `qq-bot`, version: "1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: server.apiKey !== ""
      ? { headers: { Authorization: `Bearer ${server.apiKey}` } }
      : undefined,
  });
  await client.connect(transport); // 握手（initialize）失败会抛——调用方决定降级
  return { name: server.name, client };
}

// 连接一个服务器并拉取工具定义。失败抛错（initializeMcpTools 捕获后降级跳过）。
export async function connectAndList(server: McpServerConfig): Promise<McpToolDefinition[]> {
  const entry = await createConnection(server);
  servers.set(server.name, entry);
  const listResult = await entry.client.listTools();
  return (listResult.tools ?? []).map((tool) => ({
    name: tool.name ?? "",
    description: tool.description ?? "",
    inputSchema: (tool.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>,
  }));
}

// 服务器是否已连接（闸门/初始化排查用）
export function isConnected(name: string): boolean {
  return servers.has(name);
}

// 转发一次工具调用。断线时重连一次再试（家里设备重启的场景）；
// 超时兜底防远程卡死拖垮深检预算。失败不抛——返回可读文案让模型自愈
// （桥工具的 run 约定：错误走文案不走异常，避开全局 runTool 的统一兜底）。
export async function callTool(
  serverName: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ ok: true; result: McpCallResult } | { ok: false; errorText: string }> {
  let entry = servers.get(serverName);
  if (entry === undefined) {
    return { ok: false, errorText: `MCP 服务器 ${serverName} 未连接（启动时不可用或未配置）` };
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.mcpCallTimeoutMs);
    try {
      const result = (await entry.client.callTool(
        { name: toolName, arguments: args },
        undefined,
        { signal: controller.signal },
      )) as McpCallResult;
      clearTimeout(timer);
      return { ok: true, result };
    } catch (error) {
      clearTimeout(timer);
      const message = error instanceof Error ? error.message : String(error);
      if (attempt === 1) {
        // 第一次失败：疑似断线，按配置重建连接再试一次（DDNS 域名自动跟随家里新 IP）
        logger.warn("mcp", `callTool ${serverName}/${toolName} 失败（${message.slice(0, 120)}），重连一次重试`);
        try {
          const configured = config.mcpServerConfigs.find((s) => s.name === serverName);
          if (configured === undefined) throw new Error("配置里找不到该服务器的地址");
          servers.delete(serverName);
          entry = await createConnection(configured);
          servers.set(serverName, entry);
          continue;
        } catch (reconnectError) {
          const rmsg = reconnectError instanceof Error ? reconnectError.message : String(reconnectError);
          return { ok: false, errorText: `MCP 服务器 ${serverName} 重连失败：${rmsg}` };
        }
      }
      return { ok: false, errorText: `MCP 调用 ${serverName}/${toolName} 失败：${message}` };
    }
  }
  return { ok: false, errorText: `MCP 调用 ${serverName}/${toolName} 两次尝试均失败` };
}

// 进程收尾用：断开全部连接（webhook 常驻一般用不到，测试脚本用）
export async function disconnectAll(): Promise<void> {
  for (const entry of servers.values()) {
    await entry.client.close().catch(() => undefined);
  }
  servers.clear();
}
