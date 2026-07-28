// agent/memory/types.ts —— 短期记忆（会话内最近若干条消息）的接口。
// 方法全部声明成 async：哪怕现在是纯内存实现，日后换成 Redis 之类的持久实现同一接口，
// 调用方（loop.ts）一行都不用改，只需换掉具体实现的 import。
//
// 长期记忆（跨会话的用户画像/事实，数据库持久化）本次不实现，只在此留一句概念占位：
// 真正需要时再加一个独立的 LongTermMemoryStore 接口，和这里的短期记忆分开管理，
// 不要混进同一个接口——两者的读写模式、失效策略都不一样。

import type { ChatMessage } from "../types.js";

export interface MemoryStore {
  get(key: string): Promise<ChatMessage[]>;
  append(key: string, ...messages: ChatMessage[]): Promise<void>;
  clear(key: string): Promise<void>;
}
