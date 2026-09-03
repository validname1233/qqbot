// agent/mcp/initialize.ts —— MCP 启动吸收（设计方案 §3.6）：
// 遍历 MCP_SERVERS 配置 → 逐服务器 connectAndList（tools/list）→ 闸门放行的
// 工具 wrapMcpTool 后 registerTool 进全局工具表。挂 webhook 启动序列，与
// initializeNewsCron / initializePersonalities 同款模式。
//
// 可用性隔离：单个服务器失败记 warn 跳过，不连累 bot 启动（家里设备随时可能没开）。
// 时序安全：注册写的是 const Map 的内部（锁指向不锁内部），启动序列必然跑在首次
// toolSchemas() 之前；Map 是活的，将来重连重吸收零改动。

import { config } from "../../config.js";
import { logger } from "../../services/logger.js";
import { registerTool } from "../registry.js";
import { parseMcpServersConfig, connectAndList } from "./client.js";
import { wrapMcpTool } from "./bridge.js";

// 解析 MCP_EXPOSE 暴露规则（闸门）："服务器:*" 或 "服务器:工具名" 逗号分隔。
// 返回谓词函数：该服务器的该工具是否放行进全局工具表。
function parseExposeRules(raw: string): (server: string, tool: string) => boolean {
  const rules = raw
    .split(",")
    .map((piece) => piece.trim())
    .filter((piece) => piece !== "");

  return (server, tool) =>
    rules.some((rule) => rule === `${server}:*` || rule === `${server}:${tool}`);
}

export async function initializeMcpTools(): Promise<void> {
  const servers = parseMcpServersConfig(config.mcpServers);
  if (servers.length === 0) {
    logger.debug("mcp", "未配置 MCP_SERVERS，MCP 层不启用");
    return;
  }

  const exposed = parseExposeRules(config.mcpExposeRules);
  let totalAbsorbed = 0;

  for (const { name, url } of servers) {
    try {
      const tools = await connectAndList(name, url);
      let absorbed = 0;
      for (const def of tools) {
        if (def.name === "") continue;
        if (!exposed(name, def.name)) {
          logger.debug("mcp", `工具 ${name}/${def.name} 未被 MCP_EXPOSE 放行，不进工具表（仍可作远程内核直调）`);
          continue;
        }
        registerTool(wrapMcpTool(name, def));
        absorbed++;
      }
      totalAbsorbed += absorbed;
      logger.info("mcp", `服务器 ${name} 就绪：发现 ${tools.length} 个工具，吸收 ${absorbed} 个进全局工具表`);
    } catch (error) {
      // 连接/握手/listTools 失败：标记跳过（callTool 对未连接服务器返回友好文案）
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("mcp", `服务器 ${name}（${url}）连接失败，本次跳过：${message.slice(0, 200)}`);
    }
  }

  if (totalAbsorbed > 0) {
    logger.info("mcp", `MCP 吸收完成，共 ${totalAbsorbed} 个远程工具进入模型工具表`);
  }
}
