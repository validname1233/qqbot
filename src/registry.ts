// registry.ts —— service 的注册中心 + 消息解析 + 两个 runner（框架代码，放 src 根）。
// handler 只跟这个文件打交道：它不认识任何具体 service，只调 buildContext /
// runCommand / runObservers。加新功能 = 在本文件登记一项，handler 一行都不用改。

import type {
  CommandService,
  MessageContext,
  ObserverService,
} from "./types.js";
import type { BotEvent } from "./events/registry.js";
import { chatService } from "./services/chat.js";
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
registerCommand(chatService);

// 没带 / 命令时的兜底 service（直接聊天）。
const defaultCommand: CommandService = chatService;

// 观察型：每条消息都跑一遍的 service 列表。
// 目前为空——机制已就位（见 runObservers）。要加"每条消息都要跑"的服务
// （如成就、计数、日志）时，实现一个 ObserverService 并 push 进来即可。
const observers: ObserverService[] = [];

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

// ---------- 命令路由：二选一 ----------
// 命中命令就跑它，没带命令走兜底，命令不认识给出提示。
// 统一在这里兜错，具体 service 的 handle 不必自己 try/catch。
export async function runCommand(ctx: MessageContext): Promise<string | null> {
  // 先问会话层：若该会话正锁在某状态机里（或这条正是开局命令），由它接管，
  // 直接返回，不再走下面的普通命令路由——这就是「锁在模式里」的短路。
  // 注意：只短路 command 这一路，observers 维度不受影响（handler 里仍并发跑）。
  const session = runSession(ctx);
  if (session.handled) {
    return session.reply;
  }

  const svc =
    ctx.command === null ? defaultCommand : commands.get(ctx.command);
  if (svc === undefined) {
    return `未知命令：/${ctx.command}`;
  }
  try {
    return await svc.handle(ctx);
  } catch (err) {
    console.error(`[service:${ctx.command ?? "默认"}] 出错:`, err);
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
        console.error(`[observer:${o.name}] 出错:`, err);
        return null;
      }),
    ),
  );
  return results.filter((r): r is string => r !== null && r !== "");
}
