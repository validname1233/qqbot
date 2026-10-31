// services/transcript.ts —— 对话转录的双收口（总方案模块一 §1.2 写入点表）。
//
// 每类事件恰好一个写入者，根治旧架构的三个实证问题：
//   ①双写 bug（自动路由的消息被 memory-log 和 runAgentTurn 各记一次）
//   ②覆盖缺口（/help、提醒推送、扑克快照等 bot 出站从不入库）
//   ③入库决策分散（三个文件靠注释约定对齐，约定已被静默打破）
//
// 不变量：L2 = "QQ 聊天窗口里实际出现过的一切"（文本维度）。
//   入站：dispatcher 在 handler 之前串行 await（保证 chat_user 行 id 恒小于
//         本轮 process/chat_bot 行——时间线正确；代价是带图消息回复慢一次下载）。
//   出站：messages.ts 8 个发送函数在 traceOut 处同步写；发送成功才记
//         （没发出的消息不存在）；progress-bus 传 record:false 排除瞬时进度。

import type { BotEvent } from "../events/registry.js";
import { tenantKey } from "../session/key.js";
import { appendEvent, db } from "../agent/memory/events.js";
import { persistEventImages, pruneImagesOutsideWindow } from "../agent/memory/images.js";
import { isImageAttachment } from "../events/attachments.js";
import { logger } from "./logger.js";

// ---------- 入站收口 ----------

// 消息正文 + 附件引用的合成口径：图片下载入库后按 attachment_ids 引用（v8），
// content 存 QQ 原文（含 faceType 标签，不掺我方占位符）。纯附件空文本也落行
// （content 空串合法——"发了个东西"本身是历史的一部分）。
//
// 返回值（2026-10-30 分发层短路决议）：true = 本条消息首次见到（落了新行），
// false = QQ 重推（UNIQUE 吸收，行已在）或转录异常——调用方（dispatcher）
// 据此短路 handler，保证"执行恰一次"。
// 图片全败也落行（attachmentIds=null）：消息事实与"已处理"标记统一在行上；
// QQ 重推时 persistEventImages 会把缺的图补进图片表，此处 UPDATE 接上引用
// （懒补全）；没重推就按无图降级（投影时 [图片] 裸标记，语义自明）。
export async function recordInbound(event: BotEvent): Promise<boolean> {
  const key = tenantKey(event);
  try {
    // 先持久化附件拿 id 列表（图片下载 ≤10s 超时兜底），再写 chat_user 行。
    // persistEventImages 内部 UNIQUE 吸收 QQ 重推的重复下载。
    const attachmentIds = await persistEventImages(event);
    const hasImageAttachments = event.attachments.some(isImageAttachment);

    if (attachmentIds.length === 0 && hasImageAttachments) {
      // 下载全军覆没（超时/过大/网络）：仍落行（attachmentIds=null，无图降级）。
      logger.warn("memory", `图片全部下载失败，按无图入库（msgId=${event.msgId.slice(0, 12)}…），重推时补`);
    }

    const inserted = appendEvent({
      key,
      kind: "chat_user",
      role: "user",
      author: { openid: event.authorOpenid, name: event.authorName },
      content: event.content,
      attachmentIds: attachmentIds.length > 0 ? attachmentIds : null,
      qqMsgId: event.msgId,
    });

    if (inserted === null) {
      // 重推：行已存在。若本次补下了图而原行是无图降级（引用为 NULL），
      // UPDATE 接上引用——消息行的"带图"事实恢复，下轮投影即展开。
      if (attachmentIds.length > 0) {
        const reattached = db
          .prepare(`UPDATE conversation_events SET attachment_ids = ? WHERE key = ? AND qq_msg_id = ? AND attachment_ids IS NULL`)
          .run(JSON.stringify(attachmentIds), key, event.msgId);
        if (reattached.changes > 0) {
          logger.info("memory", `重推补图成功，已接回消息行引用（msgId=${event.msgId.slice(0, 12)}…）`);
          pruneImagesOutsideWindow(key);
        }
      }
      return false;
    }

    // prune 挂在 chat 行落库之后（引用已建立，新图不会被误判 stale）。
    if (attachmentIds.length > 0) pruneImagesOutsideWindow(key);
    return true;
  } catch (err) {
    // 入站转录失败不阻塞业务分发（档案缺一行 < 机器人失联），但必须可见。
    // 返回 true（当首见处理）：转录失败不该挡住 handler，宁可冒重复执行的风险
    //（异常路径本就罕见）也不静默丢用户消息。
    logger.warn("memory", `入站转录失败（key=${key.slice(0, 10)}…）：${err instanceof Error ? err.message : err}`);
    return true;
  }
}

// ---------- 出站收口 ----------

export interface RecordOutboundOptions {
  // false = 不转录（progress-bus 等瞬时进度）。默认转录。
  record?: boolean;
}

// bot 发送成功后调用：记一行 chat_bot。
// origin 标记来源（agent/poker/reminder/help/…），排查与未来按来源过滤用。
export function recordOutbound(
  key: string,
  content: string,
  origin: string,
  opts: RecordOutboundOptions = {},
): void {
  if (opts.record === false) return;
  try {
    appendEvent({ key, kind: "chat_bot", role: "assistant", content, origin });
  } catch (err) {
    logger.warn("memory", `出站转录失败（key=${key.slice(0, 10)}…）：${err instanceof Error ? err.message : err}`);
  }
}
