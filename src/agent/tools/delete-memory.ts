// agent/tools/delete-memory.ts —— 把"删除一条已记住的事"包装成 Agent 可调用的工具。
// 用户描述的是自然语言（query），不是 id，所以先把该 key 下全部记忆的候选列表
// （id + 摘要 + 正文）丢给模型做一次单独的匹配调用，让模型直接回答匹配到的 id，
// 匹配不到就回答"无匹配"——这里不强求模型走 tool_calls 结构化输出，用简单的文本约定
// （只回数字或"无匹配"）就够，避免多嵌一层工具调用的复杂度。

import type { Tool } from "../tool.js";
import { callModel } from "../../services/model.js";
import { memoryKey, pushMemoryNotice } from "../context.js";
import { longTermMemoryStore, type LongTermMemory } from "../memory/long-term.js";

function buildMatchPrompt(query: string, candidates: LongTermMemory[]): string {
  const list = candidates
    .map((m) => `id=${m.id}：${m.memoryIndex}（正文：${m.content}）`)
    .join("\n");
  return `用户想删除一条记忆，描述是：「${query}」

以下是候选记忆列表：
${list}

请判断用户描述最匹配列表中的哪一条，只输出那条记忆的 id（纯数字，不要任何其他文字）；
如果没有一条能对上，只输出：无匹配`;
}

async function matchMemoryId(
  query: string,
  candidates: LongTermMemory[],
): Promise<number | null> {
  const response = await callModel(
    [{ role: "user", content: buildMatchPrompt(query, candidates) }],
    undefined,
    undefined,
    undefined,
    "delete_memory:matchMemoryId",
  );
  const text = response.content?.trim() ?? "";
  const id = Number(text);
  if (!Number.isInteger(id)) {
    return null;
  }
  return candidates.some((m) => m.id === id) ? id : null;
}

export const deleteMemoryTool: Tool = {
  name: "delete_memory",
  description:
    "当用户明确表达希望删除某条已记住的信息时调用（例如说“忘掉……”“删除关于……的记忆”“那条记忆不对了删了吧”）。" +
    "query 参数填用户对想删除内容的描述，会拿去和已有记忆做匹配，不需要用户提供 id。" +
    "群聊场景下任何人都可以删除群共享的记忆，不限于最初记录它的人。",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "用户对想删除的记忆内容的自然语言描述",
      },
    },
    required: ["query"],
  },

  async run(args, ctx) {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (query === "") {
      return "没听清要删除哪条记忆，再说一次吧～";
    }

    const key = memoryKey(ctx.event);
    const candidates = await longTermMemoryStore.list(key);
    if (candidates.length === 0) {
      return "现在还没有记住任何东西，没什么可删的～";
    }

    const matchedId = await matchMemoryId(query, candidates);
    if (matchedId === null) {
      return "没找到匹配的记忆，要不要再描述得具体一点？";
    }

    const matched = candidates.find((m) => m.id === matchedId);
    await longTermMemoryStore.remove(matchedId);
    if (matched !== undefined) {
      await pushMemoryNotice(ctx.event, `记忆已删除，摘要：${matched.memoryIndex}`);
    }
    return "已经把这条记忆删掉了～";
  },
};
