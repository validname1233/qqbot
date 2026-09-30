// machines/types.ts —— 所有「状态机」的公共契约（框架代码，非具体实现）。
// 一个状态机 = 一种「锁住会话的多轮交互」（猜数字、以后的德州扑克……）。
// 统一成同一个形状，runSession 才能不认识具体是谁、却能一致地调度。
//
// 设计要点：
//  · step 是「纯 reducer」：旧状态 + 用户这条消息 → 新状态 + 要回的话。
//    绝不在里面发消息、也不 await 网络——副作用（发消息）交给外层 handler 统一做。
//    好处：① 能脱离 QQ 单测规则 ② 同步纯计算天然绕开并发覆盖状态的坑。
//  · nextState === null 是「会话结束」信号：runSession 据此把这份状态从 store 删掉，
//    用户就回到普通模式了（猜中了 / 主动退出都走这条）。

import type { MessageContext } from "../types.js";

// 机器声明、runCommand 执行的副作用（命令模式：描述与执行分离）。
// 为什么不让 step 自己发：纯 reducer 纪律（见文件头）——扑克一步转移的产出
// 是复合的（群里播报 + 每人一条私聊底牌），一旦 step 里直接 await 发送，
// 两条消息并发处理会交错覆盖状态。所以 step 只产出这份清单，runCommand 统一兑现。
export type Effect =
  | { kind: "dm"; openid: string; text: string } // 私聊（发底牌等秘密信息）
  | { kind: "group-push"; groupOpenid: string; text: string }; // 主动群推（超出被动回复 5 分钟窗口时的播报）

// 一步转移的产物：下一个状态 + 这一步要回给用户的话。
// 泛型 <S>：具体状态的形状由各状态机自己定义。
export interface Transition<S> {
  nextState: S | null; // 新状态；null = 会话结束，请清除
  reply: string; // 这一步回给用户的话（开局白 / 提示 / 结算语）
  passThrough?: boolean; // true = 这条消息不归我，放行回普通路由（状态原样保留，局继续）
  effects?: Effect[]; // 额外副作用清单，由 runCommand 统一执行
}

export interface StateMachine<S> {
  // 触发开局的命令关键词，也是它在注册表里的键。如 "猜数字"。
  name: string;

  // 开局：创建初始状态 + 开场白。用户发对应命令时被调用。
  // 返回 nextState 为 null 表示「开局即结束」（一般不会，但接口允许）。
  start(ctx: MessageContext): Transition<S>;

  // 会话进行中，每条消息都喂进这里。这是核心 reducer。
  step(state: S, ctx: MessageContext): Transition<S>;
}
