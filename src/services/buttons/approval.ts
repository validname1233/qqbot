// services/buttons/approval.ts —— Agent 风险操作审批（human-in-the-loop）。
// 方案：docs/features/2026-11-18-Agent-human-in-the-loop实现方案.md。
//
// 机制核心：风险点 await requestApproval(...) 挂起（Promise 闸），经 QQ 回调
// 按钮征求许可；用户点击（独立的 INTERACTION_CREATE 事件）→ 本模块注册的
// "approval" 处理器查 pending Map → resolve → 挂起点醒来。拒绝/超时/熔断都
// 以工具文本回流（loop 零改动）。
//
// 任务级授权（§3.6）：用户点"本任务内均允许"后，同任务同类风险点短路放行。
// ★ 实现修正（2026-11-18，替代方案原文的 flowKey 锚定）：flowKey 字符串在
// 同一会话的先后两个任务间相同（group:xxx），仅靠它锚定会让上个任务的授权
// 泄漏进下个任务（正常结束无 abort 信号、时效兜底存在窗口）。改用
// **AbortSignal 对象身份**做任务实例锁：beginControlledFlow 每次任务新建
// controller，signal 即任务实例的唯一令牌——查询时 currentFlowSignal(flowKey)
// 与存储的 signal 不是同一对象 ⇒ 已是新任务 ⇒ 缓存作废。正确性不再依赖
// 时效兜底（时效降为防御性双保险）。
//
// 熔断（§3.5）：同任务同类被拒 ≥2 次 → "breaker"（不发询问直接拒，工具层
// 给出换路提示）。拒绝刻意不做任务级（不对称原则，见方案）。

import { randomBytes } from "node:crypto";
import type { MessageContext } from "../../types.js";
import { config } from "../../config.js";
import { tenantKey } from "../../session/key.js";
import { currentFlowSignal } from "../../session/interrupt.js";
import { callbackButton, keyboardOf } from "../../qq/keyboard.js";
import {
  pushC2CMarkdownWithKeyboard,
  pushC2CMessage,
  pushGroupMarkdownWithKeyboard,
  pushGroupMessage,
} from "../../qq/messages.js";
import { registerButtonHandler, type ButtonInteraction } from "../../qq/button-registry.js";
import { logger } from "../logger.js";

// ---------- 类型 ----------

export type ApprovalDecision = "allow" | "deny" | "breaker";
// breaker 单列（方案接口草图是两值，§3.5 的熔断文案需要可区分的第三值）：
// 工具层据此返回"已被多次拒绝，请与用户确认方案"，与普通拒绝的文案分开。

export interface ApprovalRequest {
  kind: string; // 风险类别（授权缓存键的一部分），如 "workspace-exec"
  title: string; // 询问消息标题
  detail: string; // 风险内容全文（命令原文等）
  ttlMs?: number; // 覆盖默认 TTL
}

interface PendingApproval {
  resolve: (d: ApprovalDecision) => void;
  timer: NodeJS.Timeout;
  onAbort: () => void;
  signal: AbortSignal | undefined; // 任务实例令牌 + 拉闸监听
  flowKey: string;
  approvers: string[]; // 验权快照（openid 名单；空 = 无人可批，fail-closed）
  target: { scene: "group" | "c2c"; id: string }; // 通知去向
  kind: string;
  createdAt: number;
}

const pending = new Map<string, PendingApproval>();

// 任务级授权缓存：key = `${flowKey}|${kind}`；value 的 signal 是任务实例令牌。
const grantedFlows = new Map<string, { signal: AbortSignal | undefined; at: number }>();
// 熔断计数：key = flowKey；signal 同为任务实例令牌。
const denyCounts = new Map<string, { signal: AbortSignal | undefined; count: number }>();

const BREAKER_THRESHOLD = 2;
// 授权时效兜底（信号身份是主正确性来源，这只是防御性双保险）：任务预算 + 5 分钟。
const GRANT_STALE_MS = () => config.workspaceBudgetMs + 5 * 60_000;

// ---------- 发送/通知 transport（可测试性注入点） ----------

interface Target {
  scene: "group" | "c2c";
  id: string;
}

interface ApprovalTransport {
  ask(target: Target, markdown: string, keyboard: unknown): Promise<void>;
  notify(target: Target, text: string): Promise<void>;
}

const defaultTransport: ApprovalTransport = {
  async ask(target, markdown, keyboard) {
    // 询问消息落 chat_bot 行（默认转录）——bot 确实说过这句话（方案 §8.2）。
    if (target.scene === "group") {
      await pushGroupMarkdownWithKeyboard(target.id, markdown, keyboard as never);
    } else {
      await pushC2CMarkdownWithKeyboard(target.id, markdown, keyboard as never);
    }
  },
  async notify(target, text) {
    // 结果通知是瞬时状态，不转录（与 progress-bus 同语义，方案 §8.2）。
    if (target.scene === "group") {
      await pushGroupMessage(target.id, text, { record: false });
    } else {
      await pushC2CMessage(target.id, text, { record: false });
    }
  },
};

let transport: ApprovalTransport = defaultTransport;

/** 仅测试用：替换发送通道（生产代码不得调用）。 */
export function __setTransportForTest(t: ApprovalTransport): void {
  transport = t;
}

// ---------- 任务级授权 / 熔断（signal 身份锁） ----------

function taskSignal(flowKey: string): AbortSignal | undefined {
  return currentFlowSignal(flowKey);
}

function isFlowGranted(flowKey: string, kind: string): boolean {
  const key = `${flowKey}|${kind}`;
  const entry = grantedFlows.get(key);
  if (entry === undefined) return false;
  const current = taskSignal(flowKey);
  if (entry.signal !== current || Date.now() - entry.at > GRANT_STALE_MS()) {
    grantedFlows.delete(key); // 已是新任务（或超龄）——缓存作废
    return false;
  }
  return true;
}

function grantFlow(flowKey: string, kind: string): void {
  grantedFlows.set(`${flowKey}|${kind}`, { signal: taskSignal(flowKey), at: Date.now() });
}

function denyCountOf(flowKey: string): number {
  const entry = denyCounts.get(flowKey);
  if (entry === undefined) return 0;
  if (entry.signal !== taskSignal(flowKey)) {
    denyCounts.delete(flowKey); // 新任务：计数归零
    return 0;
  }
  return entry.count;
}

function recordDeny(flowKey: string): void {
  const current = taskSignal(flowKey);
  const entry = denyCounts.get(flowKey);
  denyCounts.set(flowKey, {
    signal: current,
    count: entry !== undefined && entry.signal === current ? entry.count + 1 : 1,
  });
}

// 任务拉闸时清空该 flow 的授权与计数（abort listener 调用；重复调用无害）。
function clearFlowState(flowKey: string): void {
  for (const key of grantedFlows.keys()) {
    if (key.startsWith(`${flowKey}|`)) grantedFlows.delete(key);
  }
  denyCounts.delete(flowKey);
}

// ---------- 验权快照（方案 §5.1） ----------

// 群聊：发起人是管理员/群主 → 名单=[发起人 openid]；否则空（QQ 不给管理员
// 枚举，fail-closed：无人可批，TTL 自动拒绝）。单聊：[发起人]（消息只到
// 本人，点按钮的必是本人）。
function approversOf(ctx: MessageContext): string[] {
  const event = ctx.event;
  if (event.type === "C2C_MESSAGE_CREATE") return [event.authorOpenid];
  if (event.authorRole === "admin" || event.authorRole === "owner") return [event.authorOpenid];
  return [];
}

// ---------- 询问消息 ----------

function buildAskMessage(req: ApprovalRequest, id: string): { markdown: string; keyboard: unknown } {
  const keyboard = keyboardOf([
    [
      callbackButton(`ap_once_${id}`, "允许一次", `approval:allow-once:${id}`, { type: 2 }),
      callbackButton(`ap_task_${id}`, "本任务内均允许", `approval:allow-task:${id}`, { type: 2 }),
      callbackButton(`ap_deny_${id}`, "拒绝", `approval:deny:${id}`, { type: 2 }),
    ],
  ]);
  const ttlMin = Math.round((req.ttlMs ?? config.approvalTtlMs) / 60_000);
  const markdown = [
    `**${req.title}**`,
    "```",
    req.detail.slice(0, 800),
    "```",
    `类别：\`${req.kind}\`｜点「本任务内均允许」后，本任务内的同类操作将不再逐条询问`,
    `（${ttlMin} 分钟内未处理将自动拒绝）`,
  ].join("\n");
  return { markdown, keyboard };
}

// ---------- 幂等结案（竞态唯一出口） ----------

function conclude(id: string, decision: "allow" | "deny", notifyText?: string): void {
  const entry = pending.get(id);
  if (entry === undefined) return; // 点击 vs TTL vs 拉闸竞态：先到先得，后到吞掉
  pending.delete(id); // 先删再 resolve——二次点击自然落"已处理"
  clearTimeout(entry.timer);
  if (entry.signal !== undefined) entry.signal.removeEventListener("abort", entry.onAbort);
  entry.resolve(decision);
  if (notifyText !== undefined) {
    void transport.notify(entry.target, notifyText).catch((err: unknown) => {
      logger.warn("approval", `结果通知发送失败：${err instanceof Error ? err.message : err}`);
    });
  }
}

// ---------- 对外入口：风险点唯一调用 ----------

export async function requestApproval(ctx: MessageContext, req: ApprovalRequest): Promise<ApprovalDecision> {
  // 总开关（§5.4）：off = 功能关闭，直接放行（行为与引入前一致）。
  if (config.approvalMode === "off") return "allow";

  const flowKey = tenantKey(ctx.event);

  // 熔断短路：同任务同类已被拒够多次——不再打扰用户，工具层给换路提示。
  if (denyCountOf(flowKey) >= BREAKER_THRESHOLD) {
    logger.warn("approval", `熔断触发（flow=${flowKey.slice(0, 12)}… kind=${req.kind}）`);
    return "breaker";
  }

  // 任务级授权短路（§3.6）：本任务本类别已授权 → 零交互放行。
  if (isFlowGranted(flowKey, req.kind)) return "allow";

  // 发询问消息（失败 = 本次审批失败，异常上抛给工具层——2026-11-10 决议：
  // 无文本兜底路线；工具 catch 后回流"审批消息发送失败"）。
  const id = randomBytes(8).toString("hex");
  const { markdown, keyboard } = buildAskMessage(req, id);
  const target: Target =
    ctx.event.type === "C2C_MESSAGE_CREATE"
      ? { scene: "c2c", id: ctx.event.authorOpenid }
      : { scene: "group", id: ctx.event.groupOpenid };
  await transport.ask(target, markdown, keyboard);

  const signal = taskSignal(flowKey);
  logger.node("approval", `发起审批 id=${id} kind=${req.kind} flow=${flowKey.slice(0, 12)}…`);

  // 挂起：存钥匙 + TTL 定时器 + 拉闸监听。
  return new Promise<ApprovalDecision>((resolve) => {
    const onAbort = (): void => {
      conclude(id, "deny");
      clearFlowState(flowKey); // 流程已死：授权与熔断计数一并作废
    };
    const timer = setTimeout(() => {
      conclude(id, "deny");
      recordDeny(flowKey); // 超时也计熔断（连续超时 = 没人在场，别反复问）
    }, req.ttlMs ?? config.approvalTtlMs);
    if (signal !== undefined) signal.addEventListener("abort", onAbort, { once: true });
    pending.set(id, {
      resolve,
      timer,
      onAbort,
      signal,
      flowKey,
      approvers: approversOf(ctx),
      target,
      kind: req.kind,
      createdAt: Date.now(),
    });
  });
}

// ---------- 点击处理器（"approval" 命名空间） ----------

async function handleApprovalClick(interaction: ButtonInteraction): Promise<boolean> {
  // payload 到手时形如 "allow-once:<id>"（管道的 toButtonInteraction 已剥掉
  // 命名空间前缀）。防御：若拿到未剥的完整串（"approval:allow-once:<id>"，
  // 跳过管道直调的调用方），先剥掉 ns 前缀再切。
  let rest = interaction.payload;
  if (rest.startsWith("approval:")) rest = rest.slice("approval:".length);
  const sep = rest.indexOf(":");
  if (sep <= 0) return true; // 坏格式：管道已记 warn，这里吞掉
  const action = rest.slice(0, sep);
  const id = rest.slice(sep + 1);
  const entry = pending.get(id);

  if (entry === undefined) {
    // 已决/过期/已作废——静默丢弃（2026-11-18 决议：重复点击不推送提示，
    // 按钮的 loading 已由管道层的平台回应终结，用户无感知负担）。
    logger.info("approval", `点击已失效审批（id=${id.slice(0, 8)}…，who=${interaction.userOpenid.slice(0, 6)}…）`);
    return true;
  }

  // 验权快照（§5.1）：单聊免验（scene=c2c 时点击者必是本人）；群聊比对名单。
  if (entry.target.scene === "group" && !entry.approvers.includes(interaction.userOpenid)) {
    await transport
      .notify({ scene: "group", id: entry.target.id }, "仅发起本任务的管理员可操作该审批")
      .catch(() => undefined);
    return true;
  }

  switch (action) {
    case "deny":
      recordDeny(entry.flowKey);
      conclude(id, "deny", "已拒绝，Agent 将调整方案或结束任务");
      return true;
    case "allow-task":
      grantFlow(entry.flowKey, entry.kind);
      conclude(id, "allow", "已允许（本任务内同类操作不再询问）");
      return true;
    case "allow-once":
      conclude(id, "allow", "已允许");
      return true;
    default:
      return true; // 未知 action：吞掉（管道已记 warn）
  }
}

// 启动期注册（webhook.ts 调用）。
export function initializeApproval(): void {
  registerButtonHandler("approval", { handle: handleApprovalClick });
}
