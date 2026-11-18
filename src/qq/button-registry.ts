// qq/button-registry.ts —— 回调按钮的命名空间路由注册表（方案 2026-11-10 §2.2）。
// 形态对照 registry.ts 的命令注册表：业务在启动期 registerButtonHandler("ns",
// handler)，INTERACTION_CREATE handler 把 button_data 按第一个冒号切出 ns，
// 查表分发。业务零管道知识接入（发按钮 + 注册处理器两件事），管道零业务
// 知识分发。
//
// button_data 格式约定（§2.1）："ns:payload"。ns = 小写字母开头的短标识
//（callbackButton 构造时已校验），payload = 处理器自定义（可再含冒号）。

import type { InteractionCreateEvent } from "../events/INTERACTION_CREATE/index.js";

// 交付给业务处理器的「一次点击」现场。回应平台（3 秒契约）已由管道层完成，
// 业务拿到的只有语义字段；要给用户反馈就在处理器里发消息（主动 push 或
// 用 event_id 被动回复，见方案 §7.3）。
export interface ButtonInteraction {
  interactionId: string;
  namespace: string;
  payload: string;
  buttonId: string;
  userOpenid: string; // 谁点的——验权的锚点（平台 permission 只是辅防线）
  scene: "group" | "c2c" | "guild";
  chatType: 1 | 2;
  groupOpenid: string | null;
}

export interface ButtonHandler {
  // 返回 true = 已正常处理；false / 抛错 = 管道层补回应 code:1（失败）。
  handle(interaction: ButtonInteraction): Promise<boolean>;
}

const handlers = new Map<string, ButtonHandler>();

// 启动期注册（与命令注册表同生命周期）。重复 ns 直接覆盖——模块重载/热更
// 场景下后注册者胜，不抛错（个人 bot 无并发注册竞争）。
export function registerButtonHandler(namespace: string, handler: ButtonHandler): void {
  handlers.set(namespace, handler);
}

export function findButtonHandler(namespace: string): ButtonHandler | undefined {
  return handlers.get(namespace);
}

// 事件 → 交互现场 的形状转换（管道 handler 调用；buttonData 已在源头校验
// 过格式，这里仍防御切割——解析不到 ns 返回 null，管道层按坏数据兜）。
export function toButtonInteraction(event: InteractionCreateEvent): ButtonInteraction | null {
  const idx = event.buttonData.indexOf(":");
  if (idx <= 0) return null;
  return {
    interactionId: event.interactionId,
    namespace: event.buttonData.slice(0, idx),
    payload: event.buttonData.slice(idx + 1),
    buttonId: event.buttonId,
    userOpenid: event.userOpenid,
    scene: event.scene,
    chatType: event.chatType,
    groupOpenid: event.groupOpenid,
  };
}
