// messages.ts —— 发送层：把消息发回给 QQ。
// 职责：拼好发消息接口要的 body，调 api.ts 发出去。
// 和 api.ts 的分工：api.ts 是"通用传输层"（鉴权、错误处理、发任意请求），
// messages.ts 是"具体业务"（我要发的是一条消息，body 该长什么样）。
// 类比 todo-cli：api.ts 像通用的 fetch 封装，messages.ts 像 store.ts 里的具体业务函数。

import { apiRequest } from "./api.js";

// 消息类型。0 = 纯文本。以后发图片/markdown 是别的值。
const MSG_TYPE_TEXT = 0;

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

// 以后加 replyGroupMessage（发到 /v2/groups/{group_openid}/messages）时放这里。
