// services/news/store.ts —— 群新闻订阅配置的持久化层，node:sqlite 实现。
// 一张表 news_subscriptions，以 group_openid 为主键——按群维度配置，
// 每个群独立开关/独立时间/独立关键词。写法照抄 agent/memory/sqlite.ts 的风格
// （同一种 __dirname 换算、同一种 mkdirSync + CREATE TABLE IF NOT EXISTS）。
//
// 和 agent/memory/sqlite.ts 分开建库文件（news.sqlite 而非共用 memory.sqlite）：
// 两者生命周期和访问模式都不同（聊天记录高频读写、订阅配置低频改），分开互不干扰。

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface NewsSubscription {
  groupOpenid: string;
  enabled: boolean;
  hour: number;
  minute: number;
  keyword: string;
  maxResults: number;
}

const DEFAULT_HOUR = 9;
const DEFAULT_MINUTE = 0;
const DEFAULT_KEYWORD = "科技";
const DEFAULT_MAX_RESULTS = 5;

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_DIR = join(__dirname, "../../../data");
const DB_PATH = join(DB_DIR, "news.sqlite");

mkdirSync(DB_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS news_subscriptions (
    group_openid TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 0,
    hour INTEGER NOT NULL DEFAULT ${DEFAULT_HOUR},
    minute INTEGER NOT NULL DEFAULT ${DEFAULT_MINUTE},
    keyword TEXT NOT NULL DEFAULT '${DEFAULT_KEYWORD}',
    max_results INTEGER NOT NULL DEFAULT ${DEFAULT_MAX_RESULTS},
    updated_at INTEGER NOT NULL
  );
`);

interface SubscriptionRow {
  group_openid: string;
  enabled: number;
  hour: number;
  minute: number;
  keyword: string;
  max_results: number;
}

function rowToSubscription(row: SubscriptionRow): NewsSubscription {
  return {
    groupOpenid: row.group_openid,
    enabled: row.enabled === 1,
    hour: row.hour,
    minute: row.minute,
    keyword: row.keyword,
    maxResults: row.max_results,
  };
}

const getStmt = db.prepare(
  `SELECT group_openid, enabled, hour, minute, keyword, max_results
   FROM news_subscriptions WHERE group_openid = ?`,
);

const listEnabledStmt = db.prepare(
  `SELECT group_openid, enabled, hour, minute, keyword, max_results
   FROM news_subscriptions WHERE enabled = 1`,
);

// upsert 用 INSERT ... ON CONFLICT：插入时用默认值兜底缺省字段，冲突时只覆盖
// partial 里传进来的字段——COALESCE(excluded.x, 旧值) 这套在 SQLite 里写起来麻烦，
// 更直接的办法是调用方每次都传全量字段（下面 upsertSubscription 的参数设计成必填），
// 这样一条 REPLACE 语句就能覆盖“新建”和“更新”两种情况，逻辑更简单。
const upsertStmt = db.prepare(`
  INSERT INTO news_subscriptions (group_openid, enabled, hour, minute, keyword, max_results, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(group_openid) DO UPDATE SET
    enabled = excluded.enabled,
    hour = excluded.hour,
    minute = excluded.minute,
    keyword = excluded.keyword,
    max_results = excluded.max_results,
    updated_at = excluded.updated_at
`);

export function getSubscription(groupOpenid: string): NewsSubscription | null {
  const row = getStmt.get(groupOpenid) as SubscriptionRow | undefined;
  return row ? rowToSubscription(row) : null;
}

// 调用方永远传完整字段：想改某一项时，先 getSubscription 拿现有值（或用默认值兜底），
// 只改那一项，再整条传回来——避免在这里再实现一套“部分字段覆盖”的判断逻辑。
export function upsertSubscription(sub: NewsSubscription): void {
  upsertStmt.run(
    sub.groupOpenid,
    sub.enabled ? 1 : 0,
    sub.hour,
    sub.minute,
    sub.keyword,
    sub.maxResults,
    Date.now(),
  );
}

export function listEnabledSubscriptions(): NewsSubscription[] {
  const rows = listEnabledStmt.all() as unknown as SubscriptionRow[];
  return rows.map(rowToSubscription);
}

export const NEWS_DEFAULTS = {
  hour: DEFAULT_HOUR,
  minute: DEFAULT_MINUTE,
  keyword: DEFAULT_KEYWORD,
  maxResults: DEFAULT_MAX_RESULTS,
} as const;
