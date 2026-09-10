// services/progress-bus.ts —— 进度推送事件总线（docs/features/2026-09-10-进度推送Bus设计方案.md）。
// 解决的问题：/Agent 与 /深度检索 全程 10s~3min，用户在最终回复前没有反馈。
// 做法：工具/节点执行时 emit 一条进度文案，bus 把它送到"当前请求订阅者"的会话
// （群或私聊）——推送与工具（文案各异）、与聊天场景（群/私聊分支）全部解耦。
//
// 核心形态是「请求作用域订阅」而非全局广播：入口函数（runAgentTurn）订阅
// （绑定这次请求的 event），finally 退订——会话隔离由作用域天然保证（A 在群甲
// 的请求不会把进度发到群乙），/stop 中断与异常路径由退订兜住。无订阅者时
// emit 是 no-op：深检（一期未接入）或请求已结束后的迟到事件直接丢弃。
//
// 订阅 key 用 sessionKey（人粒度），与 /stop 并发闸（beginControlledFlow）
// 同粒度——同 key 并发请求本来就被闸挡住，"一个 key 至多一个活跃订阅"成立。

import type { BotEvent } from "../events/registry.js";
import { sessionKey } from "../session/key.js";
import { pushGroupMessage, pushC2CMessage } from "../qq/messages.js";
import { logger } from "./logger.js";

// 订阅者回调：真正执行发送。由 makeListener 按事件类型构造（群/私聊分支
// 全项目从此只此一份）。
type Listener = (text: string) => Promise<void>;

const listeners = new Map<string, Listener>();

// 群/私聊分支的统一适配器：进度消息全部走主动推送（push，不带 msg_id）——
// 不消耗被动回复额度（群聊每条消息仅 5 次），也不受 5 分钟回复窗口约束
// （长流程的进度天然可能落在窗口外）。
function makeListener(event: BotEvent): Listener {
  return async (text) => {
    if (event.type === "GROUP_AT_MESSAGE_CREATE" || event.type === "GROUP_MESSAGE_CREATE") {
      await pushGroupMessage(event.groupOpenid, text);
    } else {
      await pushC2CMessage(event.authorOpenid, text);
    }
  };
}

// 请求入口调用（runAgentTurn）：建立这次请求的进度订阅，返回退订函数。
// 重复订阅同 key 时新替旧（防御性——并发闸正常工作时不会走到）。
export function subscribeProgress(event: BotEvent): () => void {
  const key = sessionKey(event);
  listeners.set(key, makeListener(event));
  return () => {
    // 只删自己的订阅：退订时若 key 已被新订阅占据，说明有异常并发，不误删
    if (listeners.get(key) !== undefined) listeners.delete(key);
  };
}

// 切面埋点调用（registry.ts 的 runTool）：向当前订阅者投递一条进度文案。
// 同步返回、不 await 送达——事件源（工具执行）永远不为推送耗时买单；
// listener 的失败在这里兜成 warn（用户关闭"允许主动消息"时静默降级，
// 进度提示是锦上添花，不能炸掉工具本身）。
export function emitProgress(event: BotEvent, text: string): void {
  const key = sessionKey(event);
  const listener = listeners.get(key);
  if (listener === undefined) return;
  listener(text).catch((error: unknown) => {
    logger.warn(
      "progress",
      `进度推送失败（忽略）：${error instanceof Error ? error.message : error}`,
    );
  });
}
