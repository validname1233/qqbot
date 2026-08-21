// events/C2C_MESSAGE_CREATE/index.ts —— 单聊消息事件的全部知识都在这一个文件里：
// 干净事件的类型（interface）、判断 raw.d 是否合法的守卫、以及事件定义（def）。
// 加/改这种事件只动这里，parse 和 dispatch 都不用碰。

import type { EventDefinition } from "../definition.js";
import type { RawEvent } from "../raw.js";
import { parseAttachments, type MessageAttachment } from "../attachments.js";

// ---------- 对外提供的「干净事件」 ----------
// type 字段是判别式标签，dispatcher 和可辨识联合靠它区分事件种类。
export interface C2CMessageEvent {
  type: "C2C_MESSAGE_CREATE";
  content: string; // 用户说的话
  attachments: MessageAttachment[]; // 消息附件（图片/语音/视频等），无附件时为空数组
  authorOpenid: string; // 发消息的人，回复就发给这个 openid
  authorName: string; // 发消息人的昵称（author.username）
  msgId: string; // 这条消息的 id，被动回复要带上它
}

// ---------- 守卫：运行时判断 raw.d 是不是单聊消息的数据结构 ----------
// 网络来的 d 是 unknown，不可信。先逐字段验一遍，验过 TS 才允许当这个形状用。
function isC2CMessageData(
  d: unknown,
): d is { id: string; content: string; author: { user_openid: string; username: string } } {
  if (typeof d !== "object" || d === null) return false;
  const obj = d as Record<string, unknown>;
  if (typeof obj.id !== "string" || typeof obj.content !== "string") {
    return false;
  }
  const author = obj.author;
  return (
    typeof author === "object" &&
    author !== null &&
    typeof (author as Record<string, unknown>).user_openid === "string" &&
    typeof (author as Record<string, unknown>).username === "string"
  );
}

// ---------- 事件定义 ----------
// 回答两个问题：对应哪个 t、raw 来了怎么解析。registry 会收集它。
export const c2cMessageDef: EventDefinition<C2CMessageEvent> = {
  t: "C2C_MESSAGE_CREATE",
  parse(raw: RawEvent): C2CMessageEvent | null {
    if (!isC2CMessageData(raw.d)) return null;
    return {
      type: "C2C_MESSAGE_CREATE",
      content: raw.d.content,
      attachments: parseAttachments(raw.d),
      authorOpenid: raw.d.author.user_openid,
      authorName: raw.d.author.username,
      msgId: raw.d.id,
    };
  },
};
