// services/knowledge-base.ts —— /知识库管理 命令：直调端侧 MCP 的 kb_issue_link
// 拿管理页 URL 回复会话（docs/features/2026-09-04-知识库RAG-MCP方案.md §6.1/§7）。
//
// 设计要点：
// - 签发不经模型：kb_issue_link 不在 expose 闸门里（mcp.json 的 kb.expose 为空），
//   "何时发链接"是命令语义——命令代码用 callTool 直调，模型永远看不见这个工具。
// - scope 按会话粒度算：一群一库 / 单聊一人一库。注意与 sessionKey 的人粒度刻意
//   不同——知识库是会话共享资产（群里人人可传可查），会话状态才是各玩各的。
// - server 不可用回降级文案（MCP 层可用性隔离语义：增强能力不连累命令本身可用）。

import type { CommandService, MessageContext } from "../types.js";
import type { BotEvent } from "../events/registry.js";
import { callTool } from "../agent/mcp/client.js";
import { flattenMcpResult } from "../agent/mcp/bridge.js";
import { logger } from "./logger.js";

// 知识库隔离键（群粒度）。前缀 kb: 与 sessionKey 的 group:/c2c: 命名空间隔开，
// 避免两套 key 语义混淆；可辨识联合收窄后才能安全访问 groupOpenid。
export function kbScope(event: BotEvent): string {
  if (event.type === "GROUP_AT_MESSAGE_CREATE" || event.type === "GROUP_MESSAGE_CREATE") {
    return `kb:group:${event.groupOpenid}`;
  }
  return `kb:c2c:${event.authorOpenid}`;
}

export const knowledgeBaseService: CommandService = {
  name: "知识库管理",
  aliases: ["知识库"],

  async handle(ctx: MessageContext): Promise<string | null> {
    const scope = kbScope(ctx.event);
    const outcome = await callTool("kb", "kb_issue_link", { scope });
    if (!outcome.ok) {
      logger.warn("kb", `/知识库管理 签发失败: ${outcome.errorText.slice(0, 150)}`);
      return "知识库服务暂时连不上（端侧服务器可能离线），稍后再试～";
    }
    // kb_issue_link 返回单条 text 块（URL），拍扁即得；isError 时是可行动的错误说明
    const url = flattenMcpResult(outcome.result).trim();
    if (url === "" || !url.startsWith("http")) {
      logger.warn("kb", `/知识库管理 签发返回异常: ${url.slice(0, 150)}`);
      return "知识库服务返回了异常结果，稍后再试～";
    }
    const who = scope.startsWith("kb:group:") ? "本群" : "你";
    return [
      `${who}的知识库管理页面：`,
      url,
      "在浏览器打开即可上传/管理文件。链接长期有效，忘了随时再发 /知识库管理 领取。",
    ].join("\n");
  },
};
