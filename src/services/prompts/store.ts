// services/prompts/store.ts —— 提示词存储层：管理数据库中的自定义人格数据。
// 启动时加载全部到内存缓存，运行时修改后同步刷新缓存，避免每次调用都查库。

import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setPersonalityCache, clearPersonalityCache } from "./functional.js";
import { logger } from "../logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.resolve(__dirname, "../../../data/prompts.sqlite");

const db = new Database(dbPath);

// 建表 + 迁移：启动时自动执行
db.exec(`
  CREATE TABLE IF NOT EXISTS group_personalities (
    key TEXT PRIMARY KEY,
    personality TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )
`);

interface PersonalityRow {
  key: string;
  personality: string;
  updated_at: number;
}

const getStmt = db.prepare<[string], PersonalityRow>(
  "SELECT key, personality, updated_at FROM group_personalities WHERE key = ?",
);

const upsertStmt = db.prepare<[string, string, number]>(`
  INSERT INTO group_personalities (key, personality, updated_at)
  VALUES (?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET personality = excluded.personality, updated_at = excluded.updated_at
`);

const listAllStmt = db.prepare<[], PersonalityRow>(
  "SELECT key, personality, updated_at FROM group_personalities",
);

// 读取一条记录（运行时基本用不上，因为都走缓存；这里主要用于调试或管理端查询）。
// 2026-10-29 改名：getPersonality 这个名字现在归 functional.ts 的缓存取用函数
//（入参是 event、带默认兜底）；这是裸查库版，改名避免两个同名不同签名的导出。
export function getPersonalityFromDb(key: string): string | null {
  const row = getStmt.get(key);
  return row ? row.personality : null;
}

// 写入/更新一条记录，并同步刷新缓存
export function setPersonality(key: string, personality: string): void {
  const now = Date.now();
  upsertStmt.run(key, personality, now);
  setPersonalityCache(key, personality);
}

// 删除一条记录（恢复默认人格），并同步清缓存。没设置过时返回 false，
// 由调用方决定要不要提示"本来就没设置"。
export function clearPersonality(key: string): boolean {
  const result = db.prepare("DELETE FROM group_personalities WHERE key = ?").run(key);
  clearPersonalityCache(key);
  return result.changes > 0;
}

// 启动时加载全部自定义人格到缓存
export function initializePersonalities(): void {
  const rows = listAllStmt.all();
  for (const row of rows) {
    setPersonalityCache(row.key, row.personality);
  }
  logger.info("prompts", `已加载 ${rows.length} 条自定义人格到缓存`);
}
