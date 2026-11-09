// services/workspace-console.ts —— 命令型 service：/工作台 领取管理页入口。
// 结构照抄 knowledge-base.ts（docs/features/2026-11-09-工作台前端管理界面方案.md §3），
// 差异仅在签发：token 是本进程直接 INSERT（tokens.ts），不经 MCP。
//
// 权限模型（kb 同款两道闸）：
//   闸①（本文件，群分支）：event.authorRole 非群主/管理员直接拒绝，不签发
//        ——fail-closed：member_role 缺失（null）也拒绝，绝不默认放行。
//   闸②（平台，客户端强制）：入口 URL 只装在跳转按钮的 action.data 里下发
//        （permission.type=1 仅管理员可点）。链接永不以文本落地群聊。
//   ★ 红线：一切失败降级文案不含 URL——宁可这次不发，不可裸发链接。
//
// token 语义：链接即凭证（同 kb）。拿到的任何人可看可改该会话的工作台目录，
// 管理员勿外传；30 天过期（config.workspaceUiTokenTtlDays），过期重新发本命令。

import type { CommandService, MessageContext } from "../types.js";
import { replyGroupMarkdownWithKeyboard, replyC2CMarkdownWithKeyboard } from "../qq/messages.js";
import { jumpButton, keyboardOf } from "../qq/keyboard.js";
import { tenantKey } from "../session/key.js";
import { config } from "../config.js";
import { issueToken } from "./workspace-ui/tokens.js";
import { logger } from "./logger.js";

function buildUrl(scope: string): string {
  return `${config.workspaceUiPublicUrl}/ws/${issueToken(scope)}`;
}

export const workspaceConsoleService: CommandService = {
  name: "工作台",
  aliases: ["workspace"],

  async handle(ctx: MessageContext): Promise<string | null> {
    if (!config.workspaceUiEnabled) {
      return "工作台管理页还没开启哦～（管理员配置 WORKSPACE_UI_ENABLED=true 后可用）";
    }
    const event = ctx.event;

    if (event.type === "GROUP_AT_MESSAGE_CREATE" || event.type === "GROUP_MESSAGE_CREATE") {
      // 闸①：先验身份再签发——不为无权者产生 token。null（member_role 未下发）
      // 与 member 同路拒绝（fail-closed）。
      if (event.authorRole !== "admin" && event.authorRole !== "owner") {
        return "工作台管理只能由群主或管理员使用哦～";
      }

      const url = buildUrl(tenantKey(event));
      try {
        await replyGroupMarkdownWithKeyboard(
          event.groupOpenid,
          "**本群工作台管理入口**\n点击下方按钮打开文件管理页（仅群主/管理员可点击）",
          keyboardOf([[jumpButton("ws_open", "打开工作台", url, { type: 1 })]]),
          event.msgId,
        );
        return null; // 按钮消息已自行发送，返回 null 抑制 handler 的默认回复
      } catch (err) {
        // ★ 红线：降级文案不含 URL，异常就地兜住（同 kb 的群聊分支纪律）。
        logger.warn("workspace-ui", `管理入口按钮消息发送失败: ${err instanceof Error ? err.message : err}`);
        return "管理入口发送失败了，稍后再试～";
      }
    }

    // 单聊：按钮 type:2（消息天然只有本人可见可点）；按钮失败回退纯文本链接
    //（通道私密，无泄露面——与 kb 单聊分支同款取舍）。
    const url = buildUrl(tenantKey(event));
    try {
      await replyC2CMarkdownWithKeyboard(
        event.authorOpenid,
        "**你的工作台管理入口**\n点击下方按钮打开文件管理页",
        keyboardOf([[jumpButton("ws_open", "打开工作台", url, { type: 2 })]]),
        event.msgId,
      );
      return null;
    } catch (err) {
      logger.warn("workspace-ui", `单聊管理入口按钮消息发送失败: ${err instanceof Error ? err.message : err}`);
      return [
        "按钮发送失败了，先用链接顶一下：",
        url,
        `在浏览器打开即可管理文件。链接 ${config.workspaceUiTokenTtlDays} 天内有效，忘了随时再发 /工作台 领取。`,
      ].join("\n");
    }
  },
};
