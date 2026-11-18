// services/button-demo.ts —— demo 命名空间的按钮处理器（方案 2026-11-10 §3.4）。
// 用途：真机验证回调按钮全链路（发按钮 → 点击 → 事件到达 → 路由到处理器 →
// 回执推送）。验证通过后可删，或留作未来消费方的接入范例。
//
// 真机验证步骤：
//   ① 本文件在 webhook.ts 已注册（initializeButtonDemo）；
//   ② 给 bot 发一条消息触发 demo（或临时在任一 handler 里调 sendDemoButtons）；
//   ③ 点按钮 → 群/单聊应收到"收到点击"回执，日志出现 button 模块的 run 开始行。
//
// 回执走主动 push（方案 §7.3 的默认选择；event_id 被动回复留作实测项）。

import { registerButtonHandler, type ButtonInteraction } from "../qq/button-registry.js";
import { pushC2CMessage, pushGroupMessage } from "../qq/messages.js";
import { logger } from "./logger.js";

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

// 启动期注册（webhook.ts 调用）。demo 处理器常驻注册——不占任何消息路径，
// 只在收到 ns=demo 的点击时才跑。
export function initializeButtonDemo(): void {
  registerButtonHandler("demo", { handle: handleDemo });
}
