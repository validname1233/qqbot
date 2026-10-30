// agent/assembly.ts —— L1 装配管线（总方案模块二 §1.1，形态 B 增量 blob）。
//
// 无状态：每次 /Agent 触发时从库重投影，跨轮无内存态（LangGraph state 只活在
// 单次 invoke 内）。五个步骤（窗口 = 查询，§1.5 终版原则——不存在窗口管理器，
// 所有窗口操作收敛为写标记行）。
//
// 形态 B（§1.2 终版）：批仅含 chat_user 行（{"speaker":…,"content":…} 逐行），
// chat_bot 行以裸 assistant 投影做批间隔断——语言顺序即聊天顺序，数组纯尾部
// 追加（缓存契约），断点只在 reset。u_now 恒为最后一条 user 消息。
//
// 提示词总纲：System 管"怎么读"，user 管"读什么"——本模块只产出 user 侧数据，
// 所有指令住在 functional.ts 的 system 场景里（提示词待架构落地后按真实样本编写）。

import type { MessageContext } from "../types.js";
import type { ChatMessage } from "./types.js";
import { config } from "../config.js";
import { tenantKey } from "../session/key.js";
import { appendEvent, chatRowsAll, db, type EventRow } from "./memory/events.js";
import { renderAttachments } from "./memory/images.js";
import { logger } from "../services/logger.js";

// ---------- token 估算（纯函数，字符启发式） ----------

// 中文≈0.7 token/字、非 ASCII 同档（全角符号/emoji 宁高勿低）、ASCII≈0.25
// token/字符，×1.2 安全系数。预算闸门允许粗估（二期用 usage 实测校准系数）。
export function estimateTokens(text: string): number {
  if (text === "") return 0;
  let nonAscii = 0;
  for (const ch of text) {
    if (ch.codePointAt(0)! > 0x7f) nonAscii++;
  }
  const ascii = text.length - nonAscii;
  return Math.ceil((nonAscii * 0.7 + ascii * 0.25) * 1.2);
}

// ---------- 单行渲染 ----------

// blob 行形态的单一真相源：历史 user 行与 u_now 共用（模型看到统一格式）。
// 文字在前、图片段在后（v8：图文相对顺序平台不给，此为自定义规范顺序）。
// 导出供冒烟测试锚定 M1 提示词示例与其同构（提示词 v2 方案 §8）。
export function renderBlobLine(speaker: string, text: string, imagePart: string): string {
  const content = `${text}${imagePart}`.trim();
  return JSON.stringify({
    speaker,
    content: content === "" ? "（无文字）" : content,
  });
}

function speakerOf(name: string | null | undefined): string {
  return name != null && name.trim() !== "" ? name : "用户";
}

// ---------- 主投影 ----------

export interface Projection {
  messages: ChatMessage[]; // L1 投影（不含 system/u_now——由调用方拼装）
  estimatedTokens: number; // 投影总量估算（预算口径）
  chatCount: number; // 参与投影的 chat 行数（条数安全阀口径）
}

// 形态 B 装配：chat 行流 → [批(user 消息), 裸 assistant, 批, …]。
// 规则（§1.2 终版）：批 = 两个 bot 回复之间的 user 行段；连续 chat_bot 序列
// 整体作一个隔断；process 行不投影（v7）；排除当前消息行（u_now 由 ctx 构造）。
// 压缩（v10）：条数截断（保留最近 CONTEXT_MAX_MESSAGES 行）+ 时间窗
//（SESSION_WINDOW_HOURS，超窗行离开投影）——纯投影行为，不写任何标记行。
export async function projectWindow(ctx: MessageContext): Promise<Projection> {
  const key = tenantKey(ctx.event);

  // 步骤 1 取数（chat 行，v10 后不再按 reset 定位）+ 步骤 2 排除当前消息行。
  const rows = chatRowsAll(key);
  const candidates = rows.filter(
    (r) => !(r.kind === "chat_user" && r.qqMsgId === ctx.event.msgId),
  );

  // 步骤 5a 时间窗（v10 规则②）：created_at 距装配时刻超过 N 小时的行离开
  // 投影。按行级时间戳过滤（行有序，等价于找最老的合规行之后的全部）。
  // 设 0 关闭。时间维度上旧消息整块滑出，窗口与"最近的会话"对齐。
  const windowMs = config.sessionWindowHours * 3600_000;
  const withinWindow =
    windowMs <= 0
      ? candidates
      : candidates.filter((r) => Date.now() - r.createdAt <= windowMs);

  // 步骤 5b 条数截断（v10 规则①）：候选行数超上限时只保留最近 N 行
  //（尾部对齐——最新上下文优先，旧行整块丢弃）。
  const maxMessages = config.contextMaxMessages;
  const kept =
    withinWindow.length > maxMessages ? withinWindow.slice(-maxMessages) : withinWindow;

  // 步骤 3+4：user 行渲染（speaker/content 字段 + 图片段懒展开）。
  // 同一行恒渲染同一字符串（描述写后不重写——缓存红线）。
  const enableVision = config.visionApiKey !== "";
  const rendered = new Map<number, string>();
  await Promise.all(
    kept.map(async (row) => {
      if (row.kind !== "chat_user") return; // chat_bot 行直接透出裸 assistant，无需预渲染
      const imagePart =
        row.attachmentIds !== null && row.attachmentIds.length > 0
          ? " " + (await renderAttachments(row.attachmentIds, key, { enableVision }))
          : "";
      rendered.set(row.id, renderBlobLine(speakerOf(row.authorName), row.content ?? "", imagePart));
    }),
  );

  // 组批：连续 user 行攒批，遇 chat_bot 行封批并透出裸 assistant（连续多条
  // chat_bot 整体作一个隔断——不开空批）。
  const messages: ChatMessage[] = [];
  let batch: string[] = [];
  const flushBatch = (): void => {
    if (batch.length > 0) {
      messages.push({ role: "user", content: batch.join("\n") });
      batch = [];
    }
  };
  for (const row of kept) {
    if (row.kind === "chat_bot") {
      flushBatch();
      messages.push({ role: "assistant", content: row.content ?? "" });
    } else {
      const line = rendered.get(row.id);
      if (line !== undefined) batch.push(line);
    }
  }
  // 末尾未封批的 user 行封为最后一批。u_now 不进批——由调用方作为独立的
  // 最后一条 user 消息追加（"末位 = 当前诉求"的构造性保证，见
  // buildCurrentUserMessage；blob 单行格式与批内行同构，形态统一）。
  flushBatch();

  // token 估算保留为观测口径（v10：不再做闸门；二期用 usage 实测校准系数）。
  const estimated = messages.reduce((sum, m) => sum + estimateTokens(m.content ?? ""), 0);
  if (candidates.length !== kept.length) {
    logger.info(
      "agent",
      `L1 压缩生效：候选 ${candidates.length} 行 → 保留 ${kept.length} 行（条数上限 ${maxMessages}，时间窗 ${config.sessionWindowHours}h）`,
    );
  }

  return { messages, estimatedTokens: estimated, chatCount: kept.length };
}

// ---------- 当前消息（u_now）构造 ----------

// u_now 由 ctx 构造（不取库行）：userText 是入口语义（命令/@ 剥离后的 args），
// 图片按 (key, msgId) 反查后当轮展开（"当轮就要看"）。blob 单行格式与历史行
// 同构，恒为最后一条 user 消息。
export async function buildCurrentUserMessage(
  ctx: MessageContext,
  userText: string,
): Promise<ChatMessage> {
  const event = ctx.event;
  const key = tenantKey(event);
  const attachmentIds = imageIdsForMessage(key, event.msgId);
  const imagePart =
    attachmentIds.length > 0
      ? " " + (await renderAttachments(attachmentIds, key, { enableVision: config.visionApiKey !== "" }))
      : "";
  return {
    role: "user",
    content: renderBlobLine(speakerOf(event.authorName), userText, imagePart),
  };
}

// 按 (key, qq_msg_id) 查图片 id 列表（按事件内序号正序）。u_now 不走库行，
// 这个查询是它的图片等价入口（dispatcher 收口时已入库）。
function imageIdsForMessage(key: string, qqMsgId: string): number[] {
  const rows = db
    .prepare(`SELECT id FROM message_images WHERE key = ? AND qq_msg_id = ? ORDER BY seq ASC`)
    .all(key, qqMsgId) as Array<{ id: number }>;
  return rows.map((r) => r.id);
}
