// services/logger.ts —— 统一日志出口：级别开关 + 三段前缀（时间/级别/模块）。
//
// 用法：import { logger } from "../services/logger.js";
//       logger.info("vision", `图像理解完成 (+${elapsed}ms)`);
// 输出：[14:32:05] [info] [vision] 图像理解完成 (+2300ms)
//
// 级别从低到高：debug < info < warn < error。LOG_LEVEL 环境变量控制下限，
// 低于它的调用是 no-op（不格式化字符串、不打印）：
//   LOG_LEVEL=debug  全量（含 model.ts 的每次 LLM 调用明细）
//   LOG_LEVEL=info   默认。关键路径节点（启动、事件到达、图片入库、清理）
//   LOG_LEVEL=warn   只看降级（图片下载失败等）和故障
//   LOG_LEVEL=error  只看故障
//
// 刻意不做的：文件写入（pm2 自带日志管理）、JSON 结构化（消费方式是人眼+grep）、
// 按模块过滤（30 条日志的量级是伪需求，将来真有需要再加一个模块白名单判断）。
//
// 级别语义约定（与既有代码的事实用法一致，本次迁移不改语义）：
//   error  需要人介入的故障
//   warn   单点降级但主流程继续
//   info   一轮交互最多出现一两次的节点事件（含 [events] 心跳——单进程长驻服务，
//          心跳可见性优先于安静）
//   debug  每条消息都会打的高频明细（LLM 请求/返回、耗时分解）

import { config } from "../config.js";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;

// 当前级别下限。config 读了环境变量（默认 info）；拼错或没填都落回 info——
// config.ts 的 optionalEnv 只保证非空字符串，这里的合法性校验是第二道防线。
const threshold =
  config.logLevel in LEVELS ? LEVELS[config.logLevel as LogLevel] : LEVELS.info;

// 时间戳取本地时区的 HH:mm:ss。日志是给人看/grep 的，毫秒和时区偏移都是噪音。
function timestamp(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

function emit(level: LogLevel, module: string, message: string): void {
  if (LEVELS[level] < threshold) return;
  const line = `[${timestamp()}] [${level}] [${module}] ${message}`;
  // 级别路由：warn/error 走 stderr（pm2 / 重定向时可与正常输出分流），
  // debug/info 走 stdout。
  if (level === "warn" || level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  debug: (module: string, message: string): void => emit("debug", module, message),
  info: (module: string, message: string): void => emit("info", module, message),
  warn: (module: string, message: string): void => emit("warn", module, message),
  error: (module: string, message: string): void => emit("error", module, message),
};
