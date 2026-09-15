// services/scheduler/store.ts —— 通用定时任务的持久化层，node:sqlite 实现。
// 一张表 scheduled_tasks：自增 id 主键——一个会话可以有多条任务（与原
// news_subscriptions 的"一群一份"最大的 schema 差异）。写法照抄
// agent/memory/sqlite.ts 的风格（同一种 __dirname 换算、mkdirSync、
// CREATE TABLE IF NOT EXISTS、模块级 prepare）。
//
// 会话键（session_key）存两份信息：场景前缀（group:/c2c:）+ 目标 id，
// 触发时反解出"推回哪个群/哪个用户"。独立库文件 scheduler.sqlite
//（与 news.sqlite 同样的"低频配置不与聊天记录混库"考虑）。

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface ScheduledTask {
  id: number;
  sessionKey: string; // 会话键：group:<groupOpenid> 或 c2c:<userOpenid>
  hour: number;
  minute: number;
  prompt: string; // 到点要跑的 /Agent 提示词
  enabled: boolean;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_DIR = join(__dirname, "../../../data");
const DB_PATH = join(DB_DIR, "scheduler.sqlite");

mkdirSync(DB_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS scheduled_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_key TEXT NOT NULL,
    hour INTEGER NOT NULL,
    minute INTEGER NOT NULL,
    prompt TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_scheduled_session ON scheduled_tasks(session_key);
`);

interface TaskRow {
  id: number;
  session_key: string;
  hour: number;
  minute: number;
  prompt: string;
  enabled: number;
}

function rowToTask(row: TaskRow): ScheduledTask {
  return {
    id: row.id,
    sessionKey: row.session_key,
    hour: row.hour,
    minute: row.minute,
    prompt: row.prompt,
    enabled: row.enabled === 1,
  };
}

const insertStmt = db.prepare(`
  INSERT INTO scheduled_tasks (session_key, hour, minute, prompt, enabled, created_at)
  VALUES (?, ?, ?, ?, 1, ?)
`);

const listBySessionStmt = db.prepare(
  `SELECT id, session_key, hour, minute, prompt, enabled
   FROM scheduled_tasks WHERE session_key = ? ORDER BY id`,
);

const listEnabledStmt = db.prepare(
  `SELECT id, session_key, hour, minute, prompt, enabled
   FROM scheduled_tasks WHERE enabled = 1`
);

const deleteStmt = db.prepare("DELETE FROM scheduled_tasks WHERE id = ?");

// ---- 一次性数据迁移（幂等）：修 v1 坏键 ----
// v1 的任务归属键误用了人粒度 sessionKey（群聊为 group:<gid>:<author> 三段），
// 投递目标反解时作者段被拼进了 openid 发给 API（实机 HTTP 500 / code 11300）。
// v2 起改用会话粒度 memoryKey（两段）。启动时把遗留的三段群键砍回两段；
// 两段键（含 c2c）不受影响，跑过的库再跑一遍也没有可改行。
{
  const legacyRows = db
    .prepare(`SELECT id, session_key FROM scheduled_tasks WHERE session_key LIKE 'group:%:%'`)
    .all() as unknown as Array<{ id: number; session_key: string }>;
  const fixStmt = db.prepare("UPDATE scheduled_tasks SET session_key = ? WHERE id = ?");
  for (const row of legacyRows) {
    const parts = row.session_key.split(":");
    if (parts.length === 3) {
      fixStmt.run(`${parts[0]}:${parts[1]}`, row.id);
    }
  }
}

export function addTask(sessionKey: string, hour: number, minute: number, prompt: string): ScheduledTask {
  const result = insertStmt.run(sessionKey, hour, minute, prompt, Date.now());
  // lastInsertRowid 连接级作用域（node:sqlite），INSERT 后立刻读最可靠；
  // bigint | number，Number() 归一（项目内 id 都在安全整数范围内）。
  return {
    id: Number(result.lastInsertRowid),
    sessionKey,
    hour,
    minute,
    prompt,
    enabled: true,
  };
}

export function listTasks(sessionKey: string): ScheduledTask[] {
  const rows = listBySessionStmt.all(sessionKey) as unknown as TaskRow[];
  return rows.map(rowToTask);
}

export function listEnabledTasks(): ScheduledTask[] {
  const rows = listEnabledStmt.all() as unknown as TaskRow[];
  return rows.map(rowToTask);
}

// 删除指定 id 的任务。返回 false = 没这行（id 不存在或不属于该会话）。
// sessionKey 也作为条件：防止 A 会话用 /任务删除 删掉 B 会话的任务（id 猜数）。
export function removeTask(sessionKey: string, id: number): boolean {
  const result = db.prepare(
    "DELETE FROM scheduled_tasks WHERE id = ? AND session_key = ?"
  ).run(id, sessionKey);
  return result.changes > 0;
}
