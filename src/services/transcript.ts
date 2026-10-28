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
import { appendEvent, distinctChatKeys } from "../agent/memory/events.js";
import { persistEventImages } from "../agent/memory/images.js";
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
    appendEvent({
      key,
      kind: "chat_user",
      role: "user",
      author: { openid: event.authorOpenid, name: event.authorName },
      content: event.content,
      attachmentIds: attachmentIds.length > 0 ? attachmentIds : null,
      qqMsgId: event.msgId,
    });
  } catch (err) {
    // 入站转录失败不阻塞业务分发（档案缺一行 < 机器人失联），但必须可见。
    logger.warn("memory", `入站转录失败（key=${key.slice(0, 10)}…）：${err instanceof Error ? err.message : err}`);
  }
}

// ---------- 出站收口 ----------

export interface OutboundTarget {
  // 群 or 单聊的目标 id（与 event 对应：groupOpenid / authorOpenid）
  key: string;
}

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

// ---------- 启动断痕 ----------

// 进程启动时对每个已知租户写一行"记录中断"标记（failover/重启的 L2 断痕显式化，
// recall 翻到此处知道"不是没人说话，是记录断了"）。origin=restart-gap。
export function writeRestartMarkers(): void {
  const keys = distinctChatKeys();
  const text = "【记录中断：进程重启】";
  for (const key of keys) {
    try {
      appendEvent({ key, kind: "chat_bot", role: "assistant", content: text, origin: "restart-gap" });
    } catch (err) {
      logger.warn("memory", `restart-gap 写入失败（key=${key.slice(0, 10)}…）：${err instanceof Error ? err.message : err}`);
    }
  }
  if (keys.length > 0) {
    logger.info("memory", `restart-gap：为 ${keys.length} 个租户写入记录中断标记`);
  }
}
