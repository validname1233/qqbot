// agent/memory/images.ts —— 对话图片的伴生表：懒加载识图的存储层（v8 改造版）。
// 设计文档：docs/features/2026-10-28-记忆与上下文重构总方案.md 模块一 §1.3
//
// 核心思想「下载要急，理解要懒」不变：
//   收到带图消息时（persistEventImages）——只下载存盘 + 记一行元数据，零 API 成本；
//   装配投影时（renderAttachments）——才读文件调千问识图，描述回写 description
//   列作缓存，后续轮次直接复用。
//
// v8 三项改造（对照旧版）：
//   ① 占位符退役：conversation_events.content 存 QQ 原文，图片经 attachment_ids
//     引用列关联本表；渲染入口从"正则扫 content"改为"遍历 id 列表"。
//   ② UNIQUE 从 (key,qq_msg_id,filename) 改 (key,qq_msg_id,seq)——同消息多张
//     同元数据图（实测 filename/宽高/大小可全同、fileid 每张唯一）不再被吞。
//   ③ prune 锚点从旧表 COLD_MESSAGES 改为"最近 N 条 chat 行内被引用的图片"。
//
// 缓存红线：description 一经回写永不重写（行丢失时降级 [图片]，不重新识图）——
// 同一行历史必须永远渲染成同一字符串，前缀缓存依赖这一点。

import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BotEvent } from "../../events/registry.js";
import { isImageAttachment } from "../../events/attachments.js";
import { tenantKey } from "../../session/key.js";
import { chatRows } from "./events.js";
import { config } from "../../config.js";
import { describeImage } from "../../services/vision.js";
import { logger } from "../../services/logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_DIR = join(__dirname, "../../../data");
const IMAGE_DIR = join(DB_DIR, "images");

mkdirSync(IMAGE_DIR, { recursive: true });

// 与 conversation_events 共用同一个库文件（events.ts 已建好表）；各自开一份
// 连接，node:sqlite 允许同进程多连接打同一文件。
const db = new DatabaseSync(join(DB_DIR, config.memoryDbFile));

// v8 迁移（一次性，总方案模块一 §1.3）：旧表没有 seq/fileid 列，CREATE IF
// NOT EXISTS 对已存在的旧表会整段短路，后续 INSERT 撞 "no such column: seq"
//（2026-10-28 服务器首跑实锤）。因此检测到旧 schema 时 DROP 重建——只做一次
//（新 schema 就位后 table_info 能查到 seq，不再触发）。若写成无条件 DROP，
// 每次重启都清空描述缓存、历史图片全部重新识图——缓存红线被部署周期击穿。
// 旧表数据仅为识图描述缓存，迁移期一次性丢失 = 下次重新识图，可接受。
const columns = db.prepare(`PRAGMA table_info(message_images)`).all() as Array<{ name: string }>;
const columnNames = new Set(columns.map((c) => c.name));
if (columns.length > 0 && !columnNames.has("seq")) {
  db.exec(`DROP TABLE message_images`);
  logger.warn("images", "检测到旧版 message_images（无 seq 列），已 DROP 重建——识图描述缓存清空，下次装配重新识图");
}

// fileid（图片全局唯一身份，排查/跨消息比对用，不做约束键）、
// seq（事件内附件数组序，UNIQUE 成员）。
db.exec(`
  CREATE TABLE IF NOT EXISTS message_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL,
    qq_msg_id TEXT NOT NULL,
    seq INTEGER NOT NULL DEFAULT 0,
    fileid TEXT,
    filename TEXT NOT NULL,
    content_type TEXT NOT NULL,
    width INTEGER, height INTEGER, size INTEGER,
    file_path TEXT NOT NULL,
    description TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE(key, qq_msg_id, seq)
  );
  CREATE INDEX IF NOT EXISTS idx_message_images_key ON message_images(key);
`);

// ---------- 内部工具 ----------

// QQ 消息 id 含 '/' 和 '.'，直接当文件名有路径分隔符风险，且不同附件要互相
// 区分——用自增 id 做主文件名最稳，扩展名从原始 filename 提取。
function fileExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  const ext = dot >= 0 ? filename.slice(dot + 1) : "";
  return /^[a-zA-Z0-9]{1,8}$/.test(ext) ? ext : "jpg";
}

// fetch 下载图片字节。超时 10s（挂在消息处理链路，不能拖住整个 handler）；
// 10MB 上限（千问 Base64 建议 7MB 内，留余量，超限放弃不入库）。
const DOWNLOAD_TIMEOUT_MS = 10_000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

async function downloadImage(url: string): Promise<Uint8Array | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_IMAGE_BYTES) {
      logger.warn("images", `图片过大（${buffer.byteLength}字节），跳过入库`);
      return null;
    }
    return new Uint8Array(buffer);
  } catch (err) {
    logger.warn("images", `图片下载失败: ${err instanceof Error ? err.message : err}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// 窗口外图片清理：删行 + 删文件成对。锚点（v8）：最近 N 条 chat 行（与 recall
// 深度同源 RECALL_DEPTH_N）内被 attachment_ids 引用的图片保留；更早的清掉。
// 引用列表从 conversation_events 现查（chat 行的 attachment_ids 列）。
function pruneImagesOutsideWindow(key: string): void {
  const rows = chatRows(key, config.recallDepthN);
  const referenced = new Set<number>();
  for (const row of rows) {
    for (const id of row.attachmentIds ?? []) referenced.add(id);
  }

  const all = db.prepare(
    `SELECT id, file_path FROM message_images WHERE key = ?`,
  ).all(key) as Array<{ id: number; file_path: string }>;
  const stale = all.filter((r) => !referenced.has(r.id));
  if (stale.length === 0) return;

  const deleteStmt = db.prepare(`DELETE FROM message_images WHERE id = ?`);
  for (const row of stale) {
    try {
      unlinkSync(row.file_path);
    } catch {
      // 文件可能已被删过（重复清理）或写入失败——行照删，不让残留阻塞清理
    }
    deleteStmt.run(row.id);
  }
  logger.info("images", `清理窗口外图片 ${stale.length} 张（key=${key.slice(0, 12)}…）`);
}

// ---------- 写入侧（dispatcher 经 transcript.recordInbound 调用） ----------

// 下载 event.attachments 中的图片，按事件内数组序（seq）入库，返回 id 列表
//（顺序与 attachments 中图片顺序一致，供 attachment_ids 引用列使用）。
// 单张失败跳过（那张图之后不存在，Agent 无感知降级）；QQ 重推由
// UNIQUE(key, qq_msg_id, seq) 吸收（重复行 changes=0，不重复写盘）。
export async function persistEventImages(event: BotEvent): Promise<number[]> {
  const images = event.attachments.filter(isImageAttachment);
  if (images.length === 0) return [];

  const key = tenantKey(event);
  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO message_images
      (key, qq_msg_id, seq, fileid, filename, content_type, width, height, size, file_path, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertedIds: number[] = [];
  for (let seq = 0; seq < images.length; seq++) {
    const img = images[seq];
    const bytes = await downloadImage(img.url);
    if (bytes === null) continue;

    const result = insertStmt.run(
      key, event.msgId, seq, img.fileid ?? null, img.filename, img.contentType,
      img.width ?? null, img.height ?? null, img.size ?? null,
      "", Date.now(),
    );
    if (result.changes === 0) continue; // 重推（UNIQUE 撞了），不重复写盘

    const filePath = join(IMAGE_DIR, `${result.lastInsertRowid}.${fileExtension(img.filename)}`);
    writeFileSync(filePath, bytes);
    db.prepare(`UPDATE message_images SET file_path = ? WHERE id = ?`).run(filePath, result.lastInsertRowid);
    logger.info("images", `图片入库 ${filePath}（${bytes.length}字节，key=${key.slice(0, 12)}…）`);
    insertedIds.push(Number(result.lastInsertRowid));
  }

  pruneImagesOutsideWindow(key);
  return insertedIds;
}

// ---------- 读取侧（装配管线第 4 步 / recall 文本包共用） ----------

// 引用列驱动的渲染：把 attachment_ids 展开成带描述的文本段。
// 规范顺序：文字在前、图片段在后（QQ 平台不给图文相对顺序，此为自定义规范）。
// 降级规则（每种独立）：行不存在（被 prune/跨租户）→ [图片]；超 VISION_MAX_IMAGES
//（只识 id 最大的 N 张）→ [图片]；识图失败 → [图片]{该图片暂时无法识别}。
export async function renderAttachments(
  attachmentIds: number[],
  key: string,
  opts: { enableVision: boolean },
): Promise<string> {
  if (attachmentIds.length === 0) return "";

  const getStmt = db.prepare(
    `SELECT id, filename, content_type, file_path, description FROM message_images WHERE id = ? AND key = ?`,
  );
  interface ImageRow {
    id: number; filename: string; content_type: string;
    file_path: string; description: string | null;
  }
  const rows = new Map<number, ImageRow>();
  for (const id of attachmentIds) {
    const row = getStmt.get(id, key) as unknown as ImageRow | undefined;
    if (row !== undefined) rows.set(id, row);
  }

  // 上限保护：只识 id 最大的 N 张（id 自增 ≈ 最近入库的 N 张）。
  const eligible = [...rows.keys()].sort((a, b) => a - b).slice(-config.visionMaxImages);

  const descriptions = new Map<number, string>();
  await Promise.all(
    eligible.map(async (id) => {
      const row = rows.get(id);
      if (row === undefined) return;
      if (row.description !== null) {
        descriptions.set(id, row.description); // 缓存命中，零成本复用
        return;
      }
      // 功能未启用：不读文件不识图，最后降级 [图片]（与旧版降级矩阵一致）。
      if (!opts.enableVision) return;
      try {
        const bytes = readFileSync(row.file_path);
        const description = await describeImage(bytes, row.content_type);
        // 回写缓存带 key（不变量在语句本身可见）；写后永不重写（缓存红线）。
        db.prepare(`UPDATE message_images SET description = ? WHERE id = ? AND key = ?`).run(
          description, id, key,
        );
        descriptions.set(id, description);
      } catch (err) {
        logger.warn("images", `识图失败 id=${id}: ${err instanceof Error ? err.message : err}`);
        descriptions.set(id, "该图片暂时无法识别");
      }
    }),
  );

  return attachmentIds
    .map((id) => {
      const description = descriptions.get(id);
      return description === undefined ? "[图片]" : `[图片]{${description}}`;
    })
    .join(" ");
}
