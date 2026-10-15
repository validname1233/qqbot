// agent/code-workspace/tools/glob.ts —— 六件套之四：glob。
// Node 侧模式匹配（不走容器）：支持 ** * ? [abc]；结果按 mtime 降序（最近改动的
// 在前——"上次写的脚本"排第一，符合工作台场景），条数上限截断。
// 自己实现 ** 递归遍历而不是引 minimatch：workspace 有文件数上限（200），
// 遍历规模天然有界，引依赖不值。

import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { Tool } from "../../tool.js";
import type { MessageContext } from "../../../types.js";
import { workspaceDirFor, PathError } from "../../../services/workspace/paths.js";
import { config } from "../../../config.js";
import { asString, toolError } from "./shared.js";

// 单段模式匹配（不含 /）：* 任意串、? 单字符、[abc] 字符集。
function matchSegment(seg: string, pattern: string): boolean {
  return new RegExp(
    "^" +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, ".")
        .replace(/\[([^\]]*)\]/g, "[$1]") +
      "$",
  ).test(seg);
}

// 多段模式（含 **）：** 跨任意层级，* 只在段内。segments 吃尽且 pattern 吃尽 = 命中。
function matchSegments(segments: readonly string[], pattern: readonly string[]): boolean {
  if (pattern.length === 0) return segments.length === 0;
  const [head, ...rest] = pattern;
  if (head === "**") {
    // ** 可匹配零层或多层：尝试跳过 0..segments.length 层
    for (let skip = 0; skip <= segments.length; skip++) {
      if (matchSegments(segments.slice(skip), rest)) return true;
    }
    return false;
  }
  if (segments.length === 0) return false;
  return matchSegment(segments[0], head) && matchSegments(segments.slice(1), rest);
}

interface Entry {
  rel: string;
  mtimeMs: number;
}

function walk(dir: string, base: string, out: Entry[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith(".tmp-")) continue; // 原子写的临时文件不是产物
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      walk(full, base, out);
    } else if (e.isFile()) {
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(full).mtimeMs;
      } catch {
        // race 中消失的文件 mtime 记 0，排最后
      }
      out.push({ rel: relative(base, full).replace(/\\/g, "/"), mtimeMs });
    }
  }
}

export const globTool: Tool = {
  name: "glob",
  description:
    "按模式列出 workspace 内的文件路径。模式如 **/*.py（所有 python 文件）、" +
    "data/*.csv（data 目录下的 csv）、*.json（根目录一层）。" +
    "结果按修改时间降序（最近改动的在前），最多 200 条。" +
    "想看目录里有什么、找上次的脚本，先用这个。",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "glob 模式，如 **/*.py" },
    },
    required: ["pattern"],
  },

  async run(args, ctx: MessageContext): Promise<string> {
    const pattern = asString(args, "pattern");
    if (pattern === undefined || pattern.trim() === "") {
      return toolError("glob", "缺少 pattern 参数");
    }
    // 模式本身也走一遍字符串滤网（它会被拼进遍历起点之外，只用于匹配，
    // 但提前拒掉绝对路径/.. 心智上与其它工具一致）。
    let normalized: string;
    try {
      normalized = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
      if (normalized.startsWith("/") || normalized.split("/").includes("..")) {
        throw new PathError("只接受 workspace 内的相对模式");
      }
    } catch (err) {
      return toolError("glob", err instanceof PathError ? err.message : String(err));
    }

    const root = workspaceDirFor(ctx.event);
    const all: Entry[] = [];
    walk(root, root, all);
    const patternSegs = normalized.split("/");
    const matched = all
      .filter((e) => matchSegments(e.rel.split("/"), patternSegs))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    if (matched.length === 0) return "（没有匹配的文件）";
    const shown = matched.slice(0, config.workspaceGlobMaxResults);
    const note =
      matched.length > shown.length ? `\n[共 ${matched.length} 条，仅显示前 ${shown.length} 条]` : "";
    return shown.map((e) => e.rel).join("\n") + note;
  },
};
