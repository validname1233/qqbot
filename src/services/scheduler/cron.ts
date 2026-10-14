// services/scheduler/cron.ts —— 把"数据库里的定时任务"转成"实际跑着的 node-cron
// 任务"，两者之间的同步全在这里管（骨架照抄原 news/cron.ts：内存任务表 +
// register/unregister + 启动时从库重建，重启后任务不丢）。
//
// 到点做的事（runScheduledTask）：按 session_key 反解出目标会话，构造一个
// 最小 fake MessageEvent，跑一次完整的 runAgentTurn（进度推送、工具调用、
// 落库全部自动生效——这是"通用定时任务"的核心：cron 触发的不是写死的
// 新闻管线，而是一次货真价实的 /Agent），结果主动推送回该会话。

import cron, { type ScheduledTask as CronTask } from "node-cron";
import type { MessageContext } from "../../types.js";
import { runAgentTurn } from "../../agent/loop.js";
import { pushGroupMessage, pushC2CMessage } from "../../qq/messages.js";
import { listEnabledTasks, type ScheduledTask } from "./store.js";
import { logger } from "../logger.js";

// 活跃 cron 任务表（任务 id -> ScheduledTask）。进程内状态，不落库——
// 重启后靠 initializeScheduler 从数据库重建。
const activeTasks = new Map<number, CronTask>();

// 会话键反解：tenantKey 格式（group:<纯群openid> / c2c:<userOpenid>，恰好两段）。
// 严格按段数校验——多一段（如历史 bug 存进去的人粒度三段键 group:<gid>:<author>）
// 直接返回 null 跳过并告警：坏键可见，比把作者段当 openid 发给 API（11300 事故）
// 强得多。键由 task.ts 经 tenantKey 写入。
function parseSessionKey(
  key: string,
): { type: "group" | "c2c"; openid: string } | null {
  const parts = key.split(":");
  if (parts.length !== 2) return null;
  if (parts[0] === "group") return { type: "group", openid: parts[1] };
  if (parts[0] === "c2c") return { type: "c2c", openid: parts[1] };
  return null;
}

// 构造跑 /Agent 用的最小 fake ctx。runAgentTurn 内部会用到：
//   tenantKey(event)——读群记忆/人格（group:<gid> 正好与真实群聊同键，报告落群记忆），
//   同时也是并发闸 + progress-bus 的键（2026-10-14 键统一后两者同值）；
//   authorOpenid/authorName——记忆写入的发言人（定时任务记为"定时任务"）。
// fake event 的 type 必须与真实事件一致（GROUP_MESSAGE_CREATE / C2C_MESSAGE_CREATE），
// 否则 tenantKey 的群/私聊分支会走错。
function makeFakeContext(task: ScheduledTask): MessageContext | null {
  const target = parseSessionKey(task.sessionKey);
  if (target === null) return null;

  const event =
    target.type === "group"
      ? {
          type: "GROUP_MESSAGE_CREATE" as const,
          groupOpenid: target.openid,
          authorOpenid: "scheduler",
          authorRole: null, // fake 事件无真实发送者；真实事件缺失时也是 null（fail-closed 同路）
          authorName: "定时任务",
          content: "",
          attachments: [],
          msgId: "",
        }
      : {
          type: "C2C_MESSAGE_CREATE" as const,
          authorOpenid: target.openid,
          authorName: "定时任务",
          content: "",
          attachments: [],
          msgId: "",
        };
  return { event, text: task.prompt, command: "Agent", args: task.prompt };
}

// 到点要做的事：跑一次 /Agent → 结果推回会话。报告落库由 runAgentTurn
// 自己做（fake event 的 tenantKey 指向真实会话）——这是刻意保留的副作用：
// 之后 /Agent 能 recall 到"今早推过什么"。
// runAgentTurn 返回的拒绝串（"上一个任务还在跑哦…"）不推送——9 点整恰好
// 有人在该会话跑 /Agent 时静默跳过本轮，比把拒绝语当任务输出发出去体面。
async function runScheduledTask(task: ScheduledTask): Promise<void> {
  const ctx = makeFakeContext(task);
  if (ctx === null) {
    logger.warn("scheduler", `任务 ${task.id} 的会话键无法解析：${task.sessionKey}`);
    return;
  }

  logger.info("scheduler", `任务 ${task.id} 触发（${task.sessionKey} ${task.hour}:${task.minute}）`);
  const reply = await runAgentTurn(task.prompt, ctx);
  if (reply === "" || reply.startsWith("上一个任务还在跑")) {
    logger.info("scheduler", `任务 ${task.id} 跳过（会话忙或无输出）`);
    return;
  }

  const target = parseSessionKey(task.sessionKey);
  if (target?.type === "group") {
    await pushGroupMessage(target.openid, reply);
  } else if (target?.type === "c2c") {
    await pushC2CMessage(target.openid, reply);
  }
}

// 给一条任务建 cron。同 id 先销毁旧的（配置更新时 task.ts 调 removeTaskSync
// 后重挂）。时区写死 Asia/Shanghai，与命令层解析用户输入"9:00"的预期一致。
function registerCron(task: ScheduledTask): void {
  const minute = String(task.minute).padStart(2, "0");
  const hour = String(task.hour).padStart(2, "0");
  const cronTask = cron.schedule(
    `${minute} ${hour} * * *`,
    () => {
      void runScheduledTask(task).catch((err: unknown) => {
        logger.error("scheduler", `任务 ${task.id} 执行失败: ${err instanceof Error ? err.message : err}`);
      });
    },
    { timezone: "Asia/Shanghai" },
  );
  activeTasks.set(task.id, cronTask);
}

export function unregisterCron(taskId: number): void {
  const cronTask = activeTasks.get(taskId);
  if (cronTask) {
    void cronTask.destroy();
    activeTasks.delete(taskId);
  }
}

export function registerCronForTask(task: ScheduledTask): void {
  unregisterCron(task.id);
  if (task.enabled) registerCron(task);
}

// 启动时调用一次（webhook.ts）：把库里 enabled=1 的任务全部挂回 cron。
export function initializeScheduler(): void {
  const tasks = listEnabledTasks();
  for (const task of tasks) {
    registerCron(task);
  }
  logger.info("scheduler", `已恢复 ${tasks.length} 条定时任务`);
}
