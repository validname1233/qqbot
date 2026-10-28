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
import { appendEvent, chatRows } from "../agent/memory/events.js";
import { persistEventImages, pruneImagesOutsideWindow } from "../agent/memory/images.js";
import { isImageAttachment } from "../events/attachments.js";
import { logger } from "./logger.js";

// ---------- 入站收口 ----------

// 消息正文 + 附件引用的合成口径：图片下载入库后按 attachment_ids 引用（v8），
// content 存 QQ 原文（含 faceType 标签，不掺我方占位符）。纯附件空文本也落行
// （content 空串合法——"发了个东西"本身是历史的一部分）。
export async function recordInbound(event: BotEvent): Promise<void> {
  const key = tenantKey(event);
  try {
    // 先持久化附件拿 id 列表（图片下载 ≤10s 超时兜底），再写 chat_user 行。
    // persistEventImages 内部 UNIQUE 吸收 QQ 重推的重复下载。
    const attachmentIds = await persistEventImages(event);
    if (attachmentIds.length === 0 && event.attachments.some(isImageAttachment)) {
      // 下载全军覆没（超时/过大/网络）：图片行一个都没建。若此时照常落
      // chat_user（attachmentIds=null），图片信息从此丢失——QQ 的 URL 有时效，
      // 事后无图可查。补救：删除本条消息已有的行（若 UNIQUE 撞上重推的旧成功
      // 行则保留旧的），强制下次重推时重走完整下载。代价是这条消息暂时不在
      // L2（可接受——它带图，投影里本就缺半边）。
      const existing = chatRows(key, 1).find((r) => r.qqMsgId === event.msgId);
      if (existing === undefined) {
        logger.warn("memory", `图片全部下载失败，消息暂不入库（msgId=${event.msgId.slice(0, 12)}…），等待重推补全`);
        return;
      }
      // 重推且旧行存在（之前有图成功过）——沿用旧行，本条不重复写。
      return;
    }
    appendEvent({
      key,
      kind: "chat_user",
      role: "user",
      author: { openid: event.authorOpenid, name: event.authorName },
      content: event.content,
      attachmentIds: attachmentIds.length > 0 ? attachmentIds : null,
      qqMsgId: event.msgId,
    });
    // prune 挂在 chat 行落库之后（引用已建立，新图不会被误判 stale）。
    if (attachmentIds.length > 0) pruneImagesOutsideWindow(key);
  } catch (err) {
    // 入站转录失败不阻塞业务分发（档案缺一行 < 机器人失联），但必须可见。
    logger.warn("memory", `入站转录失败（key=${key.slice(0, 10)}…）：${err instanceof Error ? err.message : err}`);
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
