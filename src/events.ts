// events.ts —— 事件类型定义 + 解析。
// 职责单一：把 QQ 推来的那坨 raw JSON，收窄成"强类型的事件对象"。
// 只回答"这是什么事件、里面有哪些字段"，不关心怎么处理、怎么回消息。
//
// 为什么单独一层：webhook.ts 只知道"收到一个 op 0"，但 op 0 里其实有很多种事件
// （单聊消息、群@消息、加好友……），靠 payload.t 区分。把"raw JSON → 类型安全对象"
// 这步隔离出来，好处是它是纯数据转换，容易单独测试，且改这里不影响分发和业务。

// ---------- QQ 原始事件的外层结构 ----------
// op 0 的 body 长这样：{ op:0, id, t:"C2C_MESSAGE_CREATE", d:{...} }
// t 是事件类型字符串，d 是该事件的数据。d 的形状随 t 变化，先按 unknown 收着，
// 解析时再按 t 收窄——这正是 TS 的类型守卫大显身手的地方。
export interface RawEvent {
  op: number;
  id?: string;
  t?: string;
  d?: unknown;
}

// ---------- 我们对外提供的"干净事件" ----------
// 用可辨识联合（discriminated union）：每个成员都有一个 type 字段作为"标签"，
// switch(event.type) 命中某个分支时，TS 自动知道该分支下 event 的完整结构。
// 这比到处传 raw JSON 安全得多——类比给杂乱数据套上一个明确的"信封"。

// 单聊消息事件。
export interface C2CMessageEvent {
  type: "C2C_MESSAGE_CREATE";
  content: string; // 用户说的话
  authorOpenid: string; // 发消息的人，回复就发给这个 openid
  msgId: string; // 这条消息的 id，被动回复要带上它
}

// 以后加群@消息时，在这里加 GroupAtMessageEvent，并加进下面的联合类型。

// 所有已知事件的联合。未识别的事件解析后返回 null（见下）。
export type BotEvent = C2CMessageEvent;

// ---------- 类型守卫：判断 d 是不是单聊消息的数据结构 ----------
// 从刚收到的真实 JSON 提炼：d 里有 id / content / author.user_openid。
function isC2CMessageData(
  d: unknown,
): d is { id: string; content: string; author: { user_openid: string } } {
  if (typeof d !== "object" || d === null) return false;
  const obj = d as Record<string, unknown>;
  if (typeof obj.id !== "string" || typeof obj.content !== "string") {
    return false;
  }
  const author = obj.author;
  return (
    typeof author === "object" &&
    author !== null &&
    typeof (author as Record<string, unknown>).user_openid === "string"
  );
}

// ---------- 解析入口 ----------
// 输入已 JSON.parse 的 raw 事件，输出强类型的 BotEvent。
// 不认识的事件（还没写 handler 的类型）返回 null，让上层安静忽略——
// 这样以后 QQ 加新事件类型，我们不会崩，只是暂不处理。
export function parseEvent(raw: RawEvent): BotEvent | null {
  switch (raw.t) {
    case "C2C_MESSAGE_CREATE": {
      if (!isC2CMessageData(raw.d)) return null;
      return {
        type: "C2C_MESSAGE_CREATE",
        content: raw.d.content,
        authorOpenid: raw.d.author.user_openid,
        msgId: raw.d.id,
      };
    }
    default:
      return null;
  }
}
