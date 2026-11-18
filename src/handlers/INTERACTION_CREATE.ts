// handlers/INTERACTION_CREATE.ts —— 回调按钮事件的管道层（方案 2026-11-10 §2.3）。
// 只做三件事：① 3 秒内回应平台（先回应后业务——硬约束不赌）；② button_data
// 切命名空间查注册表分发；③ 兜错（未注册/处理器抛错 → 回应 code:1 + 日志，
// 单业务的坏数据不炸管道）。业务语义全部在 ButtonHandler 里。

import type { InteractionCreateEvent } from "../events/INTERACTION_CREATE/index.js";
import { findButtonHandler, toButtonInteraction } from "../qq/button-registry.js";
import { respondInteraction } from "../qq/interactions.js";
import { logger } from "../services/logger.js";

// 已见 interactionId 去重：QQ 重推同事件的防御。二次点击同一按钮是**新**
// interactionId（平台每次点击生成新交互），不会被这里误拦——拦的只是同一
// 事件的网络重投。无库支撑，内存 Map + 容量上限兜底（个人 bot 事件量小，
// 超上限清最老的——Map 保插入序，删第一个键即最老）。
const seen = new Map<string, true>();
const SEEN_MAX = 1000;

function markSeen(id: string): boolean {
  if (seen.has(id)) return false;
  seen.set(id, true);
  if (seen.size > SEEN_MAX) {
    const oldest = seen.keys().next().value;
    if (oldest !== undefined) seen.delete(oldest);
  }
  return true;
}

export async function handleInteractionCreate(event: InteractionCreateEvent): Promise<void> {
  // 去重：重推的旧事件直接吞掉（回应只允许一次，二次调用平台会拒）。
  if (!markSeen(event.interactionId)) {
    logger.info("button", `重推事件已吞（interactionId=${event.interactionId.slice(0, 8)}…）`);
    return;
  }

  // ① 先回应后业务（3 秒窗口）：fire-and-forget，失败在 interactions.ts 内
  // 已兜（warn 静默）。code:0 = 成功受理——业务结果的好坏不通过回应码表达
  //（回应码表达的是"这次交互收到没有"，处理器要给用户反馈自己发消息）。
  void respondInteraction(event.interactionId, 0);

  // ② 解析 + 分发
  const interaction = toButtonInteraction(event);
  if (interaction === null) {
    logger.warn("button", `button_data 格式不对（无命名空间）：${event.buttonData.slice(0, 50)}`);
    return; // 已回 code:0（受理），坏 data 记日志即可——按钮确实被点过
  }

  const handler = findButtonHandler(interaction.namespace);
  if (handler === undefined) {
    logger.warn("button", `命名空间未注册：${interaction.namespace}（data=${event.buttonData.slice(0, 50)}）`);
    return;
  }

  // ③ 业务兜错：处理器抛错不影响管道（下一个按钮事件照常路由）。
  try {
    const ok = await handler.handle(interaction);
    if (!ok) {
      logger.warn("button", `处理器 ${interaction.namespace} 返回 false（data=${event.buttonData.slice(0, 50)}）`);
    }
  } catch (err) {
    logger.error("button", `处理器 ${interaction.namespace} 抛错：${err instanceof Error ? err.message : err}`);
  }
}
