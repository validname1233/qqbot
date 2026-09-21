// services/logger.ts —— 全局双维度日志内核（docs/features/2026-09-20-日志体系重构方案.md）。
//
// 两个正交维度：
//   verbosity（详略）  trace（轨迹：节点/命令/工具的进出事件，一行一事）
//                      detail（流水：LLM 输入输出、tool_calls JSON、工具结果等大块原文）
//   severity（要紧）   debug < info < warn < error（语义沿用旧体系，不变）
//
// sink 分发（解耦）：logger 构造 LogEvent 广播给 sink 列表，每个 sink 自己决定
// 收不收、怎么格式化。一期两个内置 sink：
//   console sink：trace + 全部 warn/error；格式 [HH:mm:ss] [level] [module] msg
//                 （与旧版逐字兼容——59 处现有调用零迁移，运维/初始化日志原样）
//   file sink：trace + detail + warn/error 全收；ISO 时间戳，detail 不截断，
//              data/logs/bot-YYYY-MM-DD.log 按天滚动。
//
// API：
//   logger.debug/info/warn/error(module, msg)  旧签名不变 → trace 事件
//   logger.node(module, msg)                   trace 的语义化入口（节点/命令进出）
//   logger.detail(module, msg)                 detail 事件，只进文件
//
// LOG_LEVEL 语义不变（控制台 severity 下限，默认 info）；
// LOG_DETAIL=file|off 控制文件 sink 的 detail 通道（默认 file，回退开关）。

import { appendFile, mkdir, readdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;
export type Verbosity = "trace" | "detail";

interface LogEvent {
  verbosity: Verbosity;
  severity: LogLevel;
  module: string;
  message: string;
  ts: number;
}

// 控制台 severity 下限（LOG_LEVEL，默认 info；非法值回退 info——第二道防线）。
const consoleThreshold =
  config.logLevel in LEVELS ? LEVELS[config.logLevel as LogLevel] : LEVELS.info;

// ---------- console sink：trace + warn/error，旧格式逐字兼容 ----------

function consoleTimestamp(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function consoleSink(event: LogEvent): void {
  // warn/error 走 stderr（pm2/重定向分流），debug/info 走 stdout——与旧版一致。
  const line = `[${consoleTimestamp(new Date(event.ts))}] [${event.severity}] [${event.module}] ${event.message}`;
  if (event.severity === "warn" || event.severity === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}

// ---------- file sink：全量（trace + detail + warn/error），按天滚动 ----------

const LOG_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../data/logs");

// 串行写链：appendFile 异步完成顺序不保证，全部写入排队执行才能保行序
//（browser.ts 的 withPage 同款手法）。进程退出由 flushFileLog() 冲干净在途写。
let writeChain: Promise<void> = Promise.resolve();
let fileSinkBroken = false; // 磁盘满/权限等不可恢复故障后自禁用，防止每行日志都报错刷屏

// 当天文件名缓存：跨天由下一次写入检测并切换（无需定时器）。
let currentDay = "";
let currentPath = "";

function fileTimestamp(ts: number): string {
  // ISO 全量（含日期与时区偏移）——跨天文件里行需要日期自包含。
  return new Date(ts).toLocaleString("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).replace(" ", "T") + "+08:00";
}

function dayStamp(ts: number): string {
  return new Date(ts).toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
}

// 跨天滚动的联动重置：新文件从零积累，引用永远指向当天文件里存在的全文。
// model.ts 的指纹表通过这个回调被清空（函数注册制避免 logger↔model 的循环
// import——logger 被 model 依赖，反向直接 import 会成环）。
let onDayRoll: (() => void) | null = null;
export function setDayRollCallback(cb: () => void): void {
  onDayRoll = cb;
}

function fileSink(event: LogEvent): void {
  if (fileSinkBroken) return;
  // detail 通道受 LOG_DETAIL 开关控制（回退路径：off 后行为回到"只有控制台"）
  if (event.verbosity === "detail" && !config.logDetail) return;

  const day = dayStamp(event.ts);
  if (day !== currentDay) {
    currentDay = day;
    currentPath = join(LOG_DIR, `bot-${day}.log`);
    onDayRoll?.();
  }

  const line = `${fileTimestamp(event.ts)} [${event.severity}] [${event.module}] ${event.message}\n`;
  writeChain = writeChain
    .then(() => appendFile(currentPath, line, "utf8"))
    .then(() => undefined)
    .catch((error: unknown) => {
      // 降级纪律：日志故障绝不能炸主流程。首次失败补建目录重试一次（目录缺失
      // 是最常见的可自愈原因），再失败则自禁用并打一条 console error。
      if (!fileSinkBroken) {
        fileSinkBroken = true;
        console.error(
          `[file-log] 文件日志已禁用（写入失败）：${error instanceof Error ? error.message : error}`,
        );
      }
    });
}

// 首次写日志前确保目录存在（惰性：初始化路径不依赖 data/logs 存在）。
writeChain = writeChain
  .then(() => mkdir(LOG_DIR, { recursive: true }))
  .then(() => undefined);

// 保留策略清理：启动时调用一次，删掉超过 LOG_RETENTION_DAYS 的 bot-*.log。
// 0 = 永久保留。文件名即日期，解析失败/格式不对的文件不动（非本 sink 产物）。
export async function pruneOldLogs(): Promise<void> {
  if (config.logRetentionDays <= 0) return;
  try {
    const files = await readdir(LOG_DIR);
    const cutoff = Date.now() - config.logRetentionDays * 24 * 60 * 60 * 1000;
    for (const name of files) {
      const m = /^bot-(\d{4}-\d{2}-\d{2})\.log$/.exec(name);
      if (m === null) continue;
      if (new Date(`${m[1]}T00:00:00+08:00`).getTime() < cutoff) {
        await unlink(join(LOG_DIR, name));
      }
    }
  } catch {
    // 目录不存在/读取失败：没有旧日志可清，静默（file sink 稍后建目录）
  }
}

// 进程退出钩子用：冲完在途写入再走（pm2 restart 时保住最后几行——最可能丢的
// 恰是崩溃前的现场）。惰性 setTimeout 不拦截正常退出，只挂一次性钩子。
let flushHooked = false;
export async function flushFileLog(): Promise<void> {
  await writeChain;
}
function hookFlush(): void {
  if (flushHooked) return;
  flushHooked = true;
  const flush = (): void => {
    void flushFileLog().finally(() => process.exit(0));
  };
  process.once("SIGINT", flush);
  process.once("SIGTERM", flush); // pm2 restart 发的是 SIGTERM
}

// ---------- 分发 ----------

function emit(verbosity: Verbosity, severity: LogLevel, module: string, message: string): void {
  const event: LogEvent = { verbosity, severity, module, message, ts: Date.now() };
  // console：detail 不进；severity 低于 LOG_LEVEL 的 trace 也不进（保持旧行为）
  if (verbosity === "trace" && LEVELS[severity] >= consoleThreshold) {
    consoleSink(event);
  } else if (severity === "warn" || severity === "error") {
    consoleSink(event); // warn/error 无条件上控制台（detail 级的故障也要可见）
  }
  fileSink(event);
  hookFlush();
}

export const logger = {
  // 旧 API：签名与语义不变 → trace 事件（59 处现有调用零迁移）
  debug: (module: string, message: string): void => emit("trace", "debug", module, message),
  info: (module: string, message: string): void => emit("trace", "info", module, message),
  warn: (module: string, message: string): void => emit("trace", "warn", module, message),
  error: (module: string, message: string): void => emit("trace", "error", module, message),
  // trace 的语义化入口（节点/命令/工具进出专用，= info 的可读性别名）
  node: (module: string, message: string): void => emit("trace", "info", module, message),
  // detail：大块原文（LLM 输入输出/tool_calls/工具结果），只进文件、不截断
  detail: (module: string, message: string): void => emit("detail", "debug", module, message),
};
