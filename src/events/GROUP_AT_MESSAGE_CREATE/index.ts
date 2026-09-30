// events/GROUP_AT_MESSAGE_CREATE/index.ts —— 群里@机器人消息事件的全部知识。
// 结构和 C2C_MESSAGE_CREATE 完全对称：干净事件类型 + 守卫 + 事件定义。
// 对比着看两种事件，就能明白「加一种事件」到底要写什么。
//
// 和单聊的关键差异：群消息的 d 里带 group_openid（回复要发到群，而非某个人），
// 发消息人的标识是 author.member_openid（群成员 openid），不是 user_openid。

import type { EventDefinition } from "../definition.js";
import type { RawEvent } from "../raw.js";
import { parseAttachments, type MessageAttachment } from "../attachments.js";
import { logger } from "../../services/logger.js";

// ---------- 对外提供的「干净事件」 ----------
export interface GroupAtMessageEvent {
  type: "GROUP_AT_MESSAGE_CREATE";
  content: string; // 消息内容
  attachments: MessageAttachment[]; // 消息附件（图片/语音/视频等），无附件时为空数组
  groupOpenid: string; // 哪个群，回复发到这个群
  authorOpenid: string; // 发消息的群成员 member_openid
  authorUserOpenid: string | null; // 发送者的 user_openid（单聊场景 OpenID）。官方 User 类型声明了该字段但群事件示例未携带、是否实际填充未经真机验证——缺失为 null，调用方必须显式处理，不能假设它有值
  authorName: string; // 发消息人的昵称（author.username）
  msgId: string; // 这条消息的 id，被动回复要带上它
}

// ---------- 守卫：判断 raw.d 是不是群@消息的数据结构 ----------
function isGroupAtMessageData(
  d: unknown,
): d is {
  id: string;
  content: string;
  group_openid: string;
  author: { member_openid: string; username: string; user_openid?: string };
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
export const groupAtMessageDef: EventDefinition<GroupAtMessageEvent> = {
  t: "GROUP_AT_MESSAGE_CREATE",
  parse(raw: RawEvent): GroupAtMessageEvent | null {
    if (!isGroupAtMessageData(raw.d)) return null;
    // author 原文进 detail 流水（日志体系设计：detail 层存原文不截断）。
    // 这是 user_openid/member_role 是否随群事件下发的验证仪器——真机跑一次，
    // 文件日志里即有定案证据，不再依赖文档示例的推断。
    logger.detail("events", `GROUP_AT_MESSAGE_CREATE author 原文: ${JSON.stringify(raw.d.author)}`);
    return {
      type: "GROUP_AT_MESSAGE_CREATE",
      content: raw.d.content,
      attachments: parseAttachments(raw.d),
      groupOpenid: raw.d.group_openid,
      authorOpenid: raw.d.author.member_openid,
      authorUserOpenid:
        typeof raw.d.author.user_openid === "string" && raw.d.author.user_openid !== ""
          ? raw.d.author.user_openid
          : null,
      authorName: raw.d.author.username,
      msgId: raw.d.id,
    };
  },
};
