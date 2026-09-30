// messages.ts —— 发送层：把消息发回给 QQ。
// 职责：拼好发消息接口要的 body，调 api.ts 发出去。
// 和 api.ts 的分工：api.ts 是"通用传输层"（鉴权、错误处理、发任意请求），
// messages.ts 是"具体业务"（我要发的是一条消息，body 该长什么样）。
// 类比 todo-cli：api.ts 像通用的 fetch 封装，messages.ts 像 store.ts 里的具体业务函数。

import { apiRequest } from "./api.js";
import { logger } from "../services/logger.js";

// 出站轨迹（阶段二全局日志）：每条消息实际发出后一行留痕（收/发是日志视图的
// 两个端点，此前发送成功是静默的）。只记规模与方向，不记正文（正文在上游的
// detail 流水里已有）。发送失败直接抛（apiRequest 的既有行为），由调用方兜。
function traceOut(kind: string, target: string, content: string, extra = ""): void {
  logger.node("qq", `发送 ${kind} → ${target}（${content.length} 字${extra}）`);
}

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
  traceOut("单聊回复", openid, content, ` seq=${msgSeq}`);
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
  traceOut("单聊推送", openid, content);
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
  traceOut("群推送", groupOpenid, content);
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
  traceOut("群推送Markdown", groupOpenid, markdownContent);
}

// 发送群 Markdown 消息（被动回复）。
// 和 pushGroupMarkdown 的关系同 replyGroupMessage/pushGroupMessage：带 msg_id/msg_seq
// 即被动回复（5 分钟窗口内、免频控），body 结构与主动版一致（content 必须为空）。
export async function replyGroupMarkdown(
  groupOpenid: string,
  markdownContent: string,
  msgId: string,
  msgSeq = 1,
): Promise<void> {
  await apiRequest(`/v2/groups/${groupOpenid}/messages`, {
    method: "POST",
    body: JSON.stringify({
      content: "",
      msg_type: MSG_TYPE_MARKDOWN,
      markdown: {
        content: markdownContent,
      },
      msg_id: msgId,
      msg_seq: msgSeq,
    }),
  });
  traceOut("群回复Markdown", groupOpenid, markdownContent, ` seq=${msgSeq}`);
}

// 发送带按钮（keyboard）的群 Markdown 消息（被动回复）。
// 在 replyGroupMarkdown 基础上加 keyboard 字段（按钮是 Markdown 消息的配套能力，
// 构造见 qq/keyboard.ts）。注意与 handler 的"Markdown 失败回退纯文本"降级链的关系：
// 本函数的调用方（如知识库管理入口）消息正文/按钮里可能携带敏感载荷（URL），
// 降级纯文本重发会把载荷裸露——调用方必须自己 catch 并回不含载荷的文案，
// 不能让回复落入 handler 的降级链（方案文档 §4.3 的红线）。
export async function replyGroupMarkdownWithKeyboard(
  groupOpenid: string,
  markdownContent: string,
  keyboard: { content: { rows: Array<{ buttons: unknown[] }> } },
  msgId: string,
  msgSeq = 1,
): Promise<void> {
  await apiRequest(`/v2/groups/${groupOpenid}/messages`, {
    method: "POST",
    body: JSON.stringify({
      content: "",
      msg_type: MSG_TYPE_MARKDOWN,
      markdown: {
        content: markdownContent,
      },
      keyboard,
      msg_id: msgId,
      msg_seq: msgSeq,
    }),
  });
  traceOut("群回复Markdown+按钮", groupOpenid, markdownContent, ` seq=${msgSeq}`);
}

// 发送单聊 Markdown 消息（被动回复）。结构与 replyGroupMarkdown 一致，路径不同。
// 注意：单聊客户端对 Markdown 的渲染支持不如群聊稳定，调用方应做好失败回退。
export async function replyC2CMarkdown(
  openid: string,
  markdownContent: string,
  msgId: string,
  msgSeq = 1,
): Promise<void> {
  await apiRequest(`/v2/users/${openid}/messages`, {
    method: "POST",
    body: JSON.stringify({
      content: "",
      msg_type: MSG_TYPE_MARKDOWN,
      markdown: {
        content: markdownContent,
      },
      msg_id: msgId,
      msg_seq: msgSeq,
    }),
  });
  traceOut("单聊回复Markdown", openid, markdownContent, ` seq=${msgSeq}`);
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
  traceOut("群回复", groupOpenid, content, ` seq=${msgSeq}`);
}
