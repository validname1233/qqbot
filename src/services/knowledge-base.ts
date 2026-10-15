// services/knowledge-base.ts —— /知识库管理 命令：直调端侧 MCP 的 kb_issue_link
// 拿管理页 URL 回复会话（docs/features/2026-09-04-知识库RAG-MCP方案.md §6.1/§7）。
//
// 权限模型（docs/features/2026-09-30-知识库管理入口按钮权限方案.md）：两道闸。
//   闸①（本文件，群分支）：event.authorRole 非群主/管理员直接拒绝，不签发 token
//        ——fail-closed：member_role 缺失（null）也拒绝，绝不默认放行。
//   闸②（平台，客户端强制）：入口 URL 只装在跳转按钮的 action.data 里下发
//        （permission.type=1 仅管理员可点）。链接永不以文本落地群聊——群历史里
//        翻到的旧消息，非管理员也只是点不动的按钮。
//   ★ 红线：一切失败降级文案不含 URL（方案 §4.3）——宁可这次不发，不可裸发链接。
//        所以按钮发送失败在本文件 catch，绝不让异常或正文落进 handler 的
//        "Markdown 失败回退纯文本"降级链。
//
// 其它设计要点：
// - 签发不经模型：kb_issue_link 不在 expose 闸门里（mcp.json 的 kb.expose 为空），
//   "何时发链接"是命令语义——命令代码用 callTool 直调，模型永远看不见这个工具。
// - scope 按会话粒度算：一群一库 / 单聊一人一库（tenantKey，2026-10-14 键统一后
//   与全项目共用同一键值——测试环境远端旧 kb: 前缀数据已弃）。
//   检索（kb_search）不受本命令权限影响，群里人人可用。
// - 单聊分支不用按钮：消息天然只有本人可见，纯文本链接即安全。

import type { CommandService, MessageContext } from "../types.js";
import { callTool } from "../agent/mcp/client.js";
import { flattenMcpResult } from "../agent/mcp/bridge.js";
import { replyGroupMarkdownWithKeyboard, replyC2CMarkdownWithKeyboard } from "../qq/messages.js";
import { jumpButton, keyboardOf } from "../qq/keyboard.js";
import { tenantKey } from "../session/key.js";
import { logger } from "./logger.js";

// 远端 kb 服务器的 scope 契约：强制 kb: 前缀（kb:group:<openid> / kb:c2c:<openid>），
// 服务端有格式校验，裸 tenantKey 会被拒（2026-10-15 实机报错确认）。本地推导
// 仍统一走 tenantKey，跨服务边界时在此包一层命名空间——键统一的"一个真相源、
// 两个发射形状"形态。
function kbScope(event: Parameters<typeof tenantKey>[0]): string {
  return `kb:${tenantKey(event)}`;
}

// 签发管理页 URL（群/单聊共用）。失败记 warn 返回 null——MCP 层可用性隔离语义：
// 端侧服务器离线连累不了命令本身，回降级文案即可。
async function issueLink(scope: string): Promise<string | null> {
  const outcome = await callTool("kb", "kb_issue_link", { scope });
  if (!outcome.ok) {
    logger.warn("kb", `/知识库管理 签发失败: ${outcome.errorText.slice(0, 150)}`);
    return null;
  }
  // kb_issue_link 返回单条 text 块（URL），拍扁即得；isError 时是可行动的错误说明
  const url = flattenMcpResult(outcome.result).trim();
  if (url === "" || !url.startsWith("http")) {
    logger.warn("kb", `/知识库管理 签发返回异常: ${url.slice(0, 150)}`);
    return null;
  }
  return url;
}

export const knowledgeBaseService: CommandService = {
  name: "知识库管理",
  aliases: ["知识库"],

  async handle(ctx: MessageContext): Promise<string | null> {
    const event = ctx.event;
    const scope = kbScope(ctx.event);

    if (event.type === "GROUP_AT_MESSAGE_CREATE" || event.type === "GROUP_MESSAGE_CREATE") {
      // 闸①：先验身份再签发——不为无权者产生 token。null（member_role 未下发）
      // 与 member 同路拒绝（fail-closed）。
      if (event.authorRole !== "admin" && event.authorRole !== "owner") {
        return "知识库管理只能由群主或管理员使用哦～";
      }

      const url = await issueLink(scope);
      if (url === null) {
        return "知识库服务暂时连不上（端侧服务器可能离线），稍后再试～";
      }

      try {
        await replyGroupMarkdownWithKeyboard(
          event.groupOpenid,
          "**本群知识库管理入口**\n点击下方按钮打开管理页（仅群主/管理员可点击）",
          keyboardOf([[jumpButton("kb_open", "打开管理页", url, { type: 1 })]]),
          event.msgId,
        );
        return null; // 按钮消息已自行发送，返回 null 抑制 handler 的默认回复
      } catch (err) {
        // ★ 红线：降级文案不含 URL，异常就地兜住——不能落进 handler 的
        // 纯文本降级链把链接裸发进群。
        logger.warn("kb", `管理入口按钮消息发送失败: ${err instanceof Error ? err.message : err}`);
        return "管理入口发送失败了，稍后再试～";
      }
    }

    // 单聊：同样以按钮下发（与群聊逻辑统一）。降级策略与群聊刻意不同——
    // 红线只约束群聊（URL 不能落群文本）；单聊通道私密，按钮发不出去时直接
    // 回退纯文本链接，比"这次不发、稍后再试"体验更好（链接此时无泄露面）。
    // permission 用 type:2 而非群聊的 type:1：单聊没有"管理员"概念，消息天然
    // 只有本人可见可点（keyboard 详解文档 §5）。
    const url = await issueLink(scope);
    if (url === null) {
      return "知识库服务暂时连不上（端侧服务器可能离线），稍后再试～";
    }
    try {
      await replyC2CMarkdownWithKeyboard(
        event.authorOpenid,
        "**你的知识库管理入口**\n点击下方按钮打开管理页",
        keyboardOf([[jumpButton("kb_open", "打开管理页", url, { type: 2 })]]),
        event.msgId,
      );
      return null; // 按钮消息已自行发送，返回 null 抑制 handler 的默认回复
    } catch (err) {
      logger.warn("kb", `单聊管理入口按钮消息发送失败: ${err instanceof Error ? err.message : err}`);
      return [
        "按钮发送失败了，先用链接顶一下：",
        url,
        "在浏览器打开即可上传/管理文件。链接长期有效，忘了随时再发 /知识库管理 领取。",
      ].join("\n");
    }
  },
};
