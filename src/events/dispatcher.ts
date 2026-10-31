// events/dispatcher.ts —— 分发中枢。
// 不再用 switch，而是一张「事件类型 → handler」的查表。
// 关键收益：HandlerMap 这个类型会强制「BotEvent 里每种事件都必须配一个 handler」——
// 在 events/registry 登记了新事件却忘了在这里加 handler，会直接编译报错，
// 而不是等运行时才发现没人处理。这就是你之前想要的「编译期穷尽检查」。

import type { BotEvent } from "./registry.js";
import { handleC2CMessage } from "../handlers/C2C_MESSAGE_CREATE.js";
import { handleGroupAtMessage } from "../handlers/GROUP_AT_MESSAGE_CREATE.js";
import { handleGroupMessage } from "../handlers/GROUP_MESSAGE_CREATE.js";
import { recordInbound } from "../services/transcript.js";
import { logger } from "../services/logger.js";

// 遍历 BotEvent 的每个成员，用它的 type 当键，
// 要求对应 handler 的入参正好是「那一种」事件。
// 漏一个事件的键 → 缺少必填属性 → 编译报错。
type HandlerMap = {
  [E in BotEvent as E["type"]]: (event: E) => Promise<void>;
};

const handlers: HandlerMap = {
  C2C_MESSAGE_CREATE: handleC2CMessage,
  GROUP_AT_MESSAGE_CREATE: handleGroupAtMessage,
  GROUP_MESSAGE_CREATE: handleGroupMessage,
};

// 分发一个事件。event 为 null（未识别事件）时安静忽略。
export async function dispatch(event: BotEvent | null): Promise<void> {
  if (event === null) return;

  // 入站转录收口（总方案模块一 §1.2）：所有消息（命令/非命令/状态机）在路由
  // 分叉之前先落一行 chat_user——"每类事件恰好一个写入者"的入站那一半。
  // 串行 await 是有意的：保证 chat_user 行 id 恒小于本轮 process/chat_bot 行
  // （时间线正确）；带图消息的代价是一次图片下载（≤10s 超时，常态 1~2s）。
  //
  // 分发层短路（2026-10-30 决议）：recordInbound 返回 false = UNIQUE 撞上
  // （QQ 重推同一条事件）——行已在库，handler 跳过，保证"执行恰一次"
  //（此前只挡住了重复落库，重推仍会重跑完整 /Agent：重复烧钱 + 重复回复）。
  // 幂等锚点即库的 UNIQUE，非进程内 LRU——无容量边界，重启不失效，重放
  // 历史消息（验签无新鲜度窗口的已知缺口）同样被短路挡在执行层之外。
  const firstSeen = await recordInbound(event);
  if (!firstSeen) {
    logger.info("events", `QQ 重推事件，分发层短路（msgId=${event.msgId.slice(0, 12)}…）`);
    return;
  }

  // event.type 和 handlers[event.type] 的入参是关联的，但 TS 无法自动证明
  // 这种「关联联合」的对应关系，故做一次局部断言。运行时是安全的：
  // 每个 type 对应的 handler 就是接收那种事件的函数。
  const handler = handlers[event.type] as (e: BotEvent) => Promise<void>;
  await handler(event);
}
