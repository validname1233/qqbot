// services/scheduler/task.ts —— 命令型 service：通用定时任务的增删查入口。
// 用法：
//   /任务 添加 9:00 帮我搜今天的科技新闻并播报     每天 9:00 跑一次 /Agent 并推回
//   /任务 列表                                     查看本会话的全部任务
//   /任务 删除 2                                   按列表序号删除
// 别名 /定时提问。与 /定时任务（reminder，一次性倒计时提醒）的分工：
//   reminder = "N 秒后提醒我一句话"（轻量，不跑 Agent）；
//   本命令 = "每天固定时刻跑一次 /Agent"（重量，报告落记忆、进度推送生效）。

import type { CommandService, MessageContext } from "../../types.js";
// 任务归属键用 memoryKey（会话粒度：group:<纯群openid> / c2c:<userOpenid>），
// 不用 sessionKey（人粒度：群聊是 group:<群id>:<作者id> 三段）——cron.ts 要从
// 这个键反解出投递目标的 openid，两段式才无歧义；三段式的作者段会被当进
// openid 发给 API（实机 11300 事故的根因）。语义也更贴：任务推给整个会话，
// 归属就是会话——群成员都能列出/删除本群任务，与 /set_personality 同粒度。
import { memoryKey } from "../../agent/context.js";
import { addTask, listTasks, removeTask, type ScheduledTask } from "./store.js";
import { registerCronForTask, unregisterCron } from "./cron.js";

const USAGE = "用法：/任务 添加 H:MM 提示词 | 列表 | 删除 序号\n例：/任务 添加 9:00 搜今天的科技新闻并播报";

// 解析 "9:00" / "09:30"，越界返回 null（照抄原 news/subscription.ts 的实现）。
function parseTime(text: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{1,2})$/.exec(text.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

// 每会话任务数上限：cron 表面积防膨胀（个人 bot，20 条绰绰有余）。
const MAX_TASKS_PER_SESSION = 20;

function formatTaskList(tasks: ScheduledTask[]): string {
  if (tasks.length === 0) return "这个会话还没有定时任务哦～用 /任务 添加 H:MM 提示词 来建一个";
  const lines = tasks.map(
    (t, i) =>
      `${i + 1}. 每天 ${t.hour}:${String(t.minute).padStart(2, "0")} —— ${t.prompt.slice(0, 40)}${t.prompt.length > 40 ? "…" : ""}`,
  );
  return `本会话的定时任务（共 ${tasks.length} 条）：\n${lines.join("\n")}`;
}

export const scheduledTaskService: CommandService = {
  name: "任务",
  aliases: ["定时提问"],

  async handle(ctx: MessageContext): Promise<string | null> {
    const key = memoryKey(ctx.event);
    const trimmed = ctx.args.trim();
    const spaceIdx = trimmed.indexOf(" ");
    const subCommand = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
    const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

    if (subCommand === "添加" || subCommand === "新增") {
      // 再切一刀：时间是第一个词，其后整段是提示词
      const timeEnd = rest.indexOf(" ");
      if (timeEnd === -1) {
        return "格式：/任务 添加 H:MM 提示词，比如 /任务 添加 9:00 搜今天的科技新闻并播报";
      }
      const time = parseTime(rest.slice(0, timeEnd));
      if (time === null) {
        return "时间格式不对哦，要写成 H:MM，比如 /任务 添加 9:00 提示词";
      }
      const prompt = rest.slice(timeEnd + 1).trim();
      if (prompt === "") {
        return "提示词不能为空哦，到点要跑的 /Agent 内容写全～";
      }
      if (listTasks(key).length >= MAX_TASKS_PER_SESSION) {
        return `这个会话的任务已达上限（${MAX_TASKS_PER_SESSION} 条），先 /任务 删除 几条再加吧～`;
      }
      const task = addTask(key, time.hour, time.minute, prompt);
      registerCronForTask(task);
      return `记下了！每天 ${time.hour}:${String(time.minute).padStart(2, "0")} 会跑一次这个任务并把结果发回来～（任务 #${task.id}）`;
    }

    if (subCommand === "列表" || subCommand === "查看") {
      return formatTaskList(listTasks(key));
    }

    if (subCommand === "删除" || subCommand === "移除") {
      const idx = Number(rest);
      if (!Number.isInteger(idx) || idx < 1) {
        return "格式：/任务 删除 序号（序号看 /任务 列表）";
      }
      const tasks = listTasks(key);
      if (idx > tasks.length) {
        return `没有第 ${idx} 条任务哦，序号看 /任务 列表（共 ${tasks.length} 条）`;
      }
      const victim = tasks[idx - 1];
      if (removeTask(key, victim.id)) {
        unregisterCron(victim.id);
        return `删掉啦：每天 ${victim.hour}:${String(victim.minute).padStart(2, "0")} 的「${victim.prompt.slice(0, 20)}…」`;
      }
      return "删除失败，稍后再试一下～";
    }

    return USAGE;
  },
};
