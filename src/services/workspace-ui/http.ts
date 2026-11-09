// services/workspace-ui/http.ts —— 工作台 UI 的 /ws 路由（前端方案 §4）。
// 挂在 webhook.ts 既有的 HTTP server 上（单进程决策），前缀 /ws/ 与 QQ 回调
// 路径不相交。本模块独立兜错——UI 路由的异常绝不冒进 QQ 回调处理。
//
// 路由形态（凭证双轨，同 kb web 面）：
//   GET  /ws/<token>            管理页（index.html，token 由前端从路径提取）
//   GET  /ws/static/<file>      静态资源（app.js / style.css / monaco/）
//   /ws/api/<rest>              REST API，token 在 Authorization: Bearer 头
//   /ws/<token>/api/<rest>      同一套 API 的路径 token 形式（浏览器原生标签
//                                带不了自定义头——下载/预览场景用）
//
// 安全模型：每请求查库验 token 反解 scope（租户键），workspaceDirForKey 钉死
// 目录；一切相对路径经 paths.ts 三层滤网裁决；写入走 mtime 乐观锁 + 配额前置。

import {
  chmodSync, createReadStream, existsSync, lstatSync, mkdirSync, readdirSync,
  readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { config } from "../../config.js";
import { logger } from "../logger.js";
import {
  PathError, resolveReadPath, resolveWritePath, usageOf,
  validateRelativePath, workspaceDirForKey,
} from "../workspace/paths.js";
import { verifyToken } from "./tokens.js";

const STATIC_ROOT = join(dirname(fileURLToPath(import.meta.url)), "static");
const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/; // randomBytes(24).base64url = 32 字符

// ---------- 小工具 ----------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(json);
}

function sendError(res: ServerResponse, status: number, message: string, extra?: Record<string, unknown>): void {
  sendJson(res, status, { error: message, ...extra });
}

function readBody(req: IncomingMessage, limitBytes: number): Promise<Buffer> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let overLimit = false;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > limitBytes) {
        overLimit = true;
        req.destroy(); // 超限直接断开——继续收完只是浪费带宽
        reject(new TooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => { if (!overLimit) resolveBody(Buffer.concat(chunks)); });
    req.on("error", reject);
  });
}

class TooLargeError extends Error {}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
};

// 静态文件：resolve 后必须仍在静态根内（防 ../ 穿越）；内容类型按扩展名。
function serveStatic(res: ServerResponse, relFile: string): void {
  const full = resolve(STATIC_ROOT, relFile);
  if (full !== STATIC_ROOT && !full.startsWith(STATIC_ROOT + sep)) {
    sendError(res, 404, "资源不存在");
    return;
  }
  let st;
  try {
    st = statSync(full);
  } catch {
    sendError(res, 404, "资源不存在");
    return;
  }
  if (!st.isFile()) {
    sendError(res, 404, "资源不存在");
    return;
  }
  const type = CONTENT_TYPES[extname(full).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(200, {
    "Content-Type": type,
    "Cache-Control": "public, max-age=86400", // Monaco 体积可观，给一天缓存
  });
  createReadStream(full).pipe(res);
}

// ---------- API 各端点 ----------

interface ApiCtx {
  scope: string;
  root: string;
}

function apiList(ctx: ApiCtx, res: ServerResponse, searchParams: URLSearchParams): void {
  const dirParam = searchParams.get("dir") ?? "";
  const target =
    dirParam === "" ? ctx.root : resolveReadPath(ctx.root, dirParam);
  const st = statSync(target);
  if (!st.isDirectory()) throw new PathError(`不是目录：${dirParam}`);

  const entries = readdirSync(target, { withFileTypes: true })
    .filter((e) => e.isDirectory() || e.isFile()) // 套接字/管道等不列
    .map((e) => {
      const full = join(target, e.name);
      let size = 0;
      let mtimeMs = 0;
      try {
        const s = statSync(full);
        size = s.size;
        mtimeMs = s.mtimeMs;
      } catch {
        // 竞态中被删：按 0 尺寸列出（点击时会得到"不存在"）
      }
      return { name: e.name, isDir: e.isDirectory(), size, mtimeMs };
    })
    .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
  sendJson(res, 200, { entries });
}

function apiReadFile(ctx: ApiCtx, res: ServerResponse, searchParams: URLSearchParams): void {
  const path = searchParams.get("path") ?? "";
  const full = resolveReadPath(ctx.root, path);
  const st = statSync(full);
  if (!st.isFile()) throw new PathError(`不是文件：${path}`);
  if (st.size > config.workspaceReadMaxBytes) {
    sendError(res, 413, `文件超过读取上限（${config.workspaceReadMaxBytes} 字节），请用 Agent 的 read_file 分段查看`);
    return;
  }
  const content = readFileSync(full, "utf8");
  sendJson(res, 200, {
    content,
    binary: content.includes("\\uFFFD"), // 解出替换符 = 非 UTF-8，前端按二进制提示
    mtimeMs: st.mtimeMs,
    size: st.size,
  });
}

// 写入前配额检查（方案 §7）：单文件 / 总量 / 文件数三闸。覆盖已有文件时
// 扣减旧占用。配额与 Agent 工具同一套 config——防线不因 UI 开口子。
function assertQuota(ctx: ApiCtx, newSize: number, replacesExisting: boolean, oldSize: number): void {
  if (newSize > config.workspaceMaxFileBytes) {
    throw new QuotaError(`内容超过单文件上限（${config.workspaceMaxFileBytes} 字节）`);
  }
  const usage = usageOf(ctx.root);
  const delta = replacesExisting ? newSize - oldSize : newSize;
  if (usage.bytes + delta > config.workspaceDiskQuotaBytes) {
    throw new QuotaError(`将超出磁盘配额（当前 ${usage.bytes} / 上限 ${config.workspaceDiskQuotaBytes} 字节）`);
  }
  if (!replacesExisting && usage.files + 1 > config.workspaceMaxFiles) {
    throw new QuotaError(`文件数将超出上限（${config.workspaceMaxFiles}）`);
  }
}

class QuotaError extends Error {}

function apiWriteFile(ctx: ApiCtx, res: ServerResponse, searchParams: URLSearchParams, body: Buffer): void {
  void searchParams;
  let parsed: { path?: unknown; content?: unknown; baseMtimeMs?: unknown };
  try {
    parsed = JSON.parse(body.toString("utf8")) as typeof parsed;
  } catch {
    sendError(res, 400, "请求体不是合法 JSON");
    return;
  }
  if (typeof parsed.path !== "string" || typeof parsed.content !== "string") {
    sendError(res, 400, "需要 path 与 content 字段");
    return;
  }
  const full = resolveWritePath(ctx.root, parsed.path);
  const content = Buffer.from(parsed.content, "utf8");

  let st: { mtimeMs: number; size: number } | null = null;
  try {
    const s = statSync(full);
    st = { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    st = null; // 不存在 = 新建
  }

  // mtime 乐观锁：已存在的文件必须带打开时的 mtime 且一致；客户端以为是
  // 新建但文件已存在（比如任务容器刚写入）同样是冲突——不盲覆盖。
  if (st !== null) {
    if (typeof parsed.baseMtimeMs !== "number" || parsed.baseMtimeMs !== st.mtimeMs) {
      sendError(res, 409, "文件已被其它写入方修改（可能是任务容器或其他人编辑）", { currentMtimeMs: st.mtimeMs });
      return;
    }
  }
  assertQuota(ctx, content.length, st !== null, st?.size ?? 0);

  // 原子写：同目录临时文件 + rename（读者永远看到旧版或新版，不会看到半截）。
  // 0666 对齐目录 0o777 的决议（paths.ts 属主修正同理）：容器内 uid 1000 需要
  // 能改这些文件；chmod 失败不阻塞（非 root 部署下文件本就归自己）。
  const tmp = join(dirname(full), `.wsui-tmp-${Date.now()}-${randomBytes(4).toString("hex")}`);
  writeFileSync(tmp, content);
  try {
    try { chmodSync(tmp, 0o666); } catch { /* 失败不阻塞 */ }
    renameSync(tmp, full);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* 清理失败忽略 */ }
    throw err;
  }

  const after = statSync(full);
  sendJson(res, 200, { mtimeMs: after.mtimeMs, size: after.size });
}

function apiMakeDir(ctx: ApiCtx, res: ServerResponse, body: Buffer): void {
  let parsed: { path?: unknown };
  try {
    parsed = JSON.parse(body.toString("utf8")) as typeof parsed;
  } catch {
    sendError(res, 400, "请求体不是合法 JSON");
    return;
  }
  if (typeof parsed.path !== "string") {
    sendError(res, 400, "需要 path 字段");
    return;
  }
  const full = resolveWritePath(ctx.root, parsed.path); // 逐段滤 symlink
  if (!existsSync(full)) {
    mkdirSync(full, { recursive: true });
    // 新目录对齐 0o777 决议（容器写兼容）；失败不阻塞
    try { chmodSync(full, 0o777); } catch { /* 失败不阻塞 */ }
  }
  sendJson(res, 200, { ok: true });
}

function apiRename(ctx: ApiCtx, res: ServerResponse, body: Buffer): void {
  let parsed: { from?: unknown; to?: unknown };
  try {
    parsed = JSON.parse(body.toString("utf8")) as typeof parsed;
  } catch {
    sendError(res, 400, "请求体不是合法 JSON");
    return;
  }
  if (typeof parsed.from !== "string" || typeof parsed.to !== "string") {
    sendError(res, 400, "需要 from 与 to 字段");
    return;
  }
  const from = resolveReadPath(ctx.root, parsed.from); // 必须已存在
  const to = resolveWritePath(ctx.root, parsed.to);
  if (existsSync(to)) {
    sendError(res, 400, "目标路径已存在（rename 不覆盖）");
    return;
  }
  renameSync(from, to);
  sendJson(res, 200, { ok: true });
}

function apiDelete(ctx: ApiCtx, res: ServerResponse, searchParams: URLSearchParams): void {
  const path = searchParams.get("path") ?? "";
  const full = resolveReadPath(ctx.root, path);
  const st = lstatSync(full);
  if (st.isDirectory()) {
    rmSync(full, { recursive: true });
  } else {
    unlinkSync(full);
  }
  sendJson(res, 200, { ok: true });
}

// ---------- 路由分发 ----------

// 由 webhook.ts 调用（前缀命中 /ws）。自兜错：UI 的一切实机异常（含未预期
// 的文件系统错误）在本地消化，绝不冒进 QQ 回调链。
export function handleWorkspaceUi(req: IncomingMessage, res: ServerResponse, url: URL): void {
  handleWorkspaceUiAsync(req, res, url).catch((err: unknown) => {
    logger.error("workspace-ui", `UI 请求处理出错（${req.method} ${url.pathname}）：${err instanceof Error ? err.message : err}`);
    if (!res.headersSent) {
      sendError(res, 500, "服务器内部错误");
    } else {
      res.destroy();
    }
  });
}

async function handleWorkspaceUiAsync(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const path = url.pathname;

  // 静态资源（无需 token——都是可公开的页面物料；敏感的是 API 不是静态文件）
  if (path.startsWith("/ws/static/")) {
    serveStatic(res, path.slice("/ws/static/".length));
    return;
  }

  // 管理页（token 由前端 JS 从路径提取，服务端只回静态 index.html）
  const pageMatch = /^\/ws\/([A-Za-z0-9_-]{32})$/.exec(path);
  if (pageMatch !== null) {
    serveStatic(res, "index.html");
    return;
  }

  // API：两种凭证形态剥出 token 与 API 路径
  let token = "";
  let apiPath = "";
  const pathMatch = /^\/ws\/([A-Za-z0-9_-]{32})\/api\/(.*)$/.exec(path);
  const bearerMatch = /^\/ws\/api\/(.*)$/.exec(path);
  if (pathMatch !== null) {
    token = pathMatch[1];
    apiPath = pathMatch[2];
  } else if (bearerMatch !== null) {
    const auth = req.headers.authorization;
    token = auth !== undefined && auth.startsWith("Bearer ") ? auth.slice(7) : "";
    apiPath = bearerMatch[1];
  } else {
    sendError(res, 404, "路径不存在");
    return;
  }

  if (!TOKEN_RE.test(token)) {
    sendError(res, 401, "链接无效，请重新发 /工作台 领取");
    return;
  }
  const scope = verifyToken(token);
  if (scope === null) {
    sendError(res, 401, "链接已过期或被吊销，请重新发 /工作台 领取");
    return;
  }
  const ctx: ApiCtx = { scope, root: workspaceDirForKey(scope) };

  try {
    const bodyNeeded = req.method === "PUT" || req.method === "POST";
    const body = bodyNeeded
      ? await readBody(req, config.workspaceMaxFileBytes + 65_536) // 内容 + JSON 包装余量
      : Buffer.alloc(0);

    if (req.method === "GET" && apiPath === "list") return apiList(ctx, res, url.searchParams);
    if (req.method === "GET" && apiPath === "file") return apiReadFile(ctx, res, url.searchParams);
    if (req.method === "PUT" && apiPath === "file") return apiWriteFile(ctx, res, url.searchParams, body);
    if (req.method === "POST" && apiPath === "dir") return apiMakeDir(ctx, res, body);
    if (req.method === "POST" && apiPath === "rename") return apiRename(ctx, res, body);
    if (req.method === "DELETE" && apiPath === "file") return apiDelete(ctx, res, url.searchParams);
    sendError(res, 404, `不支持的 API：${req.method} ${apiPath}`);
  } catch (err) {
    if (err instanceof TooLargeError) {
      sendError(res, 413, "请求体过大");
    } else if (err instanceof QuotaError) {
      sendError(res, 413, err.message);
    } else if (err instanceof PathError) {
      sendError(res, 400, err.message);
    } else {
      throw err; // 未分类异常交给外层兜错（500 + 日志）
    }
  }
}
