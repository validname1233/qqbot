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
import { connectAndList } from "./client.js";
import { wrapMcpTool } from "./bridge.js";

export async function initializeMcpTools(): Promise<void> {
  const servers = config.mcpServerConfigs;
  if (servers.length === 0) {
    logger.node("mcp", "未找到 mcp.json（或 servers 为空），MCP 层不启用");
    return;
  }

  let totalAbsorbed = 0;

  for (const server of servers) {
    try {
      const tools = await connectAndList(server);
      const exposed = server.expose; // 闸门已随配置加载进每服务器条目："*" 全放行，空数组全不放行
      let absorbed = 0;
      for (const def of tools) {
        if (def.name === "") continue;
        if (!exposed.includes("*") && !exposed.includes(def.name)) {
          logger.node("mcp", `工具 ${server.name}/${def.name} 未被 expose 放行，不进工具表（仍可作远程内核直调）`);
          continue;
        }
        registerTool(wrapMcpTool(server.name, def, server.progressNotes));
        absorbed++;
      }
      totalAbsorbed += absorbed;
      logger.info("mcp", `服务器 ${server.name} 就绪：发现 ${tools.length} 个工具，吸收 ${absorbed} 个进全局工具表`);
    } catch (error) {
      // 连接/握手/listTools 失败：标记跳过（callTool 对未连接服务器返回友好文案）
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("mcp", `服务器 ${server.name}（${server.url}）连接失败，本次跳过：${message.slice(0, 200)}`);
    }
  }

  if (totalAbsorbed > 0) {
    logger.info("mcp", `MCP 吸收完成，共 ${totalAbsorbed} 个远程工具进入模型工具表`);
  }
}
