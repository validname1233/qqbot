// agent/tools/recall-memory.ts —— L2 档案回看工具（v4，总方案模块一 §1.3）。
//
// 零参数：模型只需决定"要不要回看历史"，无 keywords/n 可填错。检索者从
// SQL 换成 LLM——flash 模型拿最近 N 条 chat 行的文本包做语义检索（改述/
// 同义词免疫），产出 ≤200 字的问题感知摘要 + 自选 ≤5 条最相关原文行。
//
// 分层：本工具是 L2→L1 的唯一变换点（层间联系）；L2 保持哑存储。
// 小包不过 LLM（< RECALL_SUMMARY_MIN_CHARS 原文直返）；摘要失败返回固定短语
// （绝不把整个文本包倾泻进上下文）。输出固有紧凑，无需任何落库豁免。

import type { Tool } from "../tool.js";
import type { ChatMessage } from "../types.js";
import { tenantKey } from "../../session/key.js";
import { chatRows } from "../memory/events.js";
import { callModel } from "../../services/model.js";
import { config } from "../../config.js";

// chat 行 → 文本包行（"昵称：内容"口径；图片以 attachment_ids 的存在性提及，
// 不触发识图——摘要模型只需知道"发过图"）。
function renderPackLine(row: { kind: string; authorName: string | null; content: string | null; attachmentIds: number[] | null }): string {
  if (row.kind === "chat_bot") {
    return `bot：${row.content ?? ""}`;
  }
  const speaker = row.authorName != null && row.authorName.trim() !== "" ? row.authorName : "用户";
  const imageNote = row.attachmentIds !== null && row.attachmentIds.length > 0 ? ` [图片×${row.attachmentIds.length}]` : "";
  return `${speaker}：${row.content ?? ""}${imageNote}`;
}

// 摘要提示词（工具内部逻辑，不进 FUNCTIONAL_PROMPTS 场景表）：一锚 = 用户当前
// 问题；抽取式倾向（人名/数字/日期/结论原词逐字保留）。
function buildSummaryPrompt(question: string, pack: string): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        "你是对话记忆检索器。下面给你一段群聊/单聊的历史消息记录（每行「说话人：内容」），" +
        "以及用户当前的问题。你的任务：从历史记录中找出与问题相关的信息，输出两部分：\n" +
        "1. 一段不超过 200 字的摘要，概括相关内容（人名、数字、日期、结论性原词必须逐字保留，只压缩过程性废话）；\n" +
        "2. 从记录中挑出与问题最相关的原文行，逐字引用，最多 5 行，每行前加「> 」。\n" +
        "如果记录里确实没有与问题相关的内容，只输出一行：没有找到相关记忆。\n" +
        "不要输出其他任何文字。",
    },
    { role: "user", content: `用户当前的问题是：${question}\n\n历史消息记录：\n${pack}` },
  ];
}

export const recallMemoryTool: Tool = {
  name: "recall_memory",
  description:
    "回看更早的对话历史（最近几百条聊天记录，由 AI 检索摘要）。当用户提到之前聊过的内容" +
    "而当前上下文里没有（如「我们之前说过什么」「上次你推荐的」「上周聊的那个话题」），" +
    "或你判断回答需要更早的对话信息时调用。无需参数。",
  parameters: {
    type: "object",
    properties: {},
  },
  progressNote: "---正在翻查更早的记忆---",

  async run(_args: Record<string, unknown>, ctx) {
    const key = tenantKey(ctx.event);
    const rows = chatRows(key, config.recallDepthN);
    if (rows.length === 0) {
      return "翻过了最近的对话记录——这个会话还没有历史消息。";
    }

    const pack = rows.map(renderPackLine).join("\n");

    // 小包直返：历史很少时摘要是负收益（花一次调用压缩五行字）。
    if (pack.length < config.recallSummaryMinChars) {
      return `最近的对话记录（共 ${rows.length} 条，量少直接全文）：\n\n${pack}`;
    }

    // flash 检索式摘要。失败降级为固定短语——绝不倾泻文本包。
    try {
      const summary = await callModel(
        buildSummaryPrompt(ctx.args, pack),
        undefined,
        config.aiModel,
        false,
        "recall_memory",
      );
      const text = summary.content ?? "";
      if (text.trim() === "") {
        return "记忆检索暂时失败，请稍后再试。";
      }
      return text;
    } catch {
      return "记忆检索暂时失败，请稍后再试。";
    }
  },
};
