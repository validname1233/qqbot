// agent/memory/events.ts —— conversation_events 表：对话真相的单一存储
//（记忆与上下文重构总方案 docs/features/2026-10-28-记忆与上下文重构总方案.md 模块一）。
//
// 一张表、两种投影（L1 装配 / L2 档案）：
//   kind=chat_user  —— 用户在 QQ 窗口里说的每一条话（dispatcher 入站收口写入）
//   kind=chat_bot   —— bot 实际发出的每一条回复（qq/messages.ts 出站收口写入）
//   kind=process    —— agent 轮内的中间产物（judge 输出/工具结果，节点就地写入；
//                      v7 决议：不跨轮投影，仅库存档 + 轮内使用）
//   kind=reset      —— 历史遗留（v10：reset 语义废除，不再写入；投影不再读取；
//                      kind 保留仅为表结构兼容）
//   kind=summary    —— 已取消（v10：摘要式压缩取消，永不写入）
//
// 窗口 = 查询（§1.5 终版原则 + v10）：不存在窗口管理器，L1 投影每次装配现算
//（全部 chat 行 + 装配层纯过滤——条数截断与时间窗），压缩是视图行为，
// 不往流里写任何东西。
//
// 旧表 short_term_messages 在本模块 init 时 DROP（2026-10-28 决议：测试环境
// 无兼容负担）。message_images / long_term_memories 与本表同库共存，不受影响。

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../../config.js";
import { logger } from "../../services/logger.js";
import type { ChatMessage } from "../types.js";

// ESM 下无 __dirname 全局，用 import.meta.url 换算。memory/ → 项目根拼 data/。
const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_DIR = join(__dirname, "../../../data");
mkdirSync(DB_DIR, { recursive: true });

export const db = new DatabaseSync(join(DB_DIR, config.memoryDbFile));

// 旧表 DROP（无兼容负担的定案）。IF EXISTS 让全新环境也安全通过。
db.exec(`DROP TABLE IF EXISTS short_term_messages`);

db.exec(`
  CREATE TABLE IF NOT EXISTS conversation_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL,                     -- 租户键（group:<gid> / c2c:<openid>，session/key.ts）
    kind TEXT NOT NULL CHECK(kind IN
      ('chat_user', 'chat_bot', 'process', 'reset', 'summary')),
    author_openid TEXT,                    -- chat_user 必填；其余为 NULL
    author_name TEXT,                      -- 同上
    role TEXT NOT NULL,                    -- 投影到 ChatMessage 的 role（chat_bot→assistant 等）
    content TEXT,                          -- chat 行存 QQ 原文；process 存模型原文；reset 为 NULL
    attachment_ids TEXT,                   -- v8：JSON 整数数组 → message_images.id；无图为 NULL
    tool_calls TEXT,                       -- process 行专用（JSON 字符串）
    tool_call_id TEXT,                     -- process 行专用
    qq_msg_id TEXT,                        -- chat_user 行必填；process/chat_bot/reset 为 NULL
    origin TEXT,                           -- 来源标记（agent/deep-search/poker/reminder/help/…）
    created_at INTEGER NOT NULL,
    UNIQUE(key, qq_msg_id)                 -- chat_user 去重（QQ 会重推同一条事件；
                                           -- SQLite 中 NULL 互不相等，其余 kind 不受约束）
  );
  CREATE INDEX IF NOT EXISTS idx_conv_key_id      ON conversation_events(key, id);
  CREATE INDEX IF NOT EXISTS idx_conv_key_kind_id ON conversation_events(key, kind, id);
`);

// 事件行的干净形状（本模块对外暴露的行类型）。
export interface EventRow {
  id: number;
  key: string;
  kind: "chat_user" | "chat_bot" | "process" | "reset" | "summary";
  authorOpenid: string | null;
  authorName: string | null;
  role: string;
  content: string | null;
  attachmentIds: number[] | null;
  toolCalls: ChatMessage["tool_calls"];
  toolCallId: string | null;
  qqMsgId: string | null;
  origin: string | null;
  createdAt: number;
}

interface RawRow {
  id: number;
  key: string;
  kind: string;
  author_openid: string | null;
  author_name: string | null;
  role: string;
  content: string | null;
  attachment_ids: string | null;
  tool_calls: string | null;
  tool_call_id: string | null;
  qq_msg_id: string | null;
  origin: string | null;
  created_at: number;
}

function toRow(r: RawRow): EventRow {
  return {
    id: r.id,
    key: r.key,
    kind: r.kind as EventRow["kind"],
    authorOpenid: r.author_openid,
    authorName: r.author_name,
    role: r.role,
    content: r.content,
    attachmentIds: r.attachment_ids === null ? null : (JSON.parse(r.attachment_ids) as number[]),
    toolCalls: r.tool_calls === null ? undefined : (JSON.parse(r.tool_calls) as NonNullable<ChatMessage["tool_calls"]>),
    toolCallId: r.tool_call_id,
    qqMsgId: r.qq_msg_id,
    origin: r.origin,
    createdAt: r.created_at,
  };
}

// ---------- 写入 ----------

export interface AppendEventInput {
  key: string;
  kind: EventRow["kind"];
  role: string;
  author?: { openid: string; name: string } | null;
  content?: string | null;
  attachmentIds?: number[] | null;
  qqMsgId?: string | null;
  origin?: string | null;
  // process 行专用：assistant(tool_calls) / tool 消息的协议字段
  toolCalls?: ChatMessage["tool_calls"];
  toolCallId?: string;
}

// OR IGNORE：chat_user 撞 UNIQUE(key, qq_msg_id)（QQ 重推同一条事件）时静默
// 跳过而非抛错——"吸收重推"的兑现形态。其余 kind 的 qq_msg_id 为 NULL，
// SQLite 中 NULL 互不相等，不受该约束影响，OR IGNORE 对它们等于普通 INSERT。
const insertStmt = db.prepare(`
  INSERT OR IGNORE INTO conversation_events
    (key, kind, author_openid, author_name, role, content, attachment_ids,
     tool_calls, tool_call_id, qq_msg_id, origin, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

// 返回新行 id；重推被 IGNORE 时无新行（changes=0），返回 null。
export function appendEvent(e: AppendEventInput): number | null {
  const result = insertStmt.run(
    e.key,
    e.kind,
    e.author?.openid ?? null,
    e.author?.name ?? null,
    e.role,
    e.content ?? null,
    e.attachmentIds ? JSON.stringify(e.attachmentIds) : null,
    e.toolCalls ? JSON.stringify(e.toolCalls) : null,
    e.toolCallId ?? null,
    e.qqMsgId ?? null,
    e.origin ?? null,
    Date.now(),
  );
  return result.changes === 0 ? null : Number(result.lastInsertRowid);
}

// ---------- 读取（两种投影 + 支撑查询） ----------

// L1 取数：全部 chat 行（v10：不再按 reset 定位——reset 语义已废，压缩
// 改为装配层的纯投影行为；process 行照旧不取，v7）。正序返回（旧→新）。
const chatAllStmt = db.prepare(`
  SELECT * FROM conversation_events
  WHERE key = ? AND kind IN ('chat_user', 'chat_bot')
  ORDER BY id ASC
`);

export function chatRowsAll(key: string): EventRow[] {
  const raw = chatAllStmt.all(key) as unknown as RawRow[];
  return raw.map(toRow);
}

// L2 取数之一：最近 n 条 chat 行（recall_memory 用），正序返回。
const chatTailStmt = db.prepare(`
  SELECT * FROM conversation_events
  WHERE key = ? AND kind IN ('chat_user', 'chat_bot')
  ORDER BY id DESC LIMIT ?
`);

export function chatRows(key: string, n: number): EventRow[] {
  const raw = chatTailStmt.all(key, n) as unknown as RawRow[];
  return raw.reverse().map(toRow);
}

// L2 取数之二（recall 窗口外回看）：id 小于 beforeId 的最近 n 条 chat 行，
// 正序返回。recall_memory 用它取"L1 窗口之外"的历史（窗口内模型原文可见，
// 无需回看）——beforeId = 窗口最早行的 id（由装配层的 windowCandidates 算出，
// 保证边界与投影口径一致）。
const chatBeforeStmt = db.prepare(`
  SELECT * FROM conversation_events
  WHERE key = ? AND id < ? AND kind IN ('chat_user', 'chat_bot')
  ORDER BY id DESC LIMIT ?
`);

export function chatRowsBefore(key: string, beforeId: number, n: number): EventRow[] {
  const raw = chatBeforeStmt.all(key, beforeId, n) as unknown as RawRow[];
  return raw.reverse().map(toRow);
}

// 清空某租户全部行（评测脚本隔离清理用）。
const clearStmt = db.prepare(`DELETE FROM conversation_events WHERE key = ?`);
export function clearEvents(key: string): void {
  clearStmt.run(key);
}

logger.info("memory", "conversation_events 就绪（旧表 short_term_messages 已清除）");
