// handlers/c2c-message.ts —— 单聊消息的业务处理。
// 职责：拿到一个已解析的单聊事件，决定回什么，然后调发送层发出去。
// 不关心 HTTP、不关心验签、不关心怎么拼 API body——那些是别的层的事。
//
// 统一约定：每个 handler 都长成 handleXxx(event): Promise<void>——
// 输入一个强类型事件，自己负责回消息，不返回值。签名统一，dispatcher 才能一致地调。

import type { C2CMessageEvent } from "../events.js";
import { replyC2CMessage } from "../messages.js";
import { askAI } from "../ai.js";

export async function handleC2CMessage(event: C2CMessageEvent): Promise<void> {
  // 把用户的话交给 AI，拿到回复再发回去。
  // AI 调用可能失败（网络、余额、限流……），单独 try 兜住：
  // 失败时回一句友好提示，而不是让整个事件处理崩掉、用户干等没反应。
  let reply: string;
  try {
    reply = await askAI(event.content);
  } catch (err) {
    console.error("[handler] AI 调用失败:", err);
    reply = "抱歉，我现在有点忙，稍后再试试吧。";
  }
  await replyC2CMessage(event.authorOpenid, reply, event.msgId);
}
