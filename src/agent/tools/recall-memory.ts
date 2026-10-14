// agent/tools/recall-memory.ts —— 冷存储检索工具（短期记忆两级化方案 §3.3）。
// 模型判断当前上下文不足以回答（用户提到更早聊过的内容）时主动调用：自己挑
// 关键词，从最近 300 条原始对话里检索命中处前后各 10 条的切片。
// 与长期记忆的分工：长期记忆是提炼过的事实（RAG 自动注入），本工具翻的是
// 原始对话流水（不触发不进上下文）。
//
// skipMemory: true（落库豁免，方案 §3.4）：切片是旧对话的复印件，落库会占满
// 下次热窗口、还会被再次检索到（"记忆的记忆"复利膨胀）。loop.ts 按
// tool_call_id 反查到本工具名后整条剔除——声明在这里，判定逻辑在注册表。

import type { Tool } from "../tool.js";
import { tenantKey } from "../../session/key.js";
import { searchCold } from "../memory/sqlite.js";

export const recallMemoryTool: Tool = {
  name: "recall_memory",
  description:
    "检索更早的对话记忆（最近 300 条原始聊天记录）。当用户提到之前聊过的内容而当前" +
    "上下文里没有（如「我们之前说过什么」「上次你推荐的」「上周聊的那个话题」），" +
    "或你判断回答需要更早的对话信息时调用。关键词用当时对话里最可能出现的原词" +
    "（可传多个同义词提高命中），不要用你自己的转述。",
  parameters: {
    type: "object",
    properties: {
      keywords: {
        type: "array",
        items: { type: "string" },
        description: "检索关键词，1~5 个，用对话里可能出现的原词（同义词一起传）",
      },
    },
    required: ["keywords"],
  },
  skipMemory: true,
  progressNote: (args) => {
    const kws = Array.isArray(args.keywords)
      ? args.keywords.filter((k): k is string => typeof k === "string").slice(0, 3).join("、")
      : "";
    return kws !== "" ? `---正在翻查更早的记忆：${kws}---` : "---正在翻查更早的记忆---";
  },

  async run(args: Record<string, unknown>, ctx) {
    const raw = args.keywords;
    if (!Array.isArray(raw)) {
      return "参数错误：keywords 必须是字符串数组。";
    }
    const keywords = raw.filter((k): k is string => typeof k === "string" && k.trim() !== "");
    if (keywords.length === 0) {
      return "参数错误：至少提供一个关键词。";
    }

    const hits = searchCold(tenantKey(ctx.event), keywords);
    if (hits.length === 0) {
      // 无结果的明确文案：模型能据此诚实回答"翻过了，没有记录"，不再瞎编
      return `在最近 300 条记忆中检索"${keywords.join("、")}"——没有找到相关内容。`;
    }

    const sections = hits
      .map((hit, i) => `── 第 ${i + 1} 处 ──\n${hit.lines.join("\n")}`)
      .join("\n\n");

    return `在最近 300 条记忆中检索"${keywords.join("、")}"，命中 ${hits.length} 处：\n\n${sections}`;
  },
};
