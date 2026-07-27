// services/reminder.ts —— 命令型 service：定时提醒。
// 用法：/定时任务 3600 提醒我一个小时之后去做饭
//   第一个参数 3600 = 延时秒数（10~86400 闭区间整数）；其后整段 = 提醒描述。
// 到点后调 askAI 生成一句提醒话术，用 pushC2CMessage「主动推送」给用户。
//
// ★ 关键设计：handle 里 setTimeout 排期后「立刻返回」确认，不 await 等到点。
//   设置和触发是两个分离的时刻——用户马上收到「已设置」，提醒本身在未来独立触发。
//   （若在 handle 里 await 睡到点，用户会一直收不到确认，还会阻塞整条处理链。）

import type { CommandService, MessageContext } from "../types.js";
import { askAI } from "./ai.js";
import { pushC2CMessage, pushGroupMessage } from "../qq/messages.js";

const MIN_SECONDS = 10;
const MAX_SECONDS = 86400; // 一天

// 提醒场景专用的系统提示词：覆盖默认聊天人设，但仍守「单段、无换行、无 Markdown」格式。
const REMINDER_SYSTEM_PROMPT = `
你是一只名为汐汐的雌小鬼鲸鱼娘，蓝白鲸鱼尾、贝壳发饰、水手服，日常用挑衅傲娇语气称呼对方为人类或杂鱼，句尾可带波浪号或音符，但内心善良且知识渊博；闲聊时保持毒舌调侃，遇到知识性问题或求助必须先简短吐槽再提供完整、准确、结构化的专业解答，全部内容必须写成一段连贯文字，禁止使用编号、项目符号、换行或任何Markdown格式
`;

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

    // 校验秒数：必须是 10~86400 的整数。
    // Number("3600abc") === NaN 会被 isInteger 挡掉；Number("") === 0 这里不会出现
    // （secondsText 是空格前的非空片段），但范围检查也会兜住 0。
    const seconds = Number(secondsText);
    if (!Number.isInteger(seconds) || seconds < MIN_SECONDS || seconds > MAX_SECONDS) {
      return `第一个参数得是 ${MIN_SECONDS} 到 ${MAX_SECONDS} 之间的整数秒数啦，你写的是「${secondsText}」。`;
    }
    if (description === "") {
      return "提醒内容不能为空哦，告诉我到点要提醒你干嘛～";
    }

    // 到点时要推给谁、用哪个接口——现在就按事件类型定好，抓进闭包。
    // 单聊推给用户(user_openid)，群聊推回群(group_openid)。两种目标都在事件里现成有。
    //
    // ★ 这里刻意用「每种已知事件各写一个 if 分支、其余显式返回 null」，
    //   而不是「不是群聊就默认单聊」的兜底 else。原因：将来若新增第三种事件也触发
    //   本命令，兜底 else 会把它误当单聊、去取未必有效的 openid，酿成隐性 bug；
    //   而显式穷尽下，未知事件走到最后返回 null，handle 据此明确拒绝，不会走错线。
    const buildPush = (): (() => Promise<void>) | null => {
      const event = ctx.event;
      if (event.type === "C2C_MESSAGE_CREATE") {
        const openid = event.authorOpenid; // 单聊的 authorOpenid 才是 user_openid
        return async () => {
          const reply = await askAI(
            `
            定时任务已经走完了你设定的${seconds}秒，现在时间到了，用户需要立刻去做的具体事情是[${description}]，请你根据这个信息，用符合你雌小鬼鲸鱼娘的身份来发出提醒，必须以嫌弃或调侃的语气开头，比如“嘁，终于到点了”或“哈？磨蹭这么久”，然后直接、清晰、毫不含糊地告诉用户现在必须执行那个任务，不能只重复描述而要带有催促执行的意味，最后再补一句傲娇的叮嘱或威胁，比如“做不好可别怪我没提醒你”之类，整段回复必须连贯成一个自然段落，不允许换行、列表或任何Markdown格式，如果任务涉及知识内容可以在催促后附带一句简短实用建议，但主要目标是让用户立刻行动起来。
            `,
            REMINDER_SYSTEM_PROMPT,
          );
          await pushC2CMessage(openid, reply);
        };
      }
      if (event.type === "GROUP_AT_MESSAGE_CREATE") {
        const groupOpenid = event.groupOpenid;
        return async () => {
          const reply = await askAI(
            `
            定时任务已经走完了你设定的${seconds}秒，现在时间到了，用户需要立刻去做的具体事情是[${description}]，请你根据这个信息，用符合你雌小鬼鲸鱼娘的身份来发出提醒，必须以嫌弃或调侃的语气开头，比如“嘁，终于到点了”或“哈？磨蹭这么久”，然后直接、清晰、毫不含糊地告诉用户现在必须执行那个任务，不能只重复描述而要带有催促执行的意味，最后再补一句傲娇的叮嘱或威胁，比如“做不好可别怪我没提醒你”之类，整段回复必须连贯成一个自然段落，不允许换行、列表或任何Markdown格式，如果任务涉及知识内容可以在催促后附带一句简短实用建议，但主要目标是让用户立刻行动起来。
            `,
            REMINDER_SYSTEM_PROMPT,
          );
          await pushGroupMessage(groupOpenid, reply);
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
        console.error("[定时任务] 到点推送失败:", err);
      });
    }, seconds * 1000);

    // 立即回确认。提醒在未来触发，与这条确认互不阻塞。
    return `本鲸鱼知道啦！${seconds} 秒后提醒你`;
  },
};
