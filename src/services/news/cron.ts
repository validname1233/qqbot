// services/news/cron.ts —— 把"数据库里的订阅配置"转成"实际跑着的 node-cron 任务"，
// 两者之间的同步全在这里管，subscription.ts 只管改配置、调这里的 register/unregister。
//
// 活跃任务表（groupOpenid -> ScheduledTask）是进程内状态，不落库——每次改配置
// 都直接操作内存里的任务对象，重启后靠 initializeNewsCron 从数据库重新建一遍，
// 不需要"持久化任务本身"这种更复杂的设计。

import cron, { type ScheduledTask } from "node-cron";
import { callModel } from "../model.js";
import { pushGroupMessage } from "../../qq/messages.js";
import { tavilySearch, type SearchResult } from "../search.js";
import { listEnabledSubscriptions, type NewsSubscription } from "./store.js";
import { getSystemPrompt } from "../prompts/builder.js";
import type { BotEvent } from "../../events/registry.js";

// 所有群的活跃 cron 任务。key 是 groupOpenid。
const activeTasks = new Map<string, ScheduledTask>();

// 大模型本身不知道"今天是哪天"，这里用系统时钟现算一份日期文本，喂给下面两处：
// 一是拼进 Tavily 的搜索词，让搜索结果更贴近"最近/今天"而不是泛泛的历史结果；
// 二是拼进 askAI 的提示词，让生成的开场白里日期相关的表达（"今天""周几"之类）不会瞎编。
// Asia/Shanghai 写死，和 registerCron 里 cron 任务的时区保持一致。
function todayDateText(): string {
  return new Date().toLocaleDateString("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  });
}

// 把搜索结果拼成喂给模型的正文：只给标题+内容，不给链接——链接留着最后手动拼接，
// 不假手模型转述，避免转述时把网址改错。
function formatNewsForModel(results: SearchResult[]): string {
  return results
    .map((r, i) => `${i + 1}. 标题：${r.title}\n内容：${r.content}`)
    .join("\n\n");
}

// 把链接列表拼成"相关链接如下：1.xxx\n2.xxx"这种手动附加的文本，序号和模型输出的
// 新闻序号对应，方便用户对照着点链接。
function formatLinksList(results: SearchResult[]): string {
  const lines = results.map((r, i) => `${i + 1}.${r.url}`).join("\n");
  return `相关链接如下：\n${lines}`;
}

// 到点要做的事：搜索关键词 -> 模型生成开场白+分点介绍 -> 手动拼接链接列表 -> 推送到群。
// 单独抽出来，registerCron 和 initializeNewsCron 都不用关心具体怎么发。
async function runNewsPush(sub: NewsSubscription): Promise<void> {
  const dateText = todayDateText();
  const results = await tavilySearch(`${sub.keyword} ${dateText}`, sub.maxResults);

  if (results.length === 0) {
    await pushGroupMessage(sub.groupOpenid, "今天没搜到相关新闻，本鲸鱼也很无奈～");
    return;
  }

  // 构造一个假的 BotEvent，只为了让 getSystemPrompt 能拿到 groupOpenid
  const fakeEvent: BotEvent = {
    type: "GROUP_MESSAGE_CREATE",
    groupOpenid: sub.groupOpenid,
    authorOpenid: "",
    authorName: "",
    content: "",
    attachments: [], // 假事件不带附件，真实事件解析时才可能非空
    msgId: "",
  };

  const newsForModel = formatNewsForModel(results);
  const response = await callModel(
    [
      { role: "system", content: getSystemPrompt(fakeEvent, "news_intro") },
      {
        role: "user",
        content: `今天是${dateText}，今天的新闻关键词是"${sub.keyword}"，以下是搜集到的新闻：\n\n${newsForModel}\n\n请生成新闻播报开场白，并对每条新闻分点介绍。`,
      },
    ],
    undefined,
    undefined,
    undefined,
    "news:intro",
  );
  const intro = response.content ?? "";
  const linksList = formatLinksList(results);
  await pushGroupMessage(sub.groupOpenid, `${intro}\n\n${linksList}`);
}

// 给一个群注册/重建 cron 任务：先销毁旧的（如果有），再按最新配置建一个新的。
// 时区显式写死成 Asia/Shanghai，避免服务器时区和用户预期的北京时间不一致。
export function registerCron(sub: NewsSubscription): void {
  unregisterCron(sub.groupOpenid);

  const task = cron.schedule(
    `${sub.minute} ${sub.hour} * * *`,
    () => {
      void runNewsPush(sub).catch((err: unknown) => {
        console.error(`[新闻订阅] 群 ${sub.groupOpenid} 推送失败:`, err);
      });
    },
    { timezone: "Asia/Shanghai" },
  );

  activeTasks.set(sub.groupOpenid, task);
}

export function unregisterCron(groupOpenid: string): void {
  const task = activeTasks.get(groupOpenid);
  if (task) {
    void task.destroy();
    activeTasks.delete(groupOpenid);
  }
}

// 启动时调用一次：把数据库里所有 enabled=1 的订阅重新挂载成 cron 任务，
// 保证进程重启后已开启的订阅不需要用户重新 /新闻订阅 开。
export function initializeNewsCron(): void {
  const subs = listEnabledSubscriptions();
  for (const sub of subs) {
    registerCron(sub);
  }
  console.log(`[新闻订阅] 已恢复 ${subs.length} 个群的定时推送`);
}
