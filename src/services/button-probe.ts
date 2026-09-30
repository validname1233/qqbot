// services/button-probe.ts —— 临时探针命令：/按钮测试。
// 用途：知识库管理入口按钮权限方案的 Phase A 真机实验（方案文档 §5）：
//   实验 1 —— 自定义 keyboard（长形式）能否发送（方案生死开关，报错=未开通）；
//   实验 2 —— permission.type=1 的"管理员"判定范围（群主/管理员各点一次）；
//   实验 3 —— 无权限用户点击的体验（置灰/无效/报错）。
//
// 用法（三种 permission 模式，对照实验设计）：
//   /按钮测试        → type=1（仅管理员可操作）——实验 1+2 主对象
//   /按钮测试 0      → type=0 + specify_user_ids=[发送者本人]——实验 2 备选路径
//                      （顺带验证 specify_user_ids 吃不吃 member_openid）
//   /按钮测试 2      → type=2（所有人可操作）——对照组：若 type=1 全员点不动，
//                      用它区分"按钮坏了"和"权限挡了"
// 仅群聊可用（按钮场景在群里；单聊消息天然私密，不走本方案）。
// 这是临时探针，实验结束后整文件删除（dm-probe 同款模式）。
//
// 注意：本命令自发按钮消息后返回 null——若这里抛错，错误会落进 handler 的
// "Markdown 失败回退纯文本"降级链，但本探针不含敏感 URL（测试链接公开无害），
// 无红线问题；正式的知识库入口命令必须自己 catch（见 messages.ts 头注释）。

import type { CommandService, MessageContext } from "../types.js";
import { replyGroupMarkdownWithKeyboard } from "../qq/messages.js";
import { jumpButton, keyboardOf, type ButtonPermission } from "../qq/keyboard.js";
import { logger } from "./logger.js";

// 跳转目标用一个公开无害的官方文档页——实验只关心按钮渲染与点击资格，
// 不需要真实管理页（管理页流程是实验 4，另行验证）。
const TEST_URL = "https://bot.q.qq.com/wiki/";

export const buttonProbeService: CommandService = {
  name: "按钮测试",

  async handle(ctx: MessageContext): Promise<string | null> {
    const event = ctx.event;
    if (event.type !== "GROUP_MESSAGE_CREATE" && event.type !== "GROUP_AT_MESSAGE_CREATE") {
      return "这个探针要在群里用哦～";
    }

    const mode = ctx.args.trim();
    let permission: ButtonPermission;
    let modeDesc: string;
    if (mode === "" ) {
      permission = { type: 1 };
      modeDesc = "type=1 仅管理员可操作（实验主对象：群主/管理员/群员各点一次）";
    } else if (mode === "0") {
      permission = { type: 0, specify_user_ids: [event.authorOpenid] };
      modeDesc = `type=0 指定用户（本人 ${event.authorOpenid.slice(0, 6)}…）——实验 2 备选路径，验证 specify_user_ids 是否认 member_openid`;
    } else if (mode === "2") {
      permission = { type: 2 };
      modeDesc = "type=2 所有人可操作——对照组：全员都该点得动";
    } else {
      return "用法：/按钮测试 [0|2]，不带参数=仅管理员模式";
    }

    try {
      await replyGroupMarkdownWithKeyboard(
        event.groupOpenid,
        `**按钮链路探针**（${modeDesc}）\n下面这个按钮的点击表现就是实验数据：`,
        keyboardOf([[jumpButton("probe_open", "打开测试页", TEST_URL, permission)]]),
        event.msgId,
      );
      logger.node("button-probe", `按钮消息已发送（mode=${mode === "" ? "1" : mode}）`);
      return null; // 已自行发送按钮消息，抑制 handler 的默认文本回复
    } catch (err) {
      // 失败原文直接回群里——错误码（如"未开通"类）正是实验 1 要的数据。
      const raw = err instanceof Error ? err.message : String(err);
      logger.warn("button-probe", `按钮消息发送失败: ${raw.slice(0, 400)}`);
      return `按钮消息发送失败 ❌\n错误原文：${raw.slice(0, 300)}`;
    }
  },
};
