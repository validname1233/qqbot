// services/news/subscription.ts —— 命令型 service：群新闻订阅的开关/调参入口。
// 用法：
//   /新闻订阅 开              开启（没配置过就用默认值：9:00，关键词"科技"，5条）
//   /新闻订阅 关              关闭
//   /新闻订阅 时间 9:00        设置每天推送的时分
//   /新闻订阅 关键词 科技 财经  设置搜索关键词（空格后整段原样存）
//
// 只在群聊场景可用——订阅按群维度区分（group_openid 主键），单聊没有"群"这个概念。
// 具体推送逻辑（搜索、生成开场白、发消息）全在 cron.ts，这里只管读写配置 + 同步 cron 任务。

import type { CommandService, MessageContext } from "../../types.js";
import {
  getSubscription,
  upsertSubscription,
  NEWS_DEFAULTS,
  type NewsSubscription,
} from "./store.js";
import { registerCron, unregisterCron } from "./cron.js";

const USAGE =
  "用法：/新闻订阅 开 | 关 | 时间 9:00 | 关键词 科技 财经";

// 取当前群已有配置，没有就用默认值兜底——开关/改时间/改关键词都基于这份"当前值"改一项。
function getOrDefault(groupOpenid: string): NewsSubscription {
  return (
    getSubscription(groupOpenid) ?? {
      groupOpenid,
      enabled: false,
      hour: NEWS_DEFAULTS.hour,
      minute: NEWS_DEFAULTS.minute,
      keyword: NEWS_DEFAULTS.keyword,
      maxResults: NEWS_DEFAULTS.maxResults,
    }
  );
}

// 从事件里取群 openid。和 reminder.ts 的 buildPush 一样，穷尽已知群事件类型，
// 不认识的事件类型显式返回 null，不走"默认当群聊"的兜底 else。
function getGroupOpenid(ctx: MessageContext): string | null {
  const event = ctx.event;
  if (event.type === "GROUP_AT_MESSAGE_CREATE" || event.type === "GROUP_MESSAGE_CREATE") {
    return event.groupOpenid;
  }
  return null;
}

// 解析 "9:00" / "09:30" 这种 H:MM 格式，返回 null 表示格式不对或数值越界。
function parseTime(text: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{1,2})$/.exec(text.trim());
  if (!match) {
    return null;
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }
  return { hour, minute };
}

export const newsSubscriptionService: CommandService = {
  name: "新闻订阅",

  async handle(ctx: MessageContext): Promise<string | null> {
    const groupOpenid = getGroupOpenid(ctx);
    if (groupOpenid === null) {
      return "这个功能只能在群里用哦～";
    }

    const trimmed = ctx.args.trim();
    const spaceIdx = trimmed.indexOf(" ");
    const subCommand = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
    const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

    if (subCommand === "开") {
      const sub: NewsSubscription = { ...getOrDefault(groupOpenid), enabled: true };
      upsertSubscription(sub);
      registerCron(sub);
      return `已开启！每天 ${sub.hour}:${String(sub.minute).padStart(2, "0")} 给你们推送新闻，杂鱼们记得看～`;
    }

    if (subCommand === "关") {
      const sub: NewsSubscription = { ...getOrDefault(groupOpenid), enabled: false };
      upsertSubscription(sub);
      unregisterCron(groupOpenid);
      return "关掉啦，以后不主动烦你们了～";
    }

    if (subCommand === "时间") {
      const time = parseTime(rest);
      if (time === null) {
        return "时间格式不对哦，要写成 H:MM，比如 /新闻订阅 时间 9:00";
      }
      const sub: NewsSubscription = { ...getOrDefault(groupOpenid), ...time };
      upsertSubscription(sub);
      if (sub.enabled) {
        registerCron(sub);
      }
      return `时间改成每天 ${sub.hour}:${String(sub.minute).padStart(2, "0")} 啦～`;
    }

    if (subCommand === "关键词") {
      if (rest === "") {
        return "关键词不能为空哦，比如 /新闻订阅 关键词 科技 财经";
      }
      const sub: NewsSubscription = { ...getOrDefault(groupOpenid), keyword: rest };
      upsertSubscription(sub);
      if (sub.enabled) {
        registerCron(sub);
      }
      return `关键词改成「${rest}」啦～`;
    }

    return USAGE;
  },
};
