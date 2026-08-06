// agent/tools/add-memory.ts —— 把"记住一件事"包装成 Agent 可调用的工具。
// content 由模型在这次工具调用里直接给；memory_index（检索用的摘要）不让模型顺手一起吐，
// 单独另起一次轻量模型调用生成——索引的措辞要求（偏检索/匹配）和 content 的抽取要求
// （偏原文转述）不一样，混在同一次输出里容易互相干扰，拆开各自更可控。

import type { Tool } from "../tool.js";
import { callModelWithTools } from "../client.js";
import { memoryKey, pushMemoryNotice } from "../context.js";
import { longTermMemoryStore } from "../memory/long-term.js";

const MEMORY_INDEX_PROMPT = `请阅读下面这段用户希望被记住的内容，提炼一句简短的检索摘要（10-20字），
用于以后判断"要不要删除/引用这条记忆"时做语义匹配，只输出摘要本身，不要多余说明：

`;

async function buildMemoryIndex(content: string): Promise<string> {
  const response = await callModelWithTools([
    { role: "user", content: MEMORY_INDEX_PROMPT + content },
  ]);
  return response.content?.trim() || content;
}

export const addMemoryTool: Tool = {
  name: "add_memory",
  description:
    "当用户明确表达希望机器人记住某个信息时调用（例如说“记住……”“帮我记一下……”“以后要记得……”）。" +
    "content 参数填用户想让你记住的具体内容，用你转述的简洁语言概括，不要包含“记住”等指令性词语本身。" +
    "单聊场景下这是关于该用户个人的记忆；群聊场景下这条记忆会被群里所有人共享看到，" +
    "调用前确认这确实是值得群共享的信息，而非仅对发言人本人有意义的私人琐事。",
  parameters: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description: "用户想让你记住的具体内容，简洁转述，不含“记住”等指令词本身",
      },
    },
    required: ["content"],
  },

  async run(args, ctx) {
    const content = typeof args.content === "string" ? args.content.trim() : "";
    if (content === "") {
      return "没听清要记住什么内容，再说一次吧～";
    }

    const memoryIndex = await buildMemoryIndex(content);
    const key = memoryKey(ctx.event);
    await longTermMemoryStore.add(
      key,
      { openid: ctx.event.authorOpenid, name: ctx.event.authorName },
      content,
      memoryIndex,
    );
    await pushMemoryNotice(ctx.event, `记忆已写入，摘要：${memoryIndex}`);
    return `记住了：${content}`;
  },
};
