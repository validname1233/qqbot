// services/workspace-ui/tokens.ts —— 工作台 UI 的凭证表（前端方案 §3）。
// 与 kb 服务器同款的不透明 token 模型：randomBytes(24) 随机串存库，验证即
// 查库反解 scope（= tenantKey），没有任何签名/加密环节。签发方（/工作台
// 命令）与验签方（/ws 路由）同在 bot 进程内，登记簿就在手边——单进程决策
// 的直接红利（对比文档 §2）。
//
// TTL：created_at 判定，过期验证即拒；签发时惰性清理过期行（不挂定时器）。
// 吊销：revokeToken 删行即全量失效——有状态方案独有的能力（HMAC 做不到）。

import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../../config.js";

// 与 conversation_events / message_images 同库共存（data/memory.sqlite），
// 各自开连接——node:sqlite 允许同进程多连接打同一文件（images.ts 先例）。
const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_DIR = join(__dirname, "../../../data");
mkdirSync(DB_DIR, { recursive: true });
const db = new DatabaseSync(join(DB_DIR, config.memoryDbFile));

db.exec(`
  CREATE TABLE IF NOT EXISTS workspace_ui_tokens (
    token TEXT PRIMARY KEY,
    scope TEXT NOT NULL,          -- 租户键（group:<gid> / c2c:<openid>，即 tenantKey）
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_wsui_scope ON workspace_ui_tokens(scope);
`);

const TOKEN_TTL_MS = config.workspaceUiTokenTtlDays * 24 * 60 * 60 * 1000;

// 签发（幂等）：同 scope 已有未过期 token 直接复用——与 kb_issue_link 的
// "同一 scope 重复调用返回同一链接"语义一致，不堆积行。顺带清掉全表过期行。
export function issueToken(scope: string): string {
  const now = Date.now();
  db.prepare(`DELETE FROM workspace_ui_tokens WHERE created_at < ?`).run(now - TOKEN_TTL_MS);
  const existing = db
    .prepare(`SELECT token FROM workspace_ui_tokens WHERE scope = ? AND created_at >= ?`)
    .get(scope, now - TOKEN_TTL_MS) as { token: string } | undefined;
  if (existing !== undefined) return existing.token;
  const token = randomBytes(24).toString("base64url");
  db.prepare(`INSERT INTO workspace_ui_tokens (token, scope, created_at) VALUES (?, ?, ?)`).run(
    token, scope, now,
  );
  return token;
}

// 验证：查库反解 scope；无此行或已过期返回 null（调用方回 401）。
export function verifyToken(token: string): string | null {
  const row = db
    .prepare(`SELECT scope, created_at FROM workspace_ui_tokens WHERE token = ?`)
    .get(token) as { scope: string; created_at: number } | undefined;
  if (row === undefined) return null;
  if (Date.now() - row.created_at >= TOKEN_TTL_MS) return null;
  return row.scope;
}

// 吊销：删行即失效（管理员外泄链接后的补救动作）。
export function revokeToken(token: string): void {
  db.prepare(`DELETE FROM workspace_ui_tokens WHERE token = ?`).run(token);
}
