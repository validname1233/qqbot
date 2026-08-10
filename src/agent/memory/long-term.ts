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
import { embedText } from "../../services/embedding.js";

const MAX_MEMORIES = 30;

// RAG 召回相似度阈值：先给个保守估计，实际效果要跑几轮真实对话再调。
const MIN_SIMILARITY = 0.35;

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

// 迁移：老数据库文件建表时没有 embedding 列，CREATE TABLE IF NOT EXISTS 不会给已存在的表补列，
// 所以启动时单独检查一次，不存在就 ALTER TABLE 补上。旧记录迁移后 embedding 是 NULL，
// 会被 search() 的 WHERE embedding IS NOT NULL 过滤掉，靠 FIFO 淘汰自然替换，不写回填脚本。
const columns = db.prepare(`PRAGMA table_info(long_term_memories)`).all() as Array<{ name: string }>;
if (!columns.some((c) => c.name === "embedding")) {
  db.exec(`ALTER TABLE long_term_memories ADD COLUMN embedding TEXT`);
}

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
  list(key: string): Promise<LongTermMemory[]>; // 按 updated_at 升序，最旧的在前；delete_memory 候选列表用
  remove(id: number): Promise<void>;
  search(key: string, queryText: string, topK: number): Promise<LongTermMemory[]>; // RAG 召回专用
}

const listStmt = db.prepare(
  `SELECT id, author_openid, author_name, content, memory_index, created_at, updated_at
   FROM long_term_memories
   WHERE key = ?
   ORDER BY updated_at ASC`,
);

const insertStmt = db.prepare(`
  INSERT INTO long_term_memories (key, author_openid, author_name, content, memory_index, embedding, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const deleteStmt = db.prepare("DELETE FROM long_term_memories WHERE id = ?");

const searchCandidatesStmt = db.prepare(`
  SELECT id, author_openid, author_name, content, memory_index, embedding, created_at, updated_at
  FROM long_term_memories
  WHERE key = ? AND embedding IS NOT NULL
`);

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

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
    const embedding = await embedText(content); // 对原文 content 做 embedding，不是摘要
    const existing = await this.list(key);
    if (existing.length >= MAX_MEMORIES) {
      // existing 按 updated_at 升序，第一条就是最旧的。
      deleteStmt.run(existing[0].id);
    }
    const now = Date.now();
    insertStmt.run(key, author.openid, author.name, content, memoryIndex, JSON.stringify(embedding), now, now);
  },

  async remove(id: number): Promise<void> {
    deleteStmt.run(id);
  },

  async search(key: string, queryText: string, topK: number): Promise<LongTermMemory[]> {
    const queryEmbedding = await embedText(queryText);
    const rows = searchCandidatesStmt.all(key) as Array<{
      id: number;
      author_openid: string;
      author_name: string;
      content: string;
      memory_index: string;
      embedding: string;
      created_at: number;
      updated_at: number;
    }>;

    const ranked = rows
      .map((row) => ({ row, similarity: cosineSimilarity(queryEmbedding, JSON.parse(row.embedding) as number[]) }))
      .filter(({ similarity }) => similarity >= MIN_SIMILARITY)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, topK);

    console.log(
      `[长期记忆] 召回 ${ranked.length} 条（按相似度降序）：${ranked
        .map(({ row, similarity }) => `[${similarity.toFixed(3)}] ${row.memory_index}`)
        .join("; ")}`,
    );

    return ranked.map(({ row }) => rowToMemory(row));
  },
};
