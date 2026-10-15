// services/workspace/paths.ts —— workspace 的目录解析与路径安全（方案 §3.2/§3.4）。
// 职责只有两件事：
//   1. tenantKey → workspace 目录（sha256 命名，惰性创建）；
//   2. 模型给的 path → 受控的绝对路径（三层滤网 + realpath 裁决，防穿越/逃逸）。
// 六件套工具全部经这里拿路径，工具自身不重复实现校验——校验的单一真相源。

import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import type { BotEvent } from "../../events/registry.js";
import { tenantKey } from "../../session/key.js";
import { config } from "../../config.js";

// tenantKey → workspace 绝对目录。目录名用 sha256(key) 前 32 个十六进制字符：
// 不把原始 openid 拼进路径（防路径注入/信息泄露），固定长度也免得文件系统名长限制。
// 惰性创建（首次使用时 mkdir），调用方再取 realpath 作为校验的"根真身"——
// 根自己被换链接的极端情况下比较两端点都不可信，两端都取真身才有意义。
export function workspaceDirFor(event: BotEvent): string {
  const hash = createHash("sha256").update(tenantKey(event)).digest("hex").slice(0, 32);
  const dir = join(config.workspaceRoot, hash);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// 校验失败的统一异常：工具层 catch 后把 message 直接回给模型（可读、可自纠）。
export class PathError extends Error {}

// 第一层滤网：字符串形态检查（便宜，先拒掉绝大多数垃圾输入）。
// 规则按"切段精确匹配"而不是子串搜索——文件名可以合法含点（data..bak），
// 只有整段等于 ".." 才是穿越；绝对路径/NUL 是注入的经典载体，一律拒。
export function validateRelativePath(userPath: string): string {
  if (userPath.includes("\0")) throw new PathError("路径含非法字符（NUL）");
  // 分隔符归一化：Windows 反斜杠统一当 / 处理（生产是 Linux，这里防模型手滑）
  const normalized = userPath.replace(/\\/g, "/");
  if (normalized.startsWith("/")) throw new PathError("只接受相对路径（以 workspace 为根）");
  const segments = normalized.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.some((s) => s === "..")) throw new PathError("路径不允许包含 ..");
  if (segments.length === 0) throw new PathError("路径为空");
  return segments.join("/");
}

// 裁决：resolved 必须严格位于 workspace 真身之下（按分隔符边界，不是裸 startsWith
// ——裸前缀会把 /ws/hash-evil 误判在 /ws/hash 之内）。
function assertInsideRoot(resolved: string, rootReal: string, relPath: string): void {
  if (resolved !== rootReal && !resolved.startsWith(rootReal + sep)) {
    throw new PathError(`路径 ${relPath} 解析后越出 workspace（可能是符号链接），已拒绝`);
  }
}

// 读路径解析（read_file / grep 的单文件场景）：目标必须已存在，realpath 一步到位
// ——symlink 指向外面（如容器内 ln -s /etc/passwd 后诱导 read_file("leak")）在这里现形。
export function resolveReadPath(root: string, userPath: string): string {
  const rel = validateRelativePath(userPath);
  const rootReal = realpathSync(root);
  let resolved: string;
  try {
    resolved = realpathSync(join(rootReal, rel));
  } catch {
    throw new PathError(`文件不存在：${rel}`);
  }
  assertInsideRoot(resolved, rootReal, rel);
  return resolved;
}

// 写路径解析（write_file / edit_file）：目标可以不存在（新建），但已存在的
// 每一段都不允许是符号链接——逐段 lstat（lstat 看链接本身，stat 会跟随链接，
// 我们要拒绝的恰恰是"这一段是链接"这个事实）。返回绝对路径，调用方负责原子写。
export function resolveWritePath(root: string, userPath: string): string {
  const rel = validateRelativePath(userPath);
  const rootReal = realpathSync(root);
  let probe = rootReal;
  for (const seg of rel.split("/")) {
    probe = join(probe, seg);
    let st;
    try {
      st = lstatSync(probe);
    } catch {
      break; // 这一段不存在 = 后续都不存在（新建文件），检查到此为止
    }
    if (st.isSymbolicLink()) {
      throw new PathError(`路径段 ${seg} 是符号链接，写入已拒绝（防链接逃逸）`);
    }
  }
  const full = join(rootReal, rel);
  assertInsideRoot(full, rootReal, rel); // 段内已确认无链接，字符串层面再兜一道
  return full;
}

// workspace 配额统计（写入前置检查用）：递归统计字节数与文件数。
// 不跟随符号链接（Dirent 的 isSymbolicLink 不算文件不计入）——链接不算占用。
export function usageOf(root: string): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 统计用途下目录消失竞态不值得炸调用方
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        try {
          bytes += statSync(full).size;
        } catch {
          // 单文件 stat 失败跳过（ race 中被删），统计值略保守无害
        }
        files += 1;
      }
    }
  };
  walk(realpathSync(root));
  return { bytes, files };
}
