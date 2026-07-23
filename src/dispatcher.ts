// dispatcher.ts —— 分发中枢。
// 职责：拿到一个已解析的强类型事件，按 type 路由到对应 handler。
// 就是你 REPL 里 handleCommand 那个 switch 的升级版——只是判断的字段
// 从"用户敲的命令"变成"事件类型 t"。
// 不关心事件怎么来的、handler 内部怎么处理，只负责"这事件归谁管"。

import type { BotEvent } from "./events.js";
import { handleC2CMessage } from "./handlers/c2c-message.js";

// 分发一个事件。event 为 null（未识别事件）时安静忽略。
export async function dispatch(event: BotEvent | null): Promise<void> {
  if (event === null) return;

  switch (event.type) {
    case "C2C_MESSAGE_CREATE":
      // 命中某个 type 时，TS 已把 event 收窄成对应的具体类型，
      // 传给 handler 不用任何断言——这就是可辨识联合的好处。
      await handleC2CMessage(event);
      return;
    default:
      // 收到已知联合之外的事件（正常不会走到，parseEvent 已把未知事件挡成 null）。
      // 等下一轮 BotEvent 变成"多成员联合"（加了群消息等），这里可以换成
      // assertNever(event) 做「编译期穷尽检查」：漏写某个 case 就编译报错。
      // 现在只有一个成员，穷尽检查还发挥不了价值，先用运行时日志。
      console.warn("[dispatcher] 未处理的事件类型:", event);
  }
}
