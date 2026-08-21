// events/GROUP_MESSAGE_CREATE/index.ts —— 群里所有消息事件（不限于@机器人）的全部知识。
// 结构和 GROUP_AT_MESSAGE_CREATE 完全对称，字段含义也完全一致（官方文档原话）——
// 唯一区别是触发条件：机器人后台开启"接收所有消息"后，群里任何消息都会推这个事件，
// 不要求@机器人。开启该开关后，原来的 GROUP_AT_MESSAGE_CREATE 不再单独触发，
// @消息也走这个事件（已通过日志实测确认），所以两个事件定义暂时并存，
// 具体怎么合并/取舍留给后续设计，这里先只搭事件解析的壳。

import type { EventDefinition } from "../definition.js";
import type { RawEvent } from "../raw.js";
import { parseAttachments, type MessageAttachment } from "../attachments.js";

// ---------- 对外提供的「干净事件」 ----------
export interface GroupMessageEvent {
  type: "GROUP_MESSAGE_CREATE";
  content: string; // 消息内容
  attachments: MessageAttachment[]; // 消息附件（图片/语音/视频等），无附件时为空数组
  groupOpenid: string; // 哪个群，回复发到这个群
  authorOpenid: string; // 发消息的群成员 member_openid
  authorName: string; // 发消息人的昵称（author.username）
  msgId: string; // 这条消息的 id，被动回复要带上它
}

// ---------- 守卫：判断 raw.d 是不是群消息的数据结构 ----------
function isGroupMessageData(
  d: unknown,
): d is {
  id: string;
  content: string;
  group_openid: string;
  author: { member_openid: string; username: string };
} {
  if (typeof d !== "object" || d === null) return false;
  const obj = d as Record<string, unknown>;
  if (
    typeof obj.id !== "string" ||
    typeof obj.content !== "string" ||
    typeof obj.group_openid !== "string"
  ) {
    return false;
  }
  const author = obj.author;
  return (
    typeof author === "object" &&
    author !== null &&
    typeof (author as Record<string, unknown>).member_openid === "string" &&
    typeof (author as Record<string, unknown>).username === "string"
  );
}

// ---------- 事件定义 ----------
export const groupMessageDef: EventDefinition<GroupMessageEvent> = {
  t: "GROUP_MESSAGE_CREATE",
  parse(raw: RawEvent): GroupMessageEvent | null {
    if (!isGroupMessageData(raw.d)) return null;
    return {
      type: "GROUP_MESSAGE_CREATE",
      content: raw.d.content,
      attachments: parseAttachments(raw.d),
      groupOpenid: raw.d.group_openid,
      authorOpenid: raw.d.author.member_openid,
      authorName: raw.d.author.username,
      msgId: raw.d.id,
    };
  },
};
