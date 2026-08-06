// agent/memory/long-term.ts —— 长期记忆的 node:sqlite 实现。
// 单聊/群聊共用一张表，隔离键直接复用 memoryKey()（c2c:<openid> / group:<groupOpenid>），
// 不新增一套隔离逻辑——和短期记忆（sqlite.ts）是同一个隔离粒度，两套表天然同步。
//
// 容量策略：每个 key 硬上限 MAX_MEMORIES 条，add() 内部包办 FIFO 淘汰，
// 调用方（add_memory 工具）不用关心容量逻辑。

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MessageAuthor } from "./types.js";

const MAX_MEMORIES = 5;

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_DIR = join(__dirname, "../../../data");
const DB_PATH = join(DB_DIR, "memory.sqlite");

mkdirSync(DB_DIR, { recursive: true });

// 长期记忆和短期记忆共用同一个数据库文件，各自开一份连接——node:sqlite 允许
// 同进程内多个 DatabaseSync 打开同一个文件，SQLite 本身处理并发访问。
const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS long_term_memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL,
    author_openid TEXT NOT NULL,
    author_name TEXT NOT NULL,
    content TEXT NOT NULL,
    memory_index TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_long_term_key ON long_term_memories(key);
`);

export interface LongTermMemory {
  id: number;
  authorOpenid: string;
  authorName: string;
  content: string;
  memoryIndex: string;
  createdAt: number;
  updatedAt: number;
}

export interface LongTermMemoryStore {
  add(
    key: string,
    author: MessageAuthor,
    content: string,
    memoryIndex: string,
  ): Promise<void>;
  list(key: string): Promise<LongTermMemory[]>; // 按 updated_at 升序，最旧的在前
  remove(id: number): Promise<void>;
}

const listStmt = db.prepare(
  `SELECT id, author_openid, author_name, content, memory_index, created_at, updated_at
   FROM long_term_memories
   WHERE key = ?
   ORDER BY updated_at ASC`,
);

const insertStmt = db.prepare(`
  INSERT INTO long_term_memories (key, author_openid, author_name, content, memory_index, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const deleteStmt = db.prepare("DELETE FROM long_term_memories WHERE id = ?");

function rowToMemory(row: {
  id: number;
  author_openid: string;
  author_name: string;
  content: string;
  memory_index: string;
  created_at: number;
  updated_at: number;
}): LongTermMemory {
  return {
    id: row.id,
    authorOpenid: row.author_openid,
    authorName: row.author_name,
    content: row.content,
    memoryIndex: row.memory_index,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const longTermMemoryStore: LongTermMemoryStore = {
  async list(key: string): Promise<LongTermMemory[]> {
    const rows = listStmt.all(key) as Array<{
      id: number;
      author_openid: string;
      author_name: string;
      content: string;
      memory_index: string;
      created_at: number;
      updated_at: number;
    }>;
    return rows.map(rowToMemory);
  },

  async add(
    key: string,
    author: MessageAuthor,
    content: string,
    memoryIndex: string,
  ): Promise<void> {
    const existing = await this.list(key);
    if (existing.length >= MAX_MEMORIES) {
      // existing 按 updated_at 升序，第一条就是最旧的。
      deleteStmt.run(existing[0].id);
    }
    const now = Date.now();
    insertStmt.run(key, author.openid, author.name, content, memoryIndex, now, now);
  },

  async remove(id: number): Promise<void> {
    deleteStmt.run(id);
  },
};
