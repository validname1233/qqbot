// types.ts —— service 层的公共契约（框架代码，非具体服务，故放 src 根）。
// 这里只放"形状"，不放任何实现。handler、registry、各个具体 service 都 import 这里，
// 保证大家对"一条消息长什么样""一个 service 该实现哪些方法"有一致的理解。

import type { BotEvent } from "./events/registry.js";

// 一条消息规整后的统一输入。消息只解析一次，命令型和观察型 service 共用它。
// 好处：具体 service 不用各自再 parse 一遍 event.content，拿来即用。
// event 是 BotEvent（单聊或群消息）——两种事件都有 content/authorOpenid/msgId，
// service 拿这几个字段即可，不必关心具体是哪种事件。
export interface MessageContext {
  event: BotEvent; // 原始事件。service 要 openid / msgId 时从这里取
  text: string; // 去掉首尾空白后的完整内容
  command: string | null; // "聊天" / "游戏模式" / null（消息没带 / 命令）
  args: string; // 命令后面的部分。"/聊天 今天天气" → "今天天气"
}

// 命令型 service（router 模型）：用户用 / 命令显式点名才触发，
// 一条消息最多命中一个。handle 返回要回复的话；返回 null 表示这次不回。
export interface CommandService {
  name: string; // 命令关键词，也是它在注册表里的键。如 "聊天"
  aliases?: string[]; // 选填别名，如 ["chat"]
  handle(ctx: MessageContext): Promise<string | null>;
}

// 观察型 service（observer 模型）：不被点名，每条消息都会跑一遍。
// 想说话就返回文本，不想说返回 null。典型用途：计数、成就、日志。
export interface ObserverService {
  name: string; // 仅用于日志区分，如 "成就"
  observe(ctx: MessageContext): Promise<string | null>;
}
