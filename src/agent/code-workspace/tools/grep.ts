// agent/code-workspace/tools/grep.ts —— 六件套之五：grep。
// Node 侧正则检索（不走容器）：跨文件或单文件，输出 file:line: content 格式
//（贴主流惯例，吃模型训练先验）。单文件超 5MB 跳过并标记；匹配条数上限截断。
// 与 glob 共用 walk 遍历思路但独立实现（grep 要带行号，遍历产物不同）。

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { Tool } from "../../tool.js";
import type { MessageContext } from "../../../types.js";
import { workspaceDirFor } from "../../../services/workspace/paths.js";
import { config } from "../../../config.js";
import { asString, toolError } from "./shared.js";

// 单文件体积超过这个就跳过（读进来做行扫描的成本失控；workspace 单文件上限
// 1MB，这条防御主要兜"配额之前的历史文件/外部拷入"的极端情况）。
const MAX_GREP_FILE_BYTES = 5 * 1024 * 1024;

interface Hit {
  file: string;
  line: number;
  text: string;
}

function grepFile(full: string, rel: string, regex: RegExp, hits: Hit[], cap: number): void {
  let content: string;
  try {
    content = readFileSync(full, "utf8");
  } catch {
    return; // 读取失败（二进制/权限/race）静默跳过——grep 是尽力而为的检索
  }
  if (content.includes("\0")) return; // 二进制不进结果
  const lines = content.split("\n");
  for (let i = 0; i < lines.length && hits.length < cap; i++) {
    if (regex.test(lines[i])) {
      hits.push({ file: rel, line: i + 1, text: lines[i].slice(0, 200) });
    }
  }
}

function listFiles(dir: string, base: string, out: Array<{ full: string; rel: string }>): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith(".tmp-")) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      listFiles(full, base, out);
    } else if (e.isFile()) {
      out.push({ full, rel: relative(base, full).replace(/\\/g, "/") });
    }
  }
}

export const grepTool: Tool = {
  name: "grep",
  description:
    "在 workspace 文件内容里做正则检索，输出 文件:行号: 内容。" +
    "pattern 是 JavaScript 正则（如 'def \\w+'、'KeyError'、'分数|成绩'）。" +
    "可选 glob 限定文件范围（如 '*.py' 或 'data/*.csv'）。" +
    "最多返回 50 条匹配；找定义、找报错关键词、看某列数据的格式都用它。",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "正则表达式" },
      glob: { type: "string", description: "可选，限定检索的文件 glob（如 *.py）" },
    },
    required: ["pattern"],
  },

  async run(args, ctx: MessageContext): Promise<string> {
    const pattern = asString(args, "pattern");
    if (pattern === undefined || pattern === "") {
      return toolError("grep", "缺少 pattern 参数");
    }
    const globFilter = asString(args, "glob");

    let regex: RegExp;
    try {
      regex = new RegExp(pattern);
    } catch (err) {
      return toolError("grep", `正则不合法：${err instanceof Error ? err.message : String(err)}`);
    }

    const root = workspaceDirFor(ctx.event);
    const cap = config.workspaceGrepMaxMatches;
    const hits: Hit[] = [];
    const skipped: string[] = [];

    // glob 参数的两种语义：含通配符（*.py / data/*.csv）= 文件名过滤，遍历全库
    // 后按"段模式匹配"过滤；不含通配符的具体文件名 = 直读单文件（高频用法，
    // 如查某个 csv 的首行格式）。不含 glob 参数 = 全库检索。
    const hasWildcard = globFilter !== undefined && /[*?\[]/.test(globFilter);
    const files: Array<{ full: string; rel: string }> = [];
    listFiles(root, root, files);

    const targets =
      globFilter !== undefined && !hasWildcard
        ? files.filter((f) => f.rel === globFilter.replace(/\\/g, "/"))
        : globFilter !== undefined
          ? files.filter((f) =>
              // 段模式匹配复用 glob 工具的思路：把过滤模式与文件相对路径都切段比较
              f.rel.split("/").length === globFilter.replace(/\\/g, "/").split("/").length &&
              f.rel.split("/").every((seg, i) => {
                const pat = globFilter.replace(/\\/g, "/").split("/")[i];
                if (pat === "**") return true;
                return new RegExp("^" + pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, ".") + "$").test(seg);
              }),
            )
          : files;

    if (targets.length === 0 && globFilter !== undefined && !hasWildcard) {
      return toolError("grep", `文件不存在：${globFilter}`);
    }

    for (const f of targets) {
      if (hits.length >= cap) break;
      let size = 0;
      try {
        size = statSync(f.full).size;
      } catch {
        continue;
      }
      if (size > MAX_GREP_FILE_BYTES) {
        skipped.push(f.rel);
        continue;
      }
      grepFile(f.full, f.rel, regex, hits, cap);
    }

    if (hits.length === 0) {
      const skipNote = skipped.length > 0 ? `（跳过 ${skipped.length} 个超大文件：${skipped.slice(0, 3).join("、")}）` : "";
      return `（没有匹配${skipNote}）`;
    }
    const note =
      hits.length >= cap ? `\n[已达 ${cap} 条匹配上限，收窄 pattern 或用 glob 限定范围]` : "";
    return hits.map((h) => `${h.file}:${h.line}: ${h.text}`).join("\n") + note;
  },
};
