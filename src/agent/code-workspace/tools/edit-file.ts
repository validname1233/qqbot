// agent/code-workspace/tools/edit-file.ts —— 六件套之三：edit_file。
// old_string 逐字节精确匹配替换；匹配 0 次或多次（未开 replace_all）即失败，
// 错误信息附匹配数与附近内容片段——让模型下一轮 read_file 自纠（方案 §3.4：
// edit 精确匹配失败是预期内的高频失败模式，错误信息是它的"UI"）。

import { readFileSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Tool } from "../../tool.js";
import type { MessageContext } from "../../../types.js";
import { workspaceDirFor, resolveReadPath, resolveWritePath, PathError } from "../../../services/workspace/paths.js";
import { config } from "../../../config.js";
import { asString, toolError } from "./shared.js";

export const editFileTool: Tool = {
  name: "edit_file",
  description:
    "修改 workspace 内现有文件的一小段：把 old_string 精确替换为 new_string" +
    "（逐字符匹配，含空格缩进）。old_string 必须在文件中恰好出现一次；" +
    "0 次或多次都会失败并附提示——此时先 read_file 看真实内容再改。" +
    "多处相同替换传 replace_all: true。修改前建议先 read_file 确认格式。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "相对 workspace 根的文件路径" },
      old_string: { type: "string", description: "要被替换的原文（必须精确匹配，含缩进）" },
      new_string: { type: "string", description: "替换后的新文本" },
      replace_all: { type: "boolean", description: "替换所有匹配处（默认 false，要求唯一匹配）" },
    },
    required: ["path", "old_string", "new_string"],
  },

  async run(args, ctx: MessageContext): Promise<string> {
    const path = asString(args, "path");
    const oldString = asString(args, "old_string");
    const newString = asString(args, "new_string");
    const replaceAll = args["replace_all"] === true;
    if (path === undefined) return toolError("edit_file", "缺少 path 参数");
    if (oldString === undefined) return toolError("edit_file", "缺少 old_string 参数");
    if (newString === undefined) return toolError("edit_file", "缺少 new_string 参数");
    if (oldString === "") return toolError("edit_file", "old_string 不能为空串（无法定位替换点）");

    const root = workspaceDirFor(ctx.event);
    let full: string;
    try {
      full = resolveReadPath(root, path); // 编辑对象必须已存在（read 语义先行）
      resolveWritePath(root, path); // 写侧校验双保险（lstat 链在 read 后仍可能被换，纵深一层）
    } catch (err) {
      return toolError("edit_file", err instanceof PathError ? err.message : String(err));
    }

    let content: string;
    try {
      content = readFileSync(full, "utf8");
    } catch (err) {
      return toolError("edit_file", `读取失败：${err instanceof Error ? err.message : String(err)}`);
    }

    const count = content.split(oldString).length - 1;
    if (count === 0) {
      // 附附近片段帮模型对齐：文件开头 300 字符 + old_string 自身的前 80 字符对照。
      const preview = content.slice(0, 300).replace(/\n/g, "\\n");
      return toolError(
        "edit_file",
        `old_string 在 ${path} 中出现 0 次。文件开头预览：${preview}…；` +
          `你要找的是：${oldString.slice(0, 80).replace(/\n/g, "\\n")}…。先 read_file 核对真实内容（常见原因：缩进/空格/换行不符）`,
      );
    }
    if (count > 1 && !replaceAll) {
      return toolError(
        "edit_file",
        `old_string 在 ${path} 中出现 ${count} 次（要求唯一）。扩大 old_string 的上下文让它唯一，或确认要全改则传 replace_all: true`,
      );
    }

    const updated = replaceAll
      ? content.split(oldString).join(newString)
      : content.replace(oldString, newString);

    const bytes = Buffer.byteLength(updated, "utf8");
    if (bytes > config.workspaceMaxFileBytes) {
      return toolError("edit_file", `修改后 ${bytes} 字节超过单文件上限 ${config.workspaceMaxFileBytes}`);
    }

    // 原子写（与 write_file 同款）。
    const tmp = join(dirname(full), `.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    try {
      writeFileSync(tmp, updated, "utf8");
      renameSync(tmp, full);
    } catch (err) {
      try {
        unlinkSync(tmp);
      } catch {
        // 同 write_file：临时文件清理失败无害
      }
      return toolError("edit_file", `写入失败：${err instanceof Error ? err.message : String(err)}`);
    }
    return `已替换 ${replaceAll ? count : 1} 处（${path}）`;
  },
};
