// services/buttons/demo.ts —— demo 命名空间的按钮处理器 + 测试入口命令
//（方案 2026-11-10 §3.4）。
//
// 两个角色：
//   ① 处理器：ns=demo 的点击回执（真机验证回调按钮全链路）；
//   ② 入口：/按钮 命令发一条带两个回调按钮的消息——点"点我试试"应收到
//      回执，点"坏格式"应看到管道兜住坏 data（无回执、日志 warn）。
// 验证通过后本文件整体可删（webhook.ts 的 initializeButtons 一行同删）。
//
// 回执走主动 push（方案 §7.3 默认；event_id 被动回复留作实测项）。

import type { CommandService, MessageContext } from "../../types.js";
import { registerButtonHandler, type ButtonInteraction } from "../../qq/button-registry.js";
import { callbackButton } from "../../qq/keyboard.js";
import { keyboardOf } from "../../qq/keyboard.js";
import {
  replyC2CMarkdownWithKeyboard,
  replyGroupMarkdownWithKeyboard,
} from "../../qq/messages.js";
import { pushC2CMessage, pushGroupMessage } from "../../qq/messages.js";
import { logger } from "../logger.js";

// ---------- ① 处理器 ----------
async function handleDemo(interaction: ButtonInteraction): Promise<boolean> {
  const who = interaction.userOpenid.slice(0, 6);
  const text =
    `收到点击：ns=${interaction.namespace} payload=${interaction.payload}` +
    `（by ${who}…，button_id=${interaction.buttonId}）`;
  logger.node("button-demo", text);
  try {
    if (interaction.groupOpenid !== null) {
      await pushGroupMessage(interaction.groupOpenid, text, { record: false });
    } else if (interaction.scene === "c2c") {
      await pushC2CMessage(interaction.userOpenid, text, { record: false });
    } else {
      logger.warn("button-demo", `不支持的 scene：${interaction.scene}（guild 一期不接）`);
      return false;
    }
    return true;
  } catch (err) {
    // 推送失败（频控/权限）不影响管道——处理器如实返回 false，管道记 warn。
    logger.warn("button-demo", `回执推送失败：${err instanceof Error ? err.message : err}`);
    return false;
  }
}

// ---------- ② 入口命令 ----------
// /按钮：发测试按钮。群聊/单聊均可；按钮 permission type:2（全员可点，
// 验证阶段先放开——真机实验项 §7.4/7.5 的一部分）。
async function sendTestButtons(ctx: MessageContext): Promise<string | null> {
  const keyboard = keyboardOf([
    [
      callbackButton("demo_btn_ok", "点我试试", "demo:hello", { type: 2 }),
      callbackButton("demo_btn_bad", "坏格式测试", "demo:bad", { type: 2 }),
    ],
  ]);
  const markdown = "**回调按钮测试**\n点「点我试试」应收到回执消息";

  const event = ctx.event;
  try {
    if (event.type === "GROUP_AT_MESSAGE_CREATE" || event.type === "GROUP_MESSAGE_CREATE") {
      await replyGroupMarkdownWithKeyboard(event.groupOpenid, markdown, keyboard, event.msgId);
    } else {
      await replyC2CMarkdownWithKeyboard(event.authorOpenid, markdown, keyboard, event.msgId);
    }
    return null; // 按钮消息已自行发送，抑制 handler 的默认回复
  } catch (err) {
    logger.warn("button-demo", `测试按钮消息发送失败: ${err instanceof Error ? err.message : err}`);
    return "测试按钮发送失败了，稍后再试～";
  }
}

export const buttonDemoService: CommandService = {
  name: "按钮",
  aliases: ["btn"],
  async handle(ctx: MessageContext): Promise<string | null> {
    return sendTestButtons(ctx);
  },
};

// 启动期注册处理器（webhook.ts 调用）。
export function initializeButtons(): void {
  registerButtonHandler("demo", { handle: handleDemo });
}
