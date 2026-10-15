// services/workspace/run-task.ts —— 工作台任务的统一入口（决策八：两种模式收敛于此）。
//
//   委派模式（主 Agent 的 workspace_task 工具）：主流程已持闸（runAgentTurn 开头
//     beginControlledFlow）——这里【不登记】（同 key 嵌套登记返回 null 会把自己拒了），
//     经 currentFlowSignal 反查父流程 signal 挂进子图，/stop 拉主流程闸即传导。
//   独立模式（/代码 命令）：opts.ownFlow = true——自己登记（与 /Agent、深检同款），
//     finally 里注销。
//
// 共同路径：全局执行闸（并发 1，决策七）→ 容器创建 → 子图循环（容器句柄经
// exec.ts 的 setCurrentContainer 注入）→ docker kill + 确认退出 → 释放全局闸。
// "杀完才放行"的不变量：全局闸的释放只发生在 kill() resolve 之后。

import type { MessageContext } from "../../types.js";
import { beginControlledFlow, endControlledFlow, currentFlowSignal } from "../../session/interrupt.js";
import { tenantKey } from "../../session/key.js";
import { config } from "../../config.js";
import { logger } from "../logger.js";
import { subscribeProgress } from "../progress-bus.js";
import {
  tryAcquireExecutionSlot,
  releaseExecutionSlot,
  startTaskContainer,
  pruneOrphanContainers,
  ExecutorError,
} from "./executor.js";
import { setCurrentContainer } from "../../agent/code-workspace/tools/exec.js";
import { runWorkspaceGraph } from "../../agent/code-workspace.js";
import { emitProgress } from "../progress-bus.js";
import { workspaceDirFor } from "./paths.js";

export interface RunTaskOptions {
  // true = 独立模式（/代码）：自己登记流程闸；false/缺省 = 委派模式：继承父 signal。
  ownFlow?: boolean;
  // 外部指定 signal（测试用；正常路径两条模式都不需要——委派从注册表反查，
  // 独立自己 create）。给了就优先于反查。
  signal?: AbortSignal;
}

export async function runWorkspaceTask(
  task: string,
  ctx: MessageContext,
  opts: RunTaskOptions = {},
): Promise<string> {
  if (!config.workspaceEnabled) {
    return "工作台功能未开启（WORKSPACE_ENABLED!=true），这次任务没有执行。";
  }
  const flowKey = tenantKey(ctx.event);

  // ---- 独立模式的闸登记（委派模式跳过——父流程已持闸） ----
  let controller: AbortController | null = null;
  if (opts.ownFlow === true) {
    controller = beginControlledFlow(flowKey);
    if (controller === null) {
      return "上一个任务还在跑哦～先发 /stop 停掉它，再重新发起吧。";
    }
  }
  const signal = opts.signal ?? controller?.signal ?? currentFlowSignal(flowKey);

  // ---- 全局执行闸（决策七：并发 1，跨两种模式统一生效） ----
  if (!tryAcquireExecutionSlot()) {
    if (controller !== null) endControlledFlow(flowKey, controller);
    return "现在有另一个工作台任务正在执行（服务器一次只跑一个），稍等一会儿再试～";
  }

  const startedAt = Date.now();
  const taskPreview = task.slice(0, 40) + (task.length > 40 ? "…" : "");
  logger.node("workspace", `[工作台] 任务开始：${taskPreview}`);
  emitProgress(ctx.event, "工作台任务开始：正在准备执行环境…");

  let containerKiller: (() => Promise<void>) | null = null;
  try {
    // ---- 容器创建（workspace 惰性目录 → 挂载） ----
    const dir = workspaceDirFor(ctx.event);
    const { container, kill } = await startTaskContainer(dir, signal);
    containerKiller = kill;
    setCurrentContainer(container);

    // ---- 子图循环 ----
    const unsubscribeProgress = subscribeProgress(ctx.event);
    try {
      const report = await runWorkspaceGraph(task, ctx, Date.now() + config.workspaceBudgetMs, signal);
      const aborted = signal?.aborted === true;
      if (aborted) {
        logger.node("workspace", `[工作台] 任务被中止 (+${((Date.now() - startedAt) / 1000).toFixed(1)}s)`);
        return ""; // 被停的任务不发报告（与主 Agent 的中断静默语义一致）
      }
      logger.node("workspace", `[工作台] 任务完成 → 报告 ${report.length} 字 (+${((Date.now() - startedAt) / 1000).toFixed(1)}s)`);
      return report;
    } finally {
      unsubscribeProgress();
    }
  } catch (err) {
    if (signal?.aborted === true) return ""; // 中断路径的异常静默
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("workspace", `[工作台] 任务失败：${msg}`);
    if (err instanceof ExecutorError) {
      return `工作台执行环境不可用：${msg}。这次任务没有执行，请检查服务器 Docker 配置。`;
    }
    return `工作台任务执行失败：${msg}`;
  } finally {
    // ---- 回收：容器 kill + 确认退出 → 才释放全局闸（杀完才放行） ----
    setCurrentContainer(null);
    if (containerKiller !== null) {
      try {
        await containerKiller();
      } catch (err) {
        logger.warn("workspace", `容器清理异常：${err instanceof Error ? err.message : String(err)}`);
      }
    }
    releaseExecutionSlot();
    if (controller !== null) endControlledFlow(flowKey, controller);
  }
}

// bot 启动时的孤儿容器清扫（webhook.ts 调；决策二的兜底）。
export async function initializeWorkspace(): Promise<void> {
  if (!config.workspaceEnabled) return;
  try {
    await pruneOrphanContainers();
  } catch (err) {
    logger.warn("workspace", `启动清扫失败（不阻塞启动）：${err instanceof Error ? err.message : String(err)}`);
  }
}
