// registry.ts —— service 的注册中心 + 消息解析 + 两个 runner（框架代码，放 src 根）。
// handler 只跟这个文件打交道：它不认识任何具体 service，只调 buildContext /
// runCommand / runObservers。加新功能 = 在本文件登记一项，handler 一行都不用改。

import type {
  CommandService,
  MessageContext,
  ObserverService,
} from "./types.js";
import type { BotEvent } from "./events/registry.js";
import type { Effect } from "./machines/types.js";
import { pushC2CMessage, pushGroupMessage } from "./qq/messages.js";
import { reminderService } from "./services/reminder.js";
import { agentService } from "./services/agent.js";
import { scheduledTaskService } from "./services/scheduler/task.js";
import { setPersonalityService } from "./services/prompts/command.js";
import { deepSearchService } from "./services/deep-search.js";
import { knowledgeBaseService } from "./services/knowledge-base.js";
import { helpService } from "./services/help.js";
import { stopService } from "./services/stop.js";
import { memoryLogObserver } from "./services/memory-log.js";
import { logger } from "./services/logger.js";
import { runSession } from "./session/runner.js";

// ---------- 注册表 ----------
// 命令型：关键词 → service。别名也指向同一个 service。
const commands = new Map<string, CommandService>();
function registerCommand(svc: CommandService): void {
  commands.set(svc.name, svc);
  for (const alias of svc.aliases ?? []) {
    commands.set(alias, svc);
  }
}
registerCommand(reminderService);
// Agent 链路必须显式 /Agent 触发——开了"接收所有消息"后，群里不带命令的普通
// 聊天消息也会推事件过来，若仍有兜底 service 会导致机器人对群里所有话搭话。
// 和 /定时任务 等命令的语义保持一致：不点名就不触发。
registerCommand(agentService);
// 通用定时任务：用户存一条提示词，到点跑一次 /Agent 并把结果推回该会话
//（群聊/单聊都支持；取代原"群新闻订阅"——新闻推送现在是一条提示词为
//"搜索今天的XX新闻并播报"的定时任务）。
registerCommand(scheduledTaskService);
// 提示词自定义：按群设置自定义人格（人格+功能分离拼接）。
registerCommand(setPersonalityService);
// 深度检索：独立工作流（Tavily 起点 + 多轮 open_page 深挖 + 汇总报告），
// 与 /Agent 的浅检索互补；慢（几十秒）但深。显式命令触发，设计文档见
// docs/superpowers/specs/2026-08-24-deep-web-browsing-design.md。
registerCommand(deepSearchService);
// 知识库管理：直调端侧 MCP kb_issue_link 返回管理页链接（不经模型，expose 为空）。
// 群一群一库 / 单聊一人一库；实现与设计见 docs/features/2026-09-04-知识库RAG-MCP方案.md。
registerCommand(knowledgeBaseService);
// 命令速查表：读 docs/features 的速查表 md 返回。未知命令的提示语会引导到这里。
registerCommand(helpService);
// 强制中断：拉闸当前会话正在跑的 Agent/深度检索流程（interrupt.ts 注册表）。
registerCommand(stopService);

// 观察型：每条消息都跑一遍的 service 列表。用注册函数而不是硬编码数组，
// 和 registerCommand 保持同一种写法——加新观察者只需在下面补一行 registerObserver。
const observers: ObserverService[] = [];
function registerObserver(svc: ObserverService): void {
  observers.push(svc);
}
registerObserver(memoryLogObserver);

// ---------- 把原始事件规整成统一 context ----------
// 解析规则：内容以 / 开头 → 去掉 /，按第一个空格切成 command + args；
// 否则 command 为 null（走兜底聊天），args 为空。
export function buildContext(event: BotEvent): MessageContext {
  const text = event.content.trim();

  if (!text.startsWith("/")) {
    return { event, text, command: null, args: "" };
  }

  const withoutSlash = text.slice(1);
  const spaceIdx = withoutSlash.indexOf(" ");
  if (spaceIdx === -1) {
    // 只有命令、没有参数。如 "/help"
    return { event, text, command: withoutSlash, args: "" };
  }
  return {
    event,
    text,
    command: withoutSlash.slice(0, spaceIdx),
    args: withoutSlash.slice(spaceIdx + 1).trim(),
  };
}

// ---------- 副作用执行器（状态机 effects 的兑现层） ----------
// 机器按"描述与执行分离"纪律（machines/types.ts）在 Transition 里声明 effects，
// 这里统一执行。每条独立兜错：一个玩家私聊失败（拒收/未加好友 40054013/40054004）
// 只记 warn，不能连累整局——扑克要能容忍个别效果失败继续走。
async function runEffects(effects: readonly Effect[] | undefined): Promise<void> {
  if (effects === undefined) return;
  for (const e of effects) {
    try {
      if (e.kind === "dm") {
        await pushC2CMessage(e.openid, e.text);
      } else {
        await pushGroupMessage(e.groupOpenid, e.text);
      }
    } catch (err) {
      logger.warn(
        "session",
        `effect ${e.kind} 发送失败 (目标 ${e.kind === "dm" ? e.openid.slice(0, 6) : e.groupOpenid.slice(0, 6)}…): ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}

// ---------- 命令路由：二选一 ----------
// 命中命令就跑它，没带命令走兜底，命令不认识给出提示。
// 统一在这里兜错，具体 service 的 handle 不必自己 try/catch。
export async function runCommand(ctx: MessageContext): Promise<string | null> {
  // 先问会话层：若该会话正锁在某状态机里（或这条正是开局命令），由它接管，
  // 直接返回，不再走下面的普通命令路由——这就是「锁在模式里」的短路。
  // 注意：只短路 command 这一路，observers 维度不受影响（handler 里仍并发跑）。
  const session = runSession(ctx);
  if (session.handled) {
    await runEffects(session.effects);
    return session.reply;
  }

  // 没带 / 命令的消息的三个去处：
  //   单聊        → 自动走 /Agent（私密通道，说话即请求）
  //   群里 @bot   → 自动走 /Agent（GROUP_AT_MESSAGE_CREATE 只在用户显式点名时
  //                 触发，@ 就是意图表达，语义同单聊）
  //   群里没 @bot → 不搭话（GROUP_MESSAGE_CREATE 全量推送，普通聊天不插嘴——
  //                 当年删兜底 service 的原因就是它）
  // 纯图片/空文本不进（Agent 对空问题无诉求）；状态机锁定的会话不会走到这里
  //（runSession 在上游已拦截全部消息，passThrough 放行的才会回落到本分支）。
  // 转发用的 ctx 把正文从 text 挪进 args：agentService.handle 以 args 为问题源，
  // 其余字段（event/图片处理）原样复用。
  if (ctx.command === null) {
    const c2c = ctx.event.type === "C2C_MESSAGE_CREATE";
    const groupAt = ctx.event.type === "GROUP_AT_MESSAGE_CREATE";
    if ((c2c || groupAt) && ctx.text.trim() !== "") {
      return agentService.handle({ ...ctx, command: "Agent", args: ctx.text });
    }
    return null;
  }

  const svc = commands.get(ctx.command);
  if (svc === undefined) {
    return `未知命令：/${ctx.command}。发 /help 查看命令速查表～`;
  }
  try {
    return await svc.handle(ctx);
  } catch (err) {
    logger.error("service", `/${ctx.command} 出错: ${err instanceof Error ? err.message : err}`);
    return "这个功能暂时坏了，稍后再试～";
  }
}

// ---------- 观察者：全体各跑一遍 ----------
// 每个观察者独立兜错：一个崩了不能连累其它观察者和命令回复。
// 返回所有"想说话"的观察者产出的文本。observers 为空时自然返回 []。
export async function runObservers(ctx: MessageContext): Promise<string[]> {
  const results = await Promise.all(
    observers.map((o) =>
      o.observe(ctx).catch((err: unknown) => {
        logger.error("service", `观察者「${o.name}」出错: ${err instanceof Error ? err.message : err}`);
        return null;
      }),
    ),
  );
  return results.filter((r): r is string => r !== null && r !== "");
}
