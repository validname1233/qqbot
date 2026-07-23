// handlers/c2c-message.ts —— 单聊消息的业务处理。
// 职责：拿到一个已解析的单聊事件，决定回什么，然后调发送层发出去。
// 不关心 HTTP、不关心验签、不关心怎么拼 API body——那些是别的层的事。
//
// 统一约定：每个 handler 都长成 handleXxx(event): Promise<void>——
// 输入一个强类型事件，自己负责回消息，不返回值。签名统一，dispatcher 才能一致地调。

import type { C2CMessageEvent } from "../events.js";
import { replyC2CMessage } from "../messages.js";

export async function handleC2CMessage(event: C2CMessageEvent): Promise<void> {
  // 最简业务：原样把用户说的话回一句。以后在这里加命令解析、调各种功能。
  const reply = `你说了：${event.content}`;
  await replyC2CMessage(event.authorOpenid, reply, event.msgId);
}
