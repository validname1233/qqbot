// messages.ts —— 发送层：把消息发回给 QQ。
// 职责：拼好发消息接口要的 body，调 api.ts 发出去。
// 和 api.ts 的分工：api.ts 是"通用传输层"（鉴权、错误处理、发任意请求），
// messages.ts 是"具体业务"（我要发的是一条消息，body 该长什么样）。
// 类比 todo-cli：api.ts 像通用的 fetch 封装，messages.ts 像 store.ts 里的具体业务函数。

import { apiRequest } from "./api.js";

// 消息类型。0 = 纯文本；2 = Markdown。以后发图片是别的值。
const MSG_TYPE_TEXT = 0;
const MSG_TYPE_MARKDOWN = 2;

// 发送单聊消息（被动回复）。
// openid：收消息人的 user_openid（来自事件的 authorOpenid）。
// content：要回的文本。
// msgId：被动回复必须带上收到的那条消息 id——带了它这条回复 5 分钟内免费，
//        且 QQ 知道这是"回复某条消息"而非主动推送。
// msgSeq：同一条 msgId 的第几次回复，从 1 开始。一条消息只回一次时填 1 即可。
export async function replyC2CMessage(
  openid: string,
  content: string,
  msgId: string,
  msgSeq = 1,
): Promise<void> {
  await apiRequest(`/v2/users/${openid}/messages`, {
    method: "POST",
    body: JSON.stringify({
      content,
      msg_type: MSG_TYPE_TEXT,
      msg_id: msgId,
      msg_seq: msgSeq,
    }),
  });
}

// 主动发送单聊消息（主动推送，非回复）。
// 和 replyC2CMessage 的唯一区别：不带 msg_id / msg_seq。
// 不带 msg_id 时 QQ 就把它当作「主动消息」——不依附于用户某条消息，
// 因此不受「msgId 5 分钟有效」限制，可在任意时刻推送（如定时提醒到点）。
// 代价：主动消息有频控（单好友 20/qpm、每天最多 1000 条）和权限要求
// （无权限报 40034105，未加好友报 40054004，用户拒收报 40054013），
// 这些错误由 apiRequest 统一抛出，调用方需自行兜错。
export async function pushC2CMessage(
  openid: string,
  content: string,
): Promise<void> {
  await apiRequest(`/v2/users/${openid}/messages`, {
    method: "POST",
    body: JSON.stringify({
      content,
      msg_type: MSG_TYPE_TEXT,
    }),
  });
}

// 主动发送群消息（主动推送，非回复）。
// 和 pushC2CMessage 对称：不带 msg_id / msg_seq 即为主动消息，可任意时刻推送。
// 群主动消息要的是 group_openid——群事件里现成就有（不像单聊要 user_openid），
// 所以「群里设提醒、到点推回群」不涉及 openid 转换难题。
// 频控/权限：单群 20/qpm、每天最多 1000 条，未认证 Bot 仅 30/qpm；
// 无权限报 40034105，机器人非群成员报 40034101 / 40054003。错误由 apiRequest 抛出。
export async function pushGroupMessage(
  groupOpenid: string,
  content: string,
): Promise<void> {
  await apiRequest(`/v2/groups/${groupOpenid}/messages`, {
    method: "POST",
    body: JSON.stringify({
      content,
      msg_type: MSG_TYPE_TEXT,
    }),
  });
}

// 主动发送群 Markdown 消息。
// markdownContent：Markdown 格式的内容，支持 ## 标题、**粗体**、换行等（具体格式见官方文档）。
// 注意：发 Markdown 时 msg_type 必须是 2，且 content 字段必须为空。
export async function pushGroupMarkdown(
  groupOpenid: string,
  markdownContent: string,
): Promise<void> {
  await apiRequest(`/v2/groups/${groupOpenid}/messages`, {
    method: "POST",
    body: JSON.stringify({
      content: "", // Markdown 消息要求 content 必须为空
      msg_type: MSG_TYPE_MARKDOWN,
      markdown: {
        content: markdownContent,
      },
    }),
  });
}

// 发送群消息（被动回复）。
// groupOpenid：哪个群（来自事件的 groupOpenid）。
// 其余参数含义同 replyC2CMessage。只是接口路径不同：群消息发到 /v2/groups/...。
export async function replyGroupMessage(
  groupOpenid: string,
  content: string,
  msgId: string,
  msgSeq = 1,
): Promise<void> {
  await apiRequest(`/v2/groups/${groupOpenid}/messages`, {
    method: "POST",
    body: JSON.stringify({
      content,
      msg_type: MSG_TYPE_TEXT,
      msg_id: msgId,
      msg_seq: msgSeq,
    }),
  });
}
