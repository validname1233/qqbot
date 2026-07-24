// events/definition.ts —— 「事件定义」的契约。
// 一个事件定义（EventDefinition）把「某种事件的全部解析知识」打包成一个对象：
//   ① 它对应 QQ 的哪个 t 字符串
//   ② raw 来了怎么解析成干净的强类型对象
// 每种事件写一个这样的对象，registry 把它们收集起来。加事件 = 加一个定义。

import type { RawEvent } from "./raw.js";

// 所有干净事件的共同点：都带一个 type 字段当「判别式标签」。
// switch(event.type) / handlers[event.type] 靠它区分是哪种事件。
export interface BaseEvent {
  type: string;
}

// 事件定义。泛型 E 是这种事件解析后的强类型（如 C2CMessageEvent）。
export interface EventDefinition<E extends BaseEvent> {
  t: string; // QQ 原始事件类型，如 "C2C_MESSAGE_CREATE"
  // 把 raw 解析成强类型事件；结构不符（不是这种事件的数据）返回 null。
  parse(raw: RawEvent): E | null;
}
