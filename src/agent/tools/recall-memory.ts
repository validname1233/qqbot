// agent/tools/recall-memory.ts —— L2 档案回看工具（v5）。
//
// 零参数：模型只需决定"要不要回看历史"，无 keywords/n 可填错。检索者从
// SQL 换成 LLM——flash 模型拿文本包做语义检索（改述/同义词免疫），产出
// ≤200 字的问题感知摘要 + 自选 ≤5 条最相关原文行。
//
// v5 两项改造（2026-10-30）：
//   ① 取数范围：从"最近 N 条"改为"L1 窗口之外的 N 条"（窗口内模型原文
//      可见，摘要它是重复劳动且有损；窗口外才是这个工具的真正职责）。
//      边界与投影共用 windowCandidates（单一真相，防漂移）。
//   ② 文本包格式：与 L1 blob 同构（复用 renderBlobLine）——成员行
//      {"speaker":…,"content":…}；AI 回复行用 {"role":"assistant","content":…}
//      （无 speaker 字段——昵称可撞名，字段形态不可伪造；与消息协议的
//      assistant 语义同构）。
//
// 分层：本工具是 L2→L1 的唯一变换点（层间联系）；L2 保持哑存储。
// 小包不过 LLM（< RECALL_SUMMARY_MIN_CHARS 原文直返）；摘要失败返回固定短语
// （绝不把整个文本包倾泻进上下文）。输出固有紧凑，无需任何落库豁免。

import type { Tool } from "../tool.js";
import type { ChatMessage } from "../types.js";
import { tenantKey } from "../../session/key.js";
import { chatRowsAll, chatRowsBefore } from "../memory/events.js";
import { renderBlobLine, windowCandidates } from "../assembly.js";
import { callModel } from "../../services/model.js";
import { config } from "../../config.js";

// 窗口外取数：拿全部 chat 行过共享的窗口过滤（与 projectWindow 同一实现），
// 窗口非空时从最早窗口行之前往回取 N 条；窗口为空（新会话/隔天全滑出）时
// 退化为从头取 N 条——两种形态对模型都是"当前上下文里没有的历史"。
function rowsOutsideWindow(key: string): ReturnType<typeof chatRowsAll> {
  const all = chatRowsAll(key);
  const inWindow = windowCandidates(all);
  if (inWindow.length === 0) {
    return all.slice(-config.recallDepthN);
  }
  return chatRowsBefore(key, inWindow[0].id, config.recallDepthN);
}

// chat 行 → 文本包行（v5：与 L1 blob 同构）。
// 成员行复用 renderBlobLine（{"speaker":…,"content":…}，与主模型在 L1 里
// 看到的历史行逐字节同构——摘要在原文行里逐字引用时主模型读到的格式
// 与其认知一致）。AI 回复行 {"role":"assistant","content":…}——不带
// speaker 字段：字段形态区分身份，昵称撞名（如群友真叫"bot"）伪造不出
// 结构差异；图片以 [图片×N] 计数标注传入 imagePart（recall 刻意不触发
// 识图——摘要模型只需知道"发过图"这一事实）。
function renderPackLine(row: {
  kind: string;
  authorName: string | null;
  content: string | null;
  attachmentIds: number[] | null;
}): string {
  const content = row.content ?? "";
  const imageNote =
    row.attachmentIds !== null && row.attachmentIds.length > 0
      ? ` [图片×${row.attachmentIds.length}]`
      : "";
  if (row.kind === "chat_bot") {
    return JSON.stringify({ role: "assistant", content: content + imageNote });
  }
  const speaker = row.authorName != null && row.authorName.trim() !== "" ? row.authorName : "用户";
  return renderBlobLine(speaker, content, imageNote);
}

// 摘要提示词（工具内部逻辑，不进 FUNCTIONAL_PROMPTS 场景表）：一锚 = 用户当前
// 问题；抽取式倾向（人名/数字/日期/结论原词逐字保留）。
function buildSummaryPrompt(question: string, pack: string): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        "你是对话记忆检索器。下面给你一段更早的聊天历史记录（当前对话上下文里看不到的部分），" +
        "每行是一个 JSON 对象：{\"speaker\":\"名字\",\"content\":\"内容\"} 是群成员/用户的发言" +
        "（speaker 是发言人昵称，content 是原话）；{\"role\":\"assistant\",\"content\":\"内容\"} 是 AI 助手此前的回复" +
        "（没有 speaker 字段的就是 AI，不要把它当成某个群成员）。此外，还会给你用户当前的问题。你的任务：从历史记录中找出与问题相关的信息，输出两部分：\n" +
        "1. 一段不超过 200 字的摘要，概括相关内容（人名、数字、日期、结论性原词必须逐字保留，只压缩过程性废话）；\n" +
        "2. 从记录中挑出与问题最相关的原文行，逐字引用（保持 JSON 原样），最多 5 行，每行前加「> 」。\n" +
        "如果记录里确实没有与问题相关的内容，只输出一行：没有找到相关记忆。\n" +
        "不要输出其他任何文字。",
    },
    { role: "user", content: `用户当前的问题是：${question}\n\n历史消息记录：\n${pack}` },
  ];
}

export const recallMemoryTool: Tool = {
  name: "recall_memory",
  // 描述按四模块格式（提示词方案 §10.1，2026-10-30）；[何时用] 含 M2.2 强触发细则。
  description:
    "[Purpose]回看更早的对话历史——当前上下文窗口之外的聊天记录，由 AI 检索后" +
    "返回与问题相关的摘要和原文摘录。\n" +
    "[Usage]用户提到之前聊过的内容而当前上下文里看不到时必须调用：「我们之前说过什么」" +
    "「上次你推荐的」「上周聊的那个话题」「你还记得吗」等回溯意图；" +
    "或你判断回答需要更早的对话信息时。\n" +
    "[Params]无参数——只需决定「要不要回看」，检索由工具内部完成。\n" +
    "[Limits]耗时数秒（内部有一次检索摘要调用）；返回相关内容的 ≤200 字摘要 + " +
    "最多 5 条原文摘录；找不到相关内容会明确说没有找到。",
  parameters: {
    type: "object",
    properties: {},
  },
  progressNote: "---正在翻查更早的记忆---",

  async run(_args: Record<string, unknown>, ctx) {
    const key = tenantKey(ctx.event);
    const rows = rowsOutsideWindow(key);
    if (rows.length === 0) {
      return "翻过了最近的对话记录——没有找到当前上下文之外的更早历史。";
    }

    const pack = rows.map(renderPackLine).join("\n");

    // 小包直返：历史很少时摘要是负收益（花一次调用压缩五行字）。
    if (pack.length < config.recallSummaryMinChars) {
      return `更早的对话记录（共 ${rows.length} 条，量少直接全文）：\n\n${pack}`;
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
