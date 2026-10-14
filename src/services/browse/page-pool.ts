// services/browse/page-pool.ts —— 租户粒度的"最近浏览"快照池（内存，不落库）。
// 作用：open_page 的 link 编号要能查到"上一次打开的页面里编号 2 是哪个 URL"。
// key 用 tenantKey（群粒度，2026-10-14 键统一）：一群一池。同群并发深检被
// 并发闸（interrupt）拒绝，池不会被并发访问——天然无覆盖问题。
// TTL 兜底回收，不做定时器——读取时顺手清过期项就够了（池子很小，不值得常驻定时任务）。

import type { BotEvent } from "../../events/registry.js";
import { tenantKey } from "../../session/key.js";
import type { ExtractedPage } from "./extract.js";

const MAX_PAGES_PER_POOL = 8; // 每人保留最近 8 个页面快照
const POOL_TTL_MS = 10 * 60 * 1000; // 10 分钟：一次深检内的编号引用肯定存活，跨次深检自然失效

interface PoolEntry {
  url: string;
  page: ExtractedPage;
  savedAt: number;
}

const pools = new Map<string, Map<string, PoolEntry>>();

function getPool(key: string): Map<string, PoolEntry> {
  let pool = pools.get(key);
  if (pool === undefined) {
    pool = new Map();
    pools.set(key, pool);
  }
  return pool;
}

// 顺手清理：过期的整池删、超量的删最旧的（Map 迭代序=插入序，first 即最旧）。
function evict(key: string): void {
  const pool = pools.get(key);
  if (pool === undefined) return;

  const now = Date.now();
  for (const [url, entry] of pool) {
    if (now - entry.savedAt > POOL_TTL_MS) pool.delete(url);
  }
  while (pool.size > MAX_PAGES_PER_POOL) {
    const oldest = pool.keys().next().value;
    if (oldest === undefined) break;
    pool.delete(oldest);
  }
  if (pool.size === 0) pools.delete(key);
}

// 记录一次浏览：同 URL 重新打开会刷新内容与时间（Map 同键覆盖，但覆盖后迭代序不变，
// 对"最近 8 页"的语义影响可忽略）。
export function savePage(event: BotEvent, url: string, page: ExtractedPage): void {
  const key = tenantKey(event);
  getPool(key).set(url, { url, page, savedAt: Date.now() });
  evict(key);
}

// 按编号取链接：查"最近一次保存的页面"的链接表。
// 返回 null 表示编号失效（池空/页面过期/编号越界），调用方给模型明确的错误文案。
export function resolveLink(event: BotEvent, linkNo: number): string | null {
  const key = tenantKey(event);
  evict(key);
  const pool = pools.get(key);
  if (pool === undefined || pool.size === 0) return null;

  let latest: PoolEntry | null = null;
  for (const entry of pool.values()) {
    if (latest === null || entry.savedAt > latest.savedAt) latest = entry;
  }
  if (latest === null) return null;

  const link = latest.page.links.find((item) => item.no === linkNo);
  return link?.url ?? null;
}

// 测试/本地验证用：清空全部池子。
export function clearPagePools(): void {
  pools.clear();
}
