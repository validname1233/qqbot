// events/INTERACTION_CREATE/index.ts —— 消息按钮回调事件的全部知识（方案
// docs/features/2026-11-10-回调按钮实现方案.md §2.1/§3）。
// 用户点击回调按钮（action.type=1）后，QQ 平台推这个事件到 webhook；外层
// 信封与消息事件同构（op=0），d 的契约经 2026-11-18 真机实测校正：
//   d.id                  —— 交互 id（回应接口 PUT /interactions/{id} 的键）
//   d.type = 11           —— 消息按钮回调标识
//   d.data.resolved       —— { button_data, button_id }（两个都在这层嵌套里）
//   d.group_member_openid —— 群聊里点按钮的人（真机字段名，非文档的 user_openid）
//   d.user_openid         —— 单聊时点按钮的人（按文档推断，待单聊真机确认）
//   d.scene / d.chat_type / d.group_openid —— 会话定位
//
// 与消息事件的本质差异：这不是聊天内容——不进 transcript（dispatcher 分流），
// 处理走 button-registry 的命名空间路由，而非命令/观察者体系。

import type { EventDefinition } from "../definition.js";
import type { RawEvent } from "../raw.js";

// ---------- 对外提供的「干净事件」 ----------
export interface InteractionCreateEvent {
  type: "INTERACTION_CREATE";
  interactionId: string;
  buttonData: string; // 发送时填的 action.data 原文（"ns:payload" 路由格式）
  buttonId: string; // 发送时填的按钮 id
  userOpenid: string; // 谁点的（群聊取 group_member_openid，单聊取 user_openid）
  scene: "group" | "c2c" | "guild";
  chatType: 1 | 2; // 1=群 2=单聊
  groupOpenid: string | null; // 群聊时有值；单聊 null
}

// ---------- 守卫 ----------
// 逐层防御：任何一层缺失/类型不对都返回 null（registry 安静忽略——解析不了
// 的事件比解析错的强，真机新形态靠 debug 日志的 payload dump 排查）。
interface InteractionData {
  id: string;
  type: number;
  scene: string;
  chat_type: number;
  group_openid: string | undefined;
  user_openid: string | undefined; // 单聊形态（文档记载，待真机确认）
  group_member_openid: string | undefined; // 群聊形态（2026-11-18 真机实测）
  data: { resolved: { button_data: string; button_id: string } };
}

function isInteractionData(d: unknown): d is InteractionData {
  if (typeof d !== "object" || d === null) return false;
  const obj = d as Record<string, unknown>;
  if (obj.type !== 11) return false; // 11 = 消息按钮回调
  if (typeof obj.id !== "string") return false;
  if (typeof obj.scene !== "string" || typeof obj.chat_type !== "number") return false;
  if (obj.group_openid !== undefined && typeof obj.group_openid !== "string") return false;
  if (obj.user_openid !== undefined && typeof obj.user_openid !== "string") return false;
  if (obj.group_member_openid !== undefined && typeof obj.group_member_openid !== "string") return false;
  const data = obj.data;
  if (typeof data !== "object" || data === null) return false;
  const resolved = (data as Record<string, unknown>).resolved;
  if (typeof resolved !== "object" || resolved === null) return false;
  return (
    typeof (resolved as Record<string, unknown>).button_data === "string" &&
    typeof (resolved as Record<string, unknown>).button_id === "string"
  );
}

// ---------- 事件定义 ----------
export const interactionCreateDef: EventDefinition<InteractionCreateEvent> = {
  t: "INTERACTION_CREATE",
  parse(raw: RawEvent): InteractionCreateEvent | null {
    if (!isInteractionData(raw.d)) return null;
    // 点按人：群聊给 group_member_openid，单聊给 user_openid；两者都缺 = 解析不了
    const who = raw.d.group_member_openid ?? raw.d.user_openid;
    if (who === undefined) return null;
    const scene = raw.d.scene;
    if (scene !== "group" && scene !== "c2c" && scene !== "guild") return null;
    if (raw.d.chat_type !== 1 && raw.d.chat_type !== 2) return null;
    return {
      type: "INTERACTION_CREATE",
      interactionId: raw.d.id,
      buttonData: raw.d.data.resolved.button_data,
      buttonId: raw.d.data.resolved.button_id,
      userOpenid: who,
      scene,
      chatType: raw.d.chat_type,
      groupOpenid: raw.d.group_openid ?? null,
    };
  },
};
