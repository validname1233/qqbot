// agent/memory/in-memory.ts —— MemoryStore 的内存实现。
// 复用现成的 SessionStore<S>（类型安全的 Map 壳），key 的画法交给调用方
// （loop.ts 传 sessionKey(ctx.event)，天然「每人每场景」隔离，和状态机用的是同一套键）。
//
// ⚠️ 存内存：进程重启（每次自动部署发版）记忆即清空，取舍和 SessionStore 本身一致。

import { SessionStore } from "../../session/store.js";
import type { ChatMessage } from "../types.js";
import type { MemoryStore } from "./types.js";

// 保留最近多少条消息——防止历史无限增长（多轮工具调用也会占用轮次）。
const MAX_MESSAGES = 20;

const store = new SessionStore<ChatMessage[]>();

export const inMemoryStore: MemoryStore = {
  async get(key: string): Promise<ChatMessage[]> {
    return store.get(key) ?? [];
  },

  async append(key: string, ...messages: ChatMessage[]): Promise<void> {
    const history = store.get(key) ?? [];
    store.set(key, [...history, ...messages].slice(-MAX_MESSAGES));
  },

  async clear(key: string): Promise<void> {
    store.delete(key);
  },
};
