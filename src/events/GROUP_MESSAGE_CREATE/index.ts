// events/GROUP_MESSAGE_CREATE/index.ts —— 群里所有消息事件（不限于@机器人）的全部知识。
// 结构和 GROUP_AT_MESSAGE_CREATE 完全对称，字段含义也完全一致（官方文档原话）——
// 唯一区别是触发条件：机器人后台开启"接收所有消息"后，群里任何消息都会推这个事件，
// 不要求@机器人。开启该开关后，原来的 GROUP_AT_MESSAGE_CREATE 不再单独触发，
// @消息也走这个事件（2026-10-15 payload 实测确认）：
//   - content 内嵌 <@openid> 标记（如 "<@A5C2...> 你好"）；
//   - mentions 数组逐 @ 一条，bot 的那条带 is_you:true / bot:true。
// mentionsBot 字段把"@ 的是不是本机器人"从 payload 里提炼出来（is_you 判定，
// 不比对任何配置 ID），路由层据此把这种消息当 @消息对待（转 /Agent）。

import type { EventDefinition } from "../definition.js";
import type { RawEvent } from "../raw.js";
import { parseAttachments, type MessageAttachment } from "../attachments.js";

// ---------- 对外提供的「干净事件」 ----------
export interface GroupMessageEvent {
  type: "GROUP_MESSAGE_CREATE";
  content: string; // 消息内容（保留原始形态，含 <@openid> 标记——路由转发前另行剥离）
  attachments: MessageAttachment[]; // 消息附件（图片/语音/视频等），无附件时为空数组
  groupOpenid: string; // 哪个群，回复发到这个群
  authorOpenid: string; // 发消息的群成员 member_openid
  authorRole: "member" | "admin" | "owner" | null; // 群内角色（author.member_role）。缺失/非法值为 null——权限判断必须把 null 当普通成员处理（fail-closed），见知识库按钮权限方案 §3.1
  authorName: string; // 发消息人的昵称（author.username）
  msgId: string; // 这条消息的 id，被动回复要带上它
  mentionsBot: boolean; // 本条消息是否 @ 了本机器人（mentions[].is_you，平台判定）
}

// mentions 数组里单项的最小形状（只取判定要用的字段，其余忽略）。
interface MentionEntry {
  is_you?: unknown;
}

function isMentionList(v: unknown): v is MentionEntry[] {
  return Array.isArray(v);
}

// ---------- 守卫：判断 raw.d 是不是群消息的数据结构 ----------
function isGroupMessageData(
  d: unknown,
): d is {
  id: string;
  content: string;
  group_openid: string;
  author: { member_openid: string; username: string; member_role?: string };
  mentions?: unknown;
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
    // @ 本机器人的判定：mentions 里存在 is_you:true 的条目。手打的假 @ 不进
    // mentions，天然不会误判；is_you 由平台标注，无需配置机器人自身 ID。
    const mentionsBot =
      isMentionList(raw.d.mentions) && raw.d.mentions.some((m) => m.is_you === true);
    return {
      type: "GROUP_MESSAGE_CREATE",
      content: raw.d.content,
      attachments: parseAttachments(raw.d),
      groupOpenid: raw.d.group_openid,
      authorOpenid: raw.d.author.member_openid,
      authorRole:
        raw.d.author.member_role === "member" ||
        raw.d.author.member_role === "admin" ||
        raw.d.author.member_role === "owner"
          ? raw.d.author.member_role
          : null,
      authorName: raw.d.author.username,
      msgId: raw.d.id,
      mentionsBot,
    };
  },
};

// content 里的 <@openid> 标记剥离：转发给 /Agent 前清掉 markup（Agent 不需要
// 看到这串，"你好"比"<@A5C2...> 你好"干净）。非贪婪匹配到下一个 >，只剥
// mentions 形态的标记（<@ + 十六进制串 + >），普通尖括号文本不受影响。
export function stripAtBotMention(content: string): string {
  return content.replace(/<@[0-9A-Fa-f]+>\s*/g, "").trim();
}
