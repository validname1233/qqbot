// session/key.ts —— 算「会话键」，也就是画出「谁和谁共享同一份状态」的边界。
// SessionStore 只是按 key 存取的哑容器，共享粒度全在这个 key 里：
//   同一个 key 的消息 → 命中同一份状态；不同 key → 天然隔离。
//
// 当前策略：锁到「人」。单聊按用户；群聊按「这个群里的这个人」——
// 群里各玩各的，互不干扰。若以后要「一个群一桌大家共用一局」（如德州扑克），
// 把群分支的末尾 `:${authorOpenid}` 去掉即可，粒度就从「人」升到「群」。

import type { BotEvent } from "../events/registry.js";

// 前缀 group: / c2c: 是命名空间隔离：万一群 openid 和用户 openid 字符串偶然相同，
// 有前缀就不会串到同一份状态里。event.type 一判，TS 把 event 收窄到对应事件，
// 才能安全访问 groupOpenid / authorOpenid（可辨识联合收窄，和 dispatcher 里同一套路）。
export function sessionKey(event: BotEvent): string {
  if (event.type === "GROUP_AT_MESSAGE_CREATE") {
    return `group:${event.groupOpenid}:${event.authorOpenid}`;
  }
  return `c2c:${event.authorOpenid}`;
}
