// services/workspace/executor.ts —— 任务容器的生命周期与命令执行（方案 §3.5、决策二/七）。
//
// 执行模型（任务级容器，2026-10-11 决策）：
//   任务开始：docker run -d <全套限制> <镜像> sleep <预算秒数>   ← sleep = 自毁定时器
//   每条命令：docker exec <容器> timeout <单命令超时> bash -lc '<命令>'
//   任务结束：docker kill → 等待容器退出确认 → 释放全局执行闸
//
// 全部经 spawn("docker", [argv])，不经宿主 shell——命令字符串是容器内 bash 的
// 输入，不是宿主的。docker run 默认不透传宿主环境变量（不传 -e/--env-file 即可），
// bot 的 .env 凭证与容器无关。
//
// scheduler（全局执行闸，决策七）：并发 1 的信号量。"杀完才放行"的不变量由
// 这里保证——release 只发生在容器退出确认之后，与租户闸（interrupt.ts）的
// "abort 先删条目"窗口互补。

import { spawn } from "node:child_process";
import { config } from "../../config.js";
import { logger } from "../logger.js";

// ---------- 全局执行闸（决策七：仅此一层，租户互斥复用 interrupt.ts） ----------

let globalBusy = false;

export function tryAcquireExecutionSlot(): boolean {
  if (globalBusy) return false;
  globalBusy = true;
  return true;
}

function releaseExecutionSlot(): void {
  globalBusy = false;
}

// ---------- docker CLI 薄封装 ----------

// 跑一条 docker 命令，收集 stdout/stderr（各自截断），等退出。
// 返回 null = docker 进程本身没跑起来（daemon 不在/命令不存在）——调用方据此
// 给出"环境不可用"的明确错误，而不是让模型对着空输出瞎猜。
interface DockerRunResult {
  code: number;
  stdout: string;
  stderr: string;
  failedToStart: boolean;
}

function runDocker(
  args: string[],
  opts?: { timeoutMs?: number; outputLimit?: number; signal?: AbortSignal },
): Promise<DockerRunResult> {
  return new Promise((resolve) => {
    const limit = opts?.outputLimit ?? config.workspaceOutputLimit;
    const proc = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    // debug：实际下发的 docker argv（短行，进控制台方便实时跟）。带空格的参数
    // 加引号还原成可读命令行——排查"到底给 docker 传了什么"的第一现场。
    if (config.logLevel === "debug") {
      logger.debug(
        "workspace",
        `docker ${args.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")}`,
      );
    }
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;

    const finish = (code: number, failedToStart: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, failedToStart });
    };

    // 流式截断：超限即停读（kill 输出管道），置截断标记——不是攒完再切。
    proc.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length >= limit) {
        stdoutTruncated = true;
        return;
      }
      stdout += chunk.toString("utf8");
      if (stdout.length > limit) {
        stdout = stdout.slice(0, limit);
        stdoutTruncated = true;
      }
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length >= limit) {
        stderrTruncated = true;
        return;
      }
      stderr += chunk.toString("utf8");
      if (stderr.length > limit) {
        stderr = stderr.slice(0, limit);
        stderrTruncated = true;
      }
    });

    proc.on("error", () => finish(-1, true)); // ENOENT 等：docker 都没启动
    proc.on("close", (code) => {
      if (stdoutTruncated) stdout += "\n[stdout 已截断]";
      if (stderrTruncated) stderr += "\n[stderr 已截断]";
      finish(code ?? -1, false);
    });

    const timer = setTimeout(() => {
      proc.kill("SIGKILL"); // 兜底：docker CLI 自身卡死（正常路径靠容器内 timeout）
      stderr += "\n[docker 命令超时被宿主强杀]";
      finish(-1, false);
    }, opts?.timeoutMs ?? config.workspaceCmdTimeoutMs + 30_000);

    // abort：外部信号（/stop）→ 直接杀 docker CLI 进程；容器侧由任务级 kill 负责
    opts?.signal?.addEventListener(
      "abort",
      () => {
        proc.kill("SIGKILL");
      },
      { once: true },
    );
  });
}

// ---------- 任务容器生命周期 ----------

export class ExecutorError extends Error {}

// 容器名：带随机 runId，可精确 kill；qqbot-exec- 前缀供启动 prune 识别孤儿。
function containerName(): string {
  const runId = Math.random().toString(36).slice(2, 10);
  return `qqbot-exec-${runId}`;
}

// 任务开始：创建容器。前置检查（镜像在位/daemon 存活）由 run 阶段的输出兜住
// ——docker run 失败的 stderr（No such image / Cannot connect）直接抛给调用方。
export async function startTaskContainer(
  workspaceDir: string,
  signal?: AbortSignal,
): Promise<{ container: string; kill: () => Promise<void> }> {
  const container = containerName();
  const budgetSeconds = Math.ceil(config.workspaceBudgetMs / 1000) + 30; // 预算+30s 缓冲
  const args = [
    "run", "-d",
    "--name", container,
    "--network", "none",
    "--memory", config.workspaceMemory,
    "--memory-swap", config.workspaceMemory,
    "--cpus", config.workspaceCpus,
    "--pids-limit", String(config.workspacePidsLimit),
    "--user", "1000:1000",
    "--read-only",
    "--tmpfs", "/tmp:rw,size=16m,noexec",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--log-driver", "none",
    "-v", `${workspaceDir}:/workspace`,
    "-w", "/workspace",
    config.workspaceImage,
    "sleep", String(budgetSeconds),
  ];
  const result = await runDocker(args, { signal });
  if (result.failedToStart) {
    throw new ExecutorError("docker 命令不可用（daemon 未启动或未安装？）");
  }
  if (result.code !== 0) {
    throw new ExecutorError(`任务容器创建失败：${result.stderr.trim().slice(0, 200)}`);
  }
  logger.info("workspace", `任务容器已创建 ${container}（镜像 ${config.workspaceImage}）`);

  // kill：结束容器并等待退出确认（docker rm 移除记录；容器可能已自然退出，
  // rm 仍能清掉已停止的容器记录）。resolve 即"容器确已回收"。
  const kill = async (): Promise<void> => {
    const killResult = await runDocker(["rm", "-f", container], { timeoutMs: 30_000 });
    if (killResult.failedToStart) {
      logger.warn("workspace", `容器 ${container} 清理命令失败（docker 不可用）`);
      return;
    }
    logger.info("workspace", `任务容器 ${container} 已销毁（退出码 ${killResult.code}）`);
  };

  return { container, kill };
}

// 每条命令：docker exec <容器> timeout N bash -lc '<命令>'。
// 单命令超时由容器内 timeout 自杀（docker exec 无单独 kill API 的标准解法），
// exit code 124 = timeout 掐的——错误信息里翻译成人话让模型知道是超时不是崩溃。
export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export async function execInContainer(
  container: string,
  command: string,
  signal?: AbortSignal,
): Promise<ExecResult> {
  const args = [
    "exec", container,
    "timeout", String(Math.ceil(config.workspaceCmdTimeoutMs / 1000)),
    "bash", "-lc", command,
  ];
  const t0 = Date.now();
  const result = await runDocker(args, { signal });
  if (result.failedToStart) {
    throw new ExecutorError("docker 命令不可用（daemon 未启动或未安装？）");
  }
  const durationMs = Date.now() - t0;
  if (result.code === 124) {
    result.stderr += `\n[命令超时（>${Math.ceil(config.workspaceCmdTimeoutMs / 1000)}s）被强制终止]`;
  }
  return { exitCode: result.code, stdout: result.stdout, stderr: result.stderr, durationMs };
}

// 孤儿兜底（决策二）：bot 启动时清掉所有 qqbot-exec- 前缀容器。全局并发 1 保证
// 启动时不存在"合法在跑"的任务容器——它们随旧进程死了，前缀匹配到的必是遗留。
// 失败只记 warn：docker 不可用不该阻止 bot 启动（workspace 功能入口自会报错）。
export async function pruneOrphanContainers(): Promise<void> {
  const list = await runDocker(
    ["ps", "-aq", "--filter", "name=qqbot-exec-"],
    { timeoutMs: 30_000, outputLimit: 64 * 1024 },
  );
  if (list.failedToStart || list.code !== 0 || list.stdout.trim() === "") {
    if (!list.failedToStart && list.code !== 0) {
      logger.warn("workspace", `孤儿容器列举失败：${list.stderr.trim().slice(0, 120)}`);
    }
    return;
  }
  const ids = list.stdout.trim().split("\n").map((s) => s.trim()).filter((s) => s !== "");
  if (ids.length === 0) return;
  const rm = await runDocker(["rm", "-f", ...ids], { timeoutMs: 60_000, outputLimit: 16 * 1024 });
  logger.info("workspace", `启动清理：移除 ${ids.length} 个遗留任务容器（退出码 ${rm.code}）`);
}

export { releaseExecutionSlot };
