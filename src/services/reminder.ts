// services/reminder.ts —— 命令型 service：定时提醒。
// 用法：/定时任务 3600 提醒我一个小时之后去做饭
//   第一个参数 3600 = 延时秒数（10~86400 闭区间整数）；其后整段 = 提醒描述。
// 到点后调 askAI 生成一句提醒话术，用 pushC2CMessage「主动推送」给用户。
//
// ★ 关键设计：handle 里 setTimeout 排期后「立刻返回」确认，不 await 等到点。
//   设置和触发是两个分离的时刻——用户马上收到「已设置」，提醒本身在未来独立触发。
//   （若在 handle 里 await 睡到点，用户会一直收不到确认，还会阻塞整条处理链。）

import type { CommandService, MessageContext } from "../types.js";
import { callModel } from "./model.js";
import { pushC2CMessage, pushGroupMessage } from "../qq/messages.js";
import { getSystemPrompt } from "./prompts/builder.js";
import { logger } from "./logger.js";

const MIN_SECONDS = 10;
const MAX_SECONDS = 86400; // 一天

// ---------- 核心逻辑：校验 + 排期 + 到点推送 ----------
// 抽成独立函数，好让「用户手打命令」（下面的 handle）和「agent 工具调用」
// （agent/tools/set-reminder.ts，结构化参数，不用再解析字符串）共用同一份逻辑，不重复。
// 返回值就是要回给调用方的确认/错误文案，两边直接原样转发即可。
export function scheduleReminder(
  ctx: MessageContext,
  seconds: number,
  description: string,
): string {
  // 校验秒数：必须是 10~86400 的整数。
  if (!Number.isInteger(seconds) || seconds < MIN_SECONDS || seconds > MAX_SECONDS) {
    return `秒数得是 ${MIN_SECONDS} 到 ${MAX_SECONDS} 之间的整数啦，你写的是「${seconds}」。`;
  }
  if (description.trim() === "") {
    return "提醒内容不能为空哦，告诉我到点要提醒你干嘛～";
  }

  // 单聊推给用户(user_openid)，群聊推回群(group_openid)。两种目标都在事件里现成有。
  //
  // ★ 这里刻意用「每种已知事件各写一个 if 分支、其余显式返回 null」，
  //   而不是「不是群聊就默认单聊」的兜底 else。原因：将来若新增第三种事件也触发
  //   本命令，兜底 else 会把它误当单聊、去取未必有效的 openid，酿成隐性 bug；
  //   而显式穷尽下，未知事件走到最后返回 null，据此明确拒绝，不会走错线。
  // 提醒正文模板（两场景共用）：只陈述事实（时间到了、要做什么），
  // 语气/身份交给 system 里的人格（getSystemPrompt 已按会话拼好自定义或默认人格）。
  // 旧版曾把"雌小鬼、必须嫌弃语气开头"等硬编码进这段 user 正文，等于越过
  // 提示词体系写死人设——换人格体系后这里只留任务事实。
  const reminderUserContent = `用户设置了一条${seconds}秒的定时提醒，现在时间到了。用户当时设定的提醒内容是：${description}。请你根据这个信息，用你的语气提醒用户现在去做这件事，要清楚地说明该做什么，并带一点催促的意味。`;

  const buildPush = (): (() => Promise<void>) | null => {
    const event = ctx.event;
    if (event.type === "C2C_MESSAGE_CREATE") {
      const openid = event.authorOpenid; // 单聊的 authorOpenid 才是 user_openid
      return async () => {
        const response = await callModel(
          [
            { role: "system", content: getSystemPrompt(ctx.event, "reminder") },
            { role: "user", content: reminderUserContent },
          ],
          undefined,
          undefined,
          undefined,
          "reminder:c2c",
        );
        await pushC2CMessage(openid, "时间到啦！" + (response.content ?? ""));
      };
    }
    if (event.type === "GROUP_AT_MESSAGE_CREATE" || event.type === "GROUP_MESSAGE_CREATE") {
      const groupOpenid = event.groupOpenid;
      return async () => {
        const response = await callModel(
          [
            { role: "system", content: getSystemPrompt(ctx.event, "reminder") },
            { role: "user", content: reminderUserContent },
          ],
          undefined,
          undefined,
          undefined,
          "reminder:group",
        );
        await pushGroupMessage(groupOpenid, "时间到啦！" + (response.content ?? ""));
      };
    }
    return null; // 未知事件类型：本功能不支持，交由下面拒绝
  };

  const push = buildPush();
  if (push === null) {
    return "这种消息场景暂时不支持定时提醒哦～";
  }

  // 排期。setTimeout 只登记「未来某刻跑一次」，立即返回、不占线程。
  // 回调本身必须自带 try/catch：定时器回调里的异常没人接，漏出去会拖垮进程。
  setTimeout(() => {
    void push().catch((err: unknown) => {
      logger.error("reminder", `到点推送失败: ${err instanceof Error ? err.message : err}`);
    });
  }, seconds * 1000);

  // 立即回确认。提醒在未来触发，与这条确认互不阻塞。
  return `本鲸鱼知道啦！${seconds} 秒后提醒你`;
}

export const reminderService: CommandService = {
  name: "定时任务",
  aliases: ["提醒", "remind"],

  async handle(ctx: MessageContext): Promise<string | null> {
    // 在 args 内部按第一个空格再切一刀：前面是秒数，后面整段是描述。
    const trimmed = ctx.args.trim();
    const spaceIdx = trimmed.indexOf(" ");
    if (spaceIdx === -1) {
      return "用法：/定时任务 秒数 提醒内容，例如 /定时任务 3600 一小时后去做饭";
    }
    const secondsText = trimmed.slice(0, spaceIdx);
    const description = trimmed.slice(spaceIdx + 1).trim();

    // Number("3600abc") 是 NaN，会被 scheduleReminder 里的 isInteger 挡掉。
    const seconds = Number(secondsText);
    return scheduleReminder(ctx, seconds, description);
  },
};
