// agent/tools/clear-all-memories.ts —— 清空当前会话下的所有长期记忆。
// 危险操作：不可逆，必须在工具描述里明确要求用户说"所有"才触发。

import type { Tool } from "../tool.js";
import { pushMemoryNotice } from "../context.js";
import { tenantKey } from "../../session/key.js";
import { longTermMemoryStore } from "../memory/long-term.js";

export const clearAllMemoriesTool: Tool = {
  name: "clear_all_memories",
  description:
    "当用户明确表达希望删除当前会话下「所有」长期记忆时调用（必须包含“所有”“全部”“清空”等明确的全量删除意图，" +
    "例如“删除所有记忆”“清空全部记忆”“把记忆都删了”）。" +
    "这是危险操作，不可逆，只在用户意图非常明确时调用，不要用于删除单条或部分记忆。" +
    "单聊场景下删除该用户的所有记忆；群聊场景下删除该群的所有共享记忆。",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },

  async run(args, ctx) {
    const key = tenantKey(ctx.event);
    const allMemories = await longTermMemoryStore.list(key);

    if (allMemories.length === 0) {
      return "当前还没有任何长期记忆，没什么可删的～";
    }

    // 逐条删除当前 key 下的所有记忆
    for (const memory of allMemories) {
      await longTermMemoryStore.remove(memory.id);
    }

    await pushMemoryNotice(ctx.event, `已清空所有长期记忆（共 ${allMemories.length} 条）`);
    return `好的，已经把所有 ${allMemories.length} 条长期记忆都删掉了～`;
  },
};
