// agent/code-workspace/tools/write-file.ts —— 六件套之二：write_file。
// Node fs 直写（原子写：临时文件 + rename），覆盖语义。写入前置配额检查
//（单文件/总量/文件数），路径经 resolveWritePath（逐段 lstat 拒符号链接）。

import { existsSync, renameSync, writeFileSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import type { Tool } from "../../tool.js";
import type { MessageContext } from "../../../types.js";
import { workspaceDirFor, resolveWritePath, usageOf, PathError } from "../../../services/workspace/paths.js";
import { config } from "../../../config.js";
import { asString, toolError } from "./shared.js";

export const writeFileTool: Tool = {
  name: "write_file",
  description:
    "在 workspace 内创建或覆盖一个文本文件（整体写入，覆盖已有内容）。" +
    "写脚本/数据文件用这个；修改现有文件的小片段优先用 edit_file（更省、更不容易错）。" +
    "单文件上限 1MB，workspace 有总容量与文件数配额，超限会拒绝并说明。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "相对 workspace 根的文件路径" },
      content: { type: "string", description: "完整的文件内容" },
    },
    required: ["path", "content"],
  },

  async run(args, ctx: MessageContext): Promise<string> {
    const path = asString(args, "path");
    const content = asString(args, "content");
    if (path === undefined) return toolError("write_file", "缺少 path 参数");
    if (content === undefined) return toolError("write_file", "缺少 content 参数");

    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > config.workspaceMaxFileBytes) {
      return toolError("write_file", `内容 ${bytes} 字节超过单文件上限 ${config.workspaceMaxFileBytes}，请拆分或精简`);
    }

    const root = workspaceDirFor(ctx.event);
    let full: string;
    try {
      full = resolveWritePath(root, path);
    } catch (err) {
      return toolError("write_file", err instanceof PathError ? err.message : String(err));
    }

    // 配额检查（新建文件时才计入增量；覆盖只校验单文件上限）。
    const isNew = !existsSync(full);
    if (isNew) {
      const usage = usageOf(root);
      if (usage.bytes + bytes > config.workspaceDiskQuotaBytes) {
        return toolError(
          "write_file",
          `workspace 总量将超配额（现有 ${usage.bytes} + 新增 ${bytes} > ${config.workspaceDiskQuotaBytes} 字节）；请先删除不需要的文件（exec rm）再写`,
        );
      }
      if (usage.files + 1 > config.workspaceMaxFiles) {
        return toolError("write_file", `workspace 文件数将超上限（${config.workspaceMaxFiles}）；请先清理（exec rm）`);
      }
    }

    // 原子写：先写临时文件再 rename——中途失败不会留下半截内容。
    mkdirSync(dirname(full), { recursive: true });
    const tmp = join(dirname(full), `.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    try {
      writeFileSync(tmp, content, "utf8");
      renameSync(tmp, full);
    } catch (err) {
      try {
        unlinkSync(tmp);
      } catch {
        // 临时文件清理失败无害（占位极小，后续任务可覆盖）
      }
      return toolError("write_file", `写入失败：${err instanceof Error ? err.message : String(err)}`);
    }

    const size = statSync(full).size;
    return `已${isNew ? "创建" : "覆盖"} ${path}（${size} 字节）`;
  },
};
