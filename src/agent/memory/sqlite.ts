// agent/memory/sqlite.ts —— MemoryStore 的 node:sqlite 实现，短期记忆落库持久化。
// 一张表 short_term_messages：存所有会话的消息（单聊/群聊混在一起，靠 key 前缀区分），
// 每条消息记录 role/content/tool_calls 等字段，user 消息额外记录发言人的 openid 和昵称。
//
// 窗口策略（两级，2026-09-05 短期记忆两级化方案）：
//   热窗口 MAX_MESSAGES（20 条）——get() 自动注入每次对话，成本恒定；
//   冷存储 COLD_MESSAGES（300 条）——不自动注入，模型经 recall_memory 工具按需检索
//   （searchCold：关键词命中处前后各 RECALL_CONTEXT 条切片）。表本身无限累积，
//   两个数字都只是读取口径，没有任何清理逻辑——扩容 = 换 LIMIT，零迁移。
//
// node:sqlite 目前是 "Active development" 稳定度（非 Stable），运行时会打一条
// ExperimentalWarning——这是已知权衡，不代表出错。选它是因为 Node 原生内置、
// 不用编译原生模块，够用就不引入 better-sqlite3 这类第三方依赖。
//
// 数据库文件路径：项目根目录下 data/memory.sqlite。data/ 已加入 .gitignore——
// 里面是真实用户的聊天记录，属于隐私数据，不能进版本库。

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MemoryStore, MessageAuthor } from "./types.js";
import type { ChatMessage } from "../types.js";

// 热窗口：最近多少条自动注入（多轮工具调用也会占用窗口）。
const MAX_MESSAGES = 20;

// 冷窗口：recall_memory 可检索的最大深度（条数）。导出给 images.ts 联动——
// 图片 prune 的边界必须与冷窗口一致（方案 §3.5），否则冷区的 [图片:<id>]
// 占位符全部 dangling。
export const COLD_MESSAGES = 300;

// recall 命中条目的切片半径：命中处前后各取这么多条。
export const RECALL_CONTEXT = 10;

// __dirname 在 ESM 下没有现成的全局变量，用 import.meta.url 换算。
// 从 src/agent/memory 往上跳 3 层到项目根目录，再拼 data/memory.sqlite。
const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_DIR = join(__dirname, "../../../data");
const DB_PATH = join(DB_DIR, "memory.sqlite");

mkdirSync(DB_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS short_term_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL,                     -- 会话键（单聊 c2c:<openid>，群聊 group:<groupOpenid>）
    author_openid TEXT,                    -- 发言人 openid（仅 user 消息非空）
    author_name TEXT,                      -- 发言人昵称（仅 user 消息非空）
    role TEXT NOT NULL CHECK(role IN ('system', 'user', 'assistant', 'tool')),
    content TEXT,                          -- 消息正文（允许 NULL，assistant 带 tool_calls 时可能为 null）
    tool_calls TEXT,                       -- JSON.stringify(ToolCall[])，没有工具调用时为 NULL
    tool_call_id TEXT,                     -- 工具结果消息（role=tool）专用
    created_at INTEGER NOT NULL,           -- 时间戳（Date.now()）
    CONSTRAINT valid_user_message CHECK (
      role != 'user' OR (author_openid IS NOT NULL AND author_name IS NOT NULL)
    )
  );
  CREATE INDEX IF NOT EXISTS idx_short_term_key_id ON short_term_messages(key, id);
`);

const insertStmt = db.prepare(`
  INSERT INTO short_term_messages (key, author_openid, author_name, role, content, tool_calls, tool_call_id, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

// 只取最近 MAX_MESSAGES 条：按 id 降序排（最新的在前），LIMIT 截断，然后在应用层再反转回正序。
// 为什么不直接 ORDER BY id ASC LIMIT？因为 SQLite 的 LIMIT 是"取前 N 行"，如果升序取就是最老的 N 条，
// 而我们要的是最新的 N 条，所以必须先降序 LIMIT、再反转。
// "昵称：内容"的说话人格式化已经在写入时做过（agent/context.ts 的 formatSpeakerContent，
// 由 agent/loop.ts 的 prepareContext 节点调用，单聊群聊统一拼前缀），content 落库时
// 已经带前缀，这里原样读出即可，不用二次加工。
const getStmt = db.prepare(
  `SELECT role, content, tool_calls, tool_call_id
   FROM short_term_messages
   WHERE key = ?
   ORDER BY id DESC
   LIMIT ?`,
);

const deleteStmt = db.prepare("DELETE FROM short_term_messages WHERE key = ?");

// 冷检索用：最近 COLD_MESSAGES 条，带 id（切片区间的锚点）和 author_name（渲染
// 说话人），降序取回后在应用层反转成正序再处理。
const coldStmt = db.prepare(
  `SELECT id, role, content, author_name
   FROM short_term_messages
   WHERE key = ?
   ORDER BY id DESC
   LIMIT ?`,
);

// 冷窗口内按消息内容匹配的最低行数（role 过滤：user/assistant 的正文才有检索价值，
// tool 消息是工具原始输出，混进切片只添噪声）。
const COLD_ROLES = new Set(["user", "assistant"]);

export interface ColdHit {
  // 命中区间内的消息（旧→新），每条带说话人渲染（"小明：内容"或"assistant：内容"）
  lines: string[];
}

// 冷存储检索（recall_memory 工具的读取路径，方案 §3.2）：
//   1. 取最近 COLD_MESSAGES 条到内存（300 条常量上限，表无限增长不影响成本）；
//   2. 关键词（不区分大小写）对 user/assistant 消息的 content 做 OR 包含匹配
//      ——模型挑的词是同义候选（"猫/橘猫"），AND 会漏；
//   3. 命中处前后各扩 RECALL_CONTEXT 条，相邻区间合并（[3..12]+[8..20]→[3..20]）；
//   4. 最多返回 3 处（多命中时取最新的 3 处——离现在越近的越可能是用户想找的），
//      防止一次翻出十几个切片撑爆上下文。
export function searchCold(key: string, keywords: string[]): ColdHit[] {
  const kws = keywords
    .map((k) => k.trim().toLowerCase())
    .filter((k) => k !== "");
  if (kws.length === 0) return [];

  const rows = coldStmt.all(key, COLD_MESSAGES) as Array<{
    id: number;
    role: string;
    content: string | null;
    author_name: string | null;
  }>;
  // 降序（新→旧）反转为正序（旧→新），index 0 = 冷窗口里最老的一条
  const timeline = rows.reverse();

  // 逐条匹配，收集命中 index
  const hitIdx: number[] = [];
  for (let i = 0; i < timeline.length; i++) {
    const row = timeline[i];
    if (!COLD_ROLES.has(row.role) || row.content === null) continue;
    const text = row.content.toLowerCase();
    if (kws.some((k) => text.includes(k))) hitIdx.push(i);
  }
  if (hitIdx.length === 0) return [];

  // 命中 index → [start, end] 区间（含前后文半径），相邻/重叠区间合并
  const intervals: Array<{ start: number; end: number }> = [];
  for (const idx of hitIdx) {
    const start = Math.max(0, idx - RECALL_CONTEXT);
    const end = Math.min(timeline.length - 1, idx + RECALL_CONTEXT);
    const last = intervals[intervals.length - 1];
    if (last !== undefined && start <= last.end + 1) {
      last.end = Math.max(last.end, end); // 相邻（gap=1）也合并，避免出现只差一条的碎片
    } else {
      intervals.push({ start, end });
    }
  }

  // 多处命中取最新的 3 处（区间数组天然按时间正序，取尾部）
  const selected = intervals.slice(-3);

  return selected.map((iv) => {
    const lines: string[] = [];
    for (let i = iv.start; i <= iv.end; i++) {
      const row = timeline[i];
      const speaker =
        row.role === "user" ? (row.author_name ?? "用户") : "assistant";
      lines.push(`${speaker}：${row.content ?? ""}`);
    }
    return { lines };
  });
}

export const sqliteMemoryStore: MemoryStore = {
  async get(key: string): Promise<ChatMessage[]> {
    const rows = getStmt.all(key, MAX_MESSAGES) as Array<{
      role: string;
      content: string | null;
      tool_calls: string | null;
      tool_call_id: string | null;
    }>;
    // 降序取出来的，要反转回正序（旧消息在前、新消息在后）
    return rows.reverse().map((row) => ({
      role: row.role as ChatMessage["role"],
      content: row.content,
      tool_calls: row.tool_calls ? JSON.parse(row.tool_calls) : undefined,
      tool_call_id: row.tool_call_id ?? undefined,
    }));
  },

  async append(
    key: string,
    author: MessageAuthor | null,
    ...messages: ChatMessage[]
  ): Promise<void> {
    const now = Date.now();
    for (const msg of messages) {
      insertStmt.run(
        key,
        msg.role === "user" && author ? author.openid : null,
        msg.role === "user" && author ? author.name : null,
        msg.role,
        msg.content,
        msg.tool_calls ? JSON.stringify(msg.tool_calls) : null,
        msg.tool_call_id ?? null,
        now,
      );
    }
  },

  async clear(key: string): Promise<void> {
    deleteStmt.run(key);
  },
};
