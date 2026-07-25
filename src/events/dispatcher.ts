// events/dispatcher.ts —— 分发中枢。
// 不再用 switch，而是一张「事件类型 → handler」的查表。
// 关键收益：HandlerMap 这个类型会强制「BotEvent 里每种事件都必须配一个 handler」——
// 在 events/registry 登记了新事件却忘了在这里加 handler，会直接编译报错，
// 而不是等运行时才发现没人处理。这就是你之前想要的「编译期穷尽检查」。

import type { BotEvent } from "./registry.js";
import { handleC2CMessage } from "../handlers/C2C_MESSAGE_CREATE.js";
import { handleGroupAtMessage } from "../handlers/GROUP_AT_MESSAGE_CREATE.js";

// 遍历 BotEvent 的每个成员，用它的 type 当键，
// 要求对应 handler 的入参正好是「那一种」事件。
// 漏一个事件的键 → 缺少必填属性 → 编译报错。
type HandlerMap = {
  [E in BotEvent as E["type"]]: (event: E) => Promise<void>;
};

const handlers: HandlerMap = {
  C2C_MESSAGE_CREATE: handleC2CMessage,
  GROUP_AT_MESSAGE_CREATE: handleGroupAtMessage,
};

// 分发一个事件。event 为 null（未识别事件）时安静忽略。
export async function dispatch(event: BotEvent | null): Promise<void> {
  if (event === null) return;

  // event.type 和 handlers[event.type] 的入参是关联的，但 TS 无法自动证明
  // 这种「关联联合」的对应关系，故做一次局部断言。运行时是安全的：
  // 每个 type 对应的 handler 就是接收那种事件的函数。
  const handler = handlers[event.type] as (e: BotEvent) => Promise<void>;
  await handler(event);
}
