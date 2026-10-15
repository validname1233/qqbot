// agent/code-workspace/tools/read-file.ts —— 六件套之一：read_file。
// Node fs 直读 workspace 文件（不走容器），带行号输出 + 行/字节双上限截断
//（先到为准）+ 二进制检测。上下文预算纪律写进 description——模型省不省
// 上下文，一半取决于工具描述怎么教它。

import { readFileSync } from "node:fs";
import type { Tool } from "../../tool.js";
import type { MessageContext } from "../../../types.js";
import { workspaceDirFor, resolveReadPath, PathError } from "../../../services/workspace/paths.js";
import { config } from "../../../config.js";
import { asString, asPositiveInt, toolError } from "./shared.js";

export const readFileTool: Tool = {
  name: "read_file",
  description:
    "读取 workspace 内的文本文件，返回带行号的内容（cat -n 风格）。" +
    "默认最多 500 行 / 32KB（先到为准），超出会截断并提示用 offset 续读——" +
    "大文件先看开头，确认需要再续读，不要一次读完。二进制文件只返回标记。" +
    "路径相对 workspace 根，如 scores.csv 或 notes/data.json。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "相对 workspace 根的文件路径" },
      offset: { type: "integer", description: "起始行号（1 起；截断后续读用）" },
      limit: { type: "integer", description: "本次读取的最大行数" },
    },
    required: ["path"],
  },

  async run(args, ctx: MessageContext): Promise<string> {
    const path = asString(args, "path");
    if (path === undefined) return toolError("read_file", "缺少 path 参数");
    const offset = asPositiveInt(args, "offset") ?? 1;
    const limit = asPositiveInt(args, "limit") ?? config.workspaceReadMaxLines;

    const root = workspaceDirFor(ctx.event);
    let full: string;
    try {
      full = resolveReadPath(root, path);
    } catch (err) {
      return toolError("read_file", err instanceof PathError ? err.message : String(err));
    }

    let content: Buffer;
    try {
      content = readFileSync(full);
    } catch (err) {
      return toolError("read_file", `读取失败：${err instanceof Error ? err.message : String(err)}`);
    }

    // 二进制检测：含 NUL 字节视为二进制（与 git 同款启发式），不回显内容。
    if (content.includes(0)) {
      return `[二进制文件] ${path}（${content.length} 字节），不回显内容；如需处理请用 exec 写脚本读取`;
    }

    const text = content.toString("utf8");
    const allLines = text.split("\n");
    const totalLines = allLines.length;
    const picked = allLines.slice(offset - 1, offset - 1 + limit);

    // 字节上限兜底（行数没到但字节超了）：按字符切，中文 1 字≈1 token，近似即可。
    let out = "";
    const included: string[] = [];
    let bytes = 0;
    for (const line of picked) {
      if (bytes + line.length > config.workspaceReadMaxBytes) break;
      included.push(line);
      bytes += line.length;
    }
    const truncatedByBytes = included.length < picked.length;

    out = included.map((line, i) => `${offset + i}\t${line}`).join("\n");

    const notes: string[] = [];
    if (offset > 1 || included.length < totalLines) {
      notes.push(`[共 ${totalLines} 行，本次显示第 ${offset}-${offset + included.length - 1} 行]`);
    }
    if (truncatedByBytes) notes.push("[已达单次字节上限，可用 offset 续读]");
    return out + (notes.length > 0 ? "\n" + notes.join(" ") : "");
  },
};
