// services/trace.ts —— runId 链路追踪（docs/features/2026-11-03-runId链路追踪方案.md）。
// 一次「运行」（一条消息的处理链 / 一次 cron 触发 / 一次提醒触发）从入口处
// startRun 拿一个短 id，沿异步链自动传播（Node 内置 AsyncLocalStorage），
// logger.emit 读 getRunId() 把它写进沿途每一行日志——grep 一个 runId 即可
// 抽出整条轨迹，不要求任何调用方改签名。
//
// 纪律：本模块不 import logger——logger 依赖本模块（emit 调 getRunId），
// 反向引用会成环；「run 开始」锚点日志由各入口自己打（方案 §4.3）。
//
// id 形态：4 字节 hex（8 字符）。不做全局唯一承诺——32 位空间首次碰撞期望
// ≈ 8.2 万次运行，日常量级下可忽略；撞了也只是两条轨迹混在一起（时间与
// 租户可区分），不致错。不要缩成 2 字节：16 位空间约 300 次运行即 50%
// 碰撞，grep 抽轨迹的核心卖点会失效。

import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

const runALS = new AsyncLocalStorage<{ runId: string }>();

const newRunId = (): string => randomBytes(4).toString("hex");

// 入口包装：fn 整条异步链内 getRunId() 可见。嵌套调用拿到的是新 id
// （退出后恢复外层）——一期没有嵌套入口，语义留作机制保证。
export function startRun<T>(fn: () => Promise<T>): Promise<T> {
  const runId = newRunId();
  return runALS.run({ runId }, fn);
}

// logger.emit / 需要显式拿 id 的点调用；链外（启动期、定时器裸回调）返回 null。
export function getRunId(): string | null {
  return runALS.getStore()?.runId ?? null;
}
