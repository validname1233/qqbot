// session/runner.ts —— 会话拦截器 + 状态机注册表（框架代码）。
// 它插在 runCommand 之前：某会话若正锁在一个状态机里，这条消息就被「接管」，
// 完全交给该状态机处理，不再走普通命令路由——这就是「锁在模式里」的实现。
//
// 加一个新状态机 = 往 machines 数组加一项（并 import）。其余不用动。

import type { MessageContext } from "../types.js";
import type { StateMachine } from "../machines/types.js";
import { SessionStore } from "./store.js";
import { sessionKey } from "./key.js";
import { guessMachine } from "../machines/guess.js";

// 所有已登记的状态机。名字（和别名，若以后加）作为开局命令关键词。
const machines: StateMachine<unknown>[] = [
  guessMachine as StateMachine<unknown>,
];
// 命令关键词 → 状态机，开局时按 ctx.command 查。
const byName = new Map<string, StateMachine<unknown>>();
for (const m of machines) {
  byName.set(m.name, m);
}

// store 里一条会话记录：当前是哪个状态机 + 它的状态。
// state 用 unknown：不同状态机的 state 形状不同，存的时候擦掉具体类型，
// 用的时候把「机器 + 状态」成对取出，一起交回同一个机器的 step——机器自己知道该怎么解读。
interface ActiveSession {
  machine: StateMachine<unknown>;
  state: unknown;
}
const store = new SessionStore<ActiveSession>();

// 拦截结果：handled=false 表示「没接管，请继续走原路由」；
// handled=true 表示「已接管」，reply 是要回的话（可能为空串，正常发送层会过滤）。
export type SessionOutcome =
  | { handled: true; reply: string }
  | { handled: false };

const NOT_HANDLED: SessionOutcome = { handled: false };

export function runSession(ctx: MessageContext): SessionOutcome {
  const key = sessionKey(ctx.event);
  const active = store.get(key);

  // 情况1：该会话正在某状态机中 → 交给它 step，接管这条消息。
  if (active !== undefined) {
    const { machine, state } = active;
    const t = machine.step(state, ctx);
    if (t.nextState === null) {
      store.delete(key); // 会话结束，解锁
    } else {
      store.set(key, { machine, state: t.nextState });
    }
    return { handled: true, reply: t.reply };
  }

  // 情况2：没在会话中，但用户发了某状态机的开局命令 → 开局并锁定。
  if (ctx.command !== null) {
    const machine = byName.get(ctx.command);  //从注册表中找到要启动的状态机
    if (machine !== undefined) {
      const t = machine.start(ctx);
      if (t.nextState !== null) {
        store.set(key, { machine, state: t.nextState });
      }
      return { handled: true, reply: t.reply };
    }
  }

  // 情况3：都不是 → 不接管，交回原有命令路由。
  return NOT_HANDLED;
}
