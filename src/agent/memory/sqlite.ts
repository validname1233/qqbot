// agent/memory/sqlite.ts —— MemoryStore 的 node:sqlite 实现，短期记忆落库持久化。
// 一张表 short_term_messages：存所有会话的消息（单聊/群聊混在一起，靠 key 前缀区分），
// 每条消息记录 role/content/tool_calls 等字段，user 消息额外记录发言人的 openid 和昵称。
//
// 窗口策略：get() 只取最近 MAX_MESSAGES 条（当前 20 条），旧消息仍在数据库但不参与推理——
// 避免历史无限增长导致 token 成本和推理延迟爆炸。
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

// 保留最近多少条消息——防止历史无限增长（多轮工具调用也会占用轮次）。
const MAX_MESSAGES = 20;

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
// 群聊场景的"昵称：内容"格式化已经在写入时做过（agent/context.ts 的 formatSpeakerContent，
// 由 agent/loop.ts 的 prepareContext 节点调用），content 落库时已经带前缀，
// 这里原样读出即可，不用再按 key 是否群聊二次加工。
const getStmt = db.prepare(
  `SELECT role, content, tool_calls, tool_call_id
   FROM short_term_messages
   WHERE key = ?
   ORDER BY id DESC
   LIMIT ?`,
);

const deleteStmt = db.prepare("DELETE FROM short_term_messages WHERE key = ?");

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
