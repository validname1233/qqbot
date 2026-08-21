// agent/memory/images.ts —— 短期记忆的「图片伴生表」：懒加载识图的存储层。
// 设计文档：docs/superpowers/specs/2026-08-19-图片懒加载理解方案.md
//
// 核心思想「下载要急，理解要懒」：
//   收到带图消息时（persistEventImages）——只下载存盘 + 记一行元数据，零 API 成本；
//   /Agent 触发时（expandImagePlaceholders）——才读文件调千问识图，描述回写
//   description 列作缓存，后续 /Agent 直接复用，不重复付费。
//
// 占位符方案：落库的 content 带 [图片:<id>]（存"引用"不存描述），/Agent 读取时
// 展开成 [图片]{描述}——描述长在消息里，位置/作者/时序天然正确。
//
// 为什么单独一张表而不是塞进 short_term_messages：那张表是 append-only 的纯文本
// ChatMessage，而图片行的生命周期是「先插入（description=NULL）→ 后回填」，
// 还挂着磁盘文件（清理要删行+删文件成对操作）。两本账挂在同一个会话 key 下：
// 消息表记"说了什么"，这张表记"发过什么图"。

import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BotEvent } from "../../events/registry.js";
import { isImageAttachment } from "../../events/attachments.js";
import { memoryKey } from "../context.js";
import { describeImage } from "../../services/vision.js";
import { logger } from "../../services/logger.js";
import { config } from "../../config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_DIR = join(__dirname, "../../../data");
const IMAGE_DIR = join(DB_DIR, "images");

mkdirSync(IMAGE_DIR, { recursive: true });

// 与短期记忆共用同一个库文件（memory.sqlite），库连接各自开一份——
// node:sqlite 允许同进程多个 DatabaseSync 打开同一文件，SQLite 自己处理并发。
// 注意：召回测试用 MEMORY_DB_PATH 指向独立库时不经过本文件，互不干扰。
const db = new DatabaseSync(join(DB_DIR, "memory.sqlite"));

db.exec(`
  CREATE TABLE IF NOT EXISTS message_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL,                      -- 会话键，与短期记忆同款（group:<id> / c2c:<id>）
    qq_msg_id TEXT NOT NULL,                -- QQ 消息 id（UNIQUE 约束的成员，防重复事件重复入库）
    filename TEXT NOT NULL,
    content_type TEXT NOT NULL,
    width INTEGER, height INTEGER, size INTEGER,
    file_path TEXT NOT NULL,                -- data/images/ 下的绝对路径
    description TEXT,                       -- 识图结果缓存（首次 /Agent 时回填，NULL=未识图）
    created_at INTEGER NOT NULL,
    UNIQUE(key, qq_msg_id, filename)
  );
  CREATE INDEX IF NOT EXISTS idx_message_images_key ON message_images(key);
`);

// ---------- 内部工具 ----------

// QQ 消息 id 含 '/' 和 '.'（如 ROBOT1.0_xxx），直接当文件名有路径分隔符风险，
// 且不同附件要互相区分——用自增 id 做主文件名最稳，扩展名从原始 filename 提取。
function fileExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  const ext = dot >= 0 ? filename.slice(dot + 1) : "";
  return /^[a-zA-Z0-9]{1,8}$/.test(ext) ? ext : "jpg";
}

// fetch 下载图片字节。超时上限和大小上限都做硬保护：
//   超时 10s——图片下载挂在消息处理链路里，不能让一张慢图拖住整个 handler；
//   10MB——千问 Base64 建议 7MB 内，留些余量，超限的图直接放弃（不入库）。
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

// 窗口外图片的清理：删行 + 删文件成对。窗口判定用时间对齐——图片的 created_at
// 早于"窗口内最旧一条消息"的 created_at 即出窗。short_term_messages 不存 qq_msg_id，
// 加列关联成本高，时间对齐的误差（同毫秒边界一两条消息）对"最近几张图"语义无害。
// 触发时机：新图片入库时、/Agent 查询时——都是"本来就要碰这个 key"的时点，不需要定时任务。
function pruneImagesOutsideWindow(key: string): void {
  // 窗口内最旧消息的 created_at：短期记忆的读取口径是"最近 MAX_MESSAGES 条"，
  // 这里用同一条 SQL 反查（ORDER BY id DESC LIMIT 20 取第 20 条的 created_at）。
  // MAX_MESSAGES 写死成 20 与 sqlite.ts 保持一致（它没导出这个常量，导出改动面更大，
  // 两处写死加注释互指，改窗口大小时两处都要动——显式优于隐式耦合）。
  const windowRow = db.prepare(
    `SELECT created_at FROM short_term_messages
     WHERE key = ?
     ORDER BY id DESC
     LIMIT 1 OFFSET 19`,
  ).get(key) as { created_at: number } | undefined;

  if (windowRow === undefined) return; // 该 key 消息不足 20 条，无出窗可言

  const stale = db.prepare(
    `SELECT id, file_path FROM message_images WHERE key = ? AND created_at < ?`,
  ).all(key, windowRow.created_at) as Array<{ id: number; file_path: string }>;

  if (stale.length === 0) return;
  const deleteStmt = db.prepare(`DELETE FROM message_images WHERE id = ?`);
  for (const row of stale) {
    try {
      unlinkSync(row.file_path);
    } catch {
      // 文件可能已被删过（重复清理）或本来就写入失败——行照删，不让文件残留阻塞清理
    }
    deleteStmt.run(row.id);
  }
  logger.info("images", `清理窗口外图片 ${stale.length} 张（key=${key}）`);
}

// ---------- 对外：写入侧（收到消息时） ----------

// 下载 event.attachments 中的图片（isImageAttachment 过滤）并存盘、建行。
// 返回插入成功的图片 id 列表（调用方用它拼 [图片:<id>] 占位符，见 expandImagePlaceholders）。
// 单张失败：log + 跳过（那张图之后就是不存在的，Agent 无感知降级）。
// 没有图片附件时返回空数组；调用方（memory-log observer / agentService）不需要预判。
export async function persistEventImages(event: BotEvent): Promise<number[]> {
  const images = event.attachments.filter(isImageAttachment);
  if (images.length === 0) return [];

  const key = memoryKey(event);
  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO message_images
      (key, qq_msg_id, filename, content_type, width, height, size, file_path, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertedIds: number[] = [];
  for (const img of images) {
    const bytes = await downloadImage(img.url);
    if (bytes === null) continue;

    // 先拿自增 id 再写文件：行插进去才有 id，文件名用 id 命名。
    // INSERT OR IGNORE 吞掉重复事件（QQ 会重推同一条消息），文件名按"行已存在"处理时
    // 直接跳过写盘（同 id 重复下载的场景 UNIQUE 约束先挡住，不会走到写盘）。
    const result = insertStmt.run(
      key, event.msgId, img.filename, img.contentType,
      img.width ?? null, img.height ?? null, img.size ?? null,
      "", Date.now(),
    );
    if (result.changes === 0) continue; // 重复消息（UNIQUE 撞了），不再写盘

    const filePath = join(IMAGE_DIR, `${result.lastInsertRowid}.${fileExtension(img.filename)}`);
    writeFileSync(filePath, bytes);
    db.prepare(`UPDATE message_images SET file_path = ? WHERE id = ?`).run(filePath, result.lastInsertRowid);
    logger.info("images", `图片入库 ${filePath}（${bytes.length}字节，key=${key}）`);
    insertedIds.push(Number(result.lastInsertRowid));
  }

  pruneImagesOutsideWindow(key);
  return insertedIds;
}

// ---------- 对外：读取侧（/Agent 触发时） ----------

// 短期记忆里存的 content 带 [图片:<id>] 占位符（写入时生成，见 persistEventImages 的
// 调用方），本函数在 /Agent 触发时把它们展开成 [图片]{描述}——描述调千问生成，
// 回写 description 列缓存，重复 /Agent 零成本复用。占位符"长在消息里"，展开后
// 位置/作者（群聊昵称前缀）/时序天然正确，不需要独立的图片上下文块。
//
// 降级规则（每种独立，互不拖垮）：
//   行不存在（已被 prune，理论上消息出窗时图也同死，仅时间对齐误差兜底）→ [图片]
//   VISION_API_KEY 未配置（功能整体关闭）                          → [图片]
//   超出 VISION_MAX_IMAGES 上限（只识图 id 最大的 N 张，即最近的）   → [图片]
//   识图调用失败                                                  → [图片]{该图片暂时无法识别}
const PLACEHOLDER_PATTERN = /\[图片:(\d+)\]/g;

export async function expandImagePlaceholders(text: string): Promise<string> {
  const ids = [...text.matchAll(PLACEHOLDER_PATTERN)].map((m) => Number(m[1]));
  if (ids.length === 0) return text;

  const getStmt = db.prepare(
    `SELECT id, filename, content_type, file_path, description FROM message_images WHERE id = ?`,
  );

  interface ImageRow {
    id: number;
    filename: string;
    content_type: string;
    file_path: string;
    description: string | null;
  }
  const rows = new Map<number, ImageRow>();
  for (const id of ids) {
    const row = getStmt.get(id) as unknown as ImageRow | undefined;
    if (row !== undefined) rows.set(id, row);
  }
  if (rows.size === 0) return text.replace(PLACEHOLDER_PATTERN, "[图片]");

  // 上限保护：只识图 id 最大的 N 张（id 自增，等价于最近的 N 张）。多图场景
  // 一次 /Agent 全识别既慢又贵；被裁掉的旧图降级成 [图片]，模型知道那里有图但不为它花钱。
  const eligible = [...rows.keys()].sort((a, b) => a - b).slice(-config.visionMaxImages);

  // 未缓存的并发识图（缓存命中的直接用），结果按 id 归集。
  const descriptions = new Map<number, string>();
  await Promise.all(
    eligible.map(async (id) => {
      const row = rows.get(id);
      if (row === undefined) return;
      if (row.description !== null) {
        descriptions.set(id, row.description); // 缓存命中，零成本复用
        return;
      }
      // 功能未启用：不再往下读文件/调识图（缓存的已在上分支复用），本 id 不进
      // descriptions，最后 replace 回调里降级成 [图片]——与函数头注释的降级规则一致。
      if (config.visionApiKey === "") return;
      try {
        const bytes = readFileSync(row.file_path);
        // content_type 是 QQ 事件里的原值（image/jpeg、image/png…），入库时存了真实类型
        const description = await describeImage(bytes, row.content_type);
        db.prepare(`UPDATE message_images SET description = ? WHERE id = ?`).run(description, id);
        descriptions.set(id, description);
      } catch (err) {
        // 单张失败单独降级：这张图标注无法识别，其余图片和主链路照常。
        logger.warn("images", `识图失败 id=${id}: ${err instanceof Error ? err.message : err}`);
        descriptions.set(id, "该图片暂时无法识别");
      }
    }),
  );

  return text.replace(PLACEHOLDER_PATTERN, (full, idStr: string) => {
    const id = Number(idStr);
    const description = descriptions.get(id);
    // 能查到行但不在 eligible 集合（超上限）或没有描述的，降级 [图片]
    if (description === undefined) return "[图片]";
    return `[图片]{${description}}`;
  });
}
