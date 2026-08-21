// events/registry.ts —— 事件注册表 + 解析入口。
// 这里把所有事件定义收集成一个数组，并由数组「自动推导」出 BotEvent 联合类型。
// parseEvent 不再用 switch，而是按 raw.t 去数组里查对应的定义。
//
// ★ 加一种新事件，全项目只需改这个文件的两处：import 一行 + eventDefs 加一项。
//   BotEvent 联合会自动包含新事件，dispatcher 的 handler 表也会因此强制要求补齐。

import type { EventDefinition, BaseEvent } from "./definition.js";
import type { RawEvent } from "./raw.js";
import { c2cMessageDef } from "./C2C_MESSAGE_CREATE/index.js";
import { groupAtMessageDef } from "./GROUP_AT_MESSAGE_CREATE/index.js";
import { groupMessageDef } from "./GROUP_MESSAGE_CREATE/index.js";
import { logger } from "../services/logger.js";

// 所有已知事件定义。加事件 = 往这个数组加一项（并在上面 import）。
// as const 让 TS 记住数组每一项的精确类型，下面才能反推出各事件的联合。
export const eventDefs = [c2cMessageDef, groupAtMessageDef, groupMessageDef] as const;

// 从「定义」反推出它解析出的事件类型：EventDefinition<E> → E。
type EventOf<D> = D extends EventDefinition<infer E> ? E : never;

// BotEvent = 所有已登记定义对应事件的联合。
// 不用手写 union——往 eventDefs 加定义，这个联合自动多一个成员。
export type BotEvent = EventOf<(typeof eventDefs)[number]>;

// ---------- 解析入口 ----------
// 按 raw.t 找对应定义；没登记的事件返回 null（上层安静忽略）。
export function parseEvent(raw: RawEvent): BotEvent | null {
  // 事件心跳：每条消息都会打，严格说够 debug 级，但单进程长驻服务留 info——
  // "链路活着"的可见性优先于安静（级别语义讨论见 logger.ts 头注释）。
  logger.info("events", `收到事件: ${raw.t}`);

  const def = eventDefs.find((d) => d.t === raw.t);
  if (def === undefined) return null;
  // find 拿到的是「定义的联合」，调用 .parse 后 TS 无法收回到精确成员，
  // 做一次局部断言。安全性由各 def 自己的 parse 保证：它要么返回自己那种
  // 事件（BotEvent 的成员），要么返回 null。
  return def.parse(raw) as BotEvent | null;
}

// 顺带导出，方便别处需要「基础事件」约束时引用。
export type { BaseEvent };
