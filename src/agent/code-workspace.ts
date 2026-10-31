// agent/code-workspace.ts —— 工作台子 Agent 的 LangGraph 图。
// 结构照深检/主图骨架裁剪：prepareContext → llm ⇄ tools 循环 → finalize。
// 与主 Agent 图（loop.ts）的关键差异：
//   - 轮次上限 12（写代码任务要"写→跑→看报错→改→再跑"的多轮循环）；
//   - 工具串行执行（写→跑有顺序依赖，不 Promise.all）；
//   - 不带聊天记忆/长期记忆——上下文 = 系统提示 + 任务规格书 + 本任务工具轨迹
//     （决策八：状态完全隔离，减小噪声）；
//   - AbortSignal 贯穿（委派模式继承主流程、/代码 模式自己登记的都从入口传入）。

import { StateGraph, StateSchema, ReducedValue, START, END } from "@langchain/langgraph";
import { z } from "zod";
import type { MessageContext } from "../types.js";
import type { ChatMessage } from "./types.js";
import { callModel } from "../services/model.js";
import { runTool, toolSchemas } from "./code-workspace/registry.js";
import { CODE_WORKSPACE_SYSTEM_PROMPT } from "../services/prompts/code-workspace.js";
import { config } from "../config.js";
import { logger } from "../services/logger.js";
import { appendEvent } from "./memory/events.js";
import { tenantKey } from "../session/key.js";
import type { BotEvent } from "../events/registry.js";

// 过程归档（双子 Agent 工具化方案 §2.3，2026-10-31）：子 Agent 中间过程落
// process 行（origin="workspace"），与主链路/深检同构；永不投影（v7），
// 仅排查回放。落库失败不炸图（档案缺行 < 任务中断）。
function archiveWorkspaceProcess(
  event: BotEvent,
  row: { role: "assistant" | "tool"; content: string | null; toolCalls?: ChatMessage["tool_calls"]; toolCallId?: string },
): void {
  try {
    appendEvent({
      key: tenantKey(event),
      kind: "process",
      role: row.role,
      content: row.content,
      toolCalls: row.toolCalls,
      toolCallId: row.toolCallId,
      origin: "workspace",
    });
  } catch (err) {
    logger.warn("workspace", `过程归档失败（忽略）：${err instanceof Error ? err.message : err}`);
  }
}

// messages 用累加式 ReducedValue（与主图同款）；其余字段每次整体覆盖。
// deadline 在入口算好传入；interruptSignal 可选，节点入口检查。
const WorkspaceState = new StateSchema({
  messages: new ReducedValue(z.custom<ChatMessage[]>(), {
    reducer: (current: ChatMessage[], next: ChatMessage[]) => [...current, ...next],
  }),
  task: z.string(),
  ctx: z.custom<MessageContext>(),
  deadline: z.number(),
  turnCount: z.number().default(0),
  report: z.string().nullable().default(null),
  // /stop 的中断信号：runWorkspaceTask 挂进 state（委派模式反查父流程，
  // 独立模式自己 create），llmCall 的模型调用与节点路由都检查它。
  interruptSignal: z.custom<AbortSignal>().nullable().default(null),
});

type WorkspaceStateT = typeof WorkspaceState.State;
type WorkspaceUpdateT = typeof WorkspaceState.Update;

// 节点一：装配初始 messages——系统提示 + 任务规格书（决策八：规格书是子 Agent
// 看到的全部任务信息，主 Agent 的历史/人格一概不带）。
function prepareContext(state: WorkspaceStateT): WorkspaceUpdateT {
  const messages: ChatMessage[] = [
    { role: "system", content: CODE_WORKSPACE_SYSTEM_PROMPT },
    { role: "user", content: state.task },
  ];
  return { messages };
}

// 节点二：带工具调模型。signal 可选链传给 callModel（/stop 时在途请求也被断）。
async function llmCall(state: WorkspaceStateT): Promise<WorkspaceUpdateT> {
  const message = await callModel(
    state.messages,
    toolSchemas(),
    undefined,
    false,
    "workspace",
    state.interruptSignal ?? undefined,
  );
  // 过程归档（双子 Agent 工具化方案 §2.3）：子 Agent 的中间输出落 process 行
  //（origin="workspace"），永不投影（v7），排查回放用。落库失败不炸图。
  archiveWorkspaceProcess(state.ctx.event, {
    role: "assistant",
    content: message.content,
    toolCalls: message.tool_calls,
  });
  return { messages: [message] };
}

// 节点三：串行执行 tool_calls（与主图 Promise.all 的差异是有意的——写→跑的
// 顺序依赖天然成立；JSON 解析失败退 {}，工具自己报"缺少参数"）。
async function toolsNode(state: WorkspaceStateT): Promise<WorkspaceUpdateT> {
  const lastMessage = state.messages[state.messages.length - 1];
  const toolCalls = lastMessage?.tool_calls ?? [];
  const toolMessages: ChatMessage[] = [];
  for (const call of toolCalls) {
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(call.function.arguments) as Record<string, unknown>;
    } catch {
      args = {};
    }
    const result = await runTool(call.function.name, args, state.ctx);
    archiveWorkspaceProcess(state.ctx.event, { role: "tool", content: result, toolCallId: call.id });
    toolMessages.push({ role: "tool", content: result, tool_call_id: call.id });
  }
  return { messages: toolMessages, turnCount: state.turnCount + 1 };
}

// 节点四：收尾。模型输出纯文本（无 tool_calls）时它就是最终报告，原样返回；
// 轮次/预算耗尽被强制收尾时，单独要一次"只交报告"的模型调用（不带 tools，
// 逼模型基于已有轨迹总结——与主图 finalize 同思路但更简单：没有用户历史要拼）。
async function finalizeNode(state: WorkspaceStateT): Promise<WorkspaceUpdateT> {
  const lastMessage = state.messages[state.messages.length - 1];
  if (lastMessage?.role === "assistant" && lastMessage.content !== null && lastMessage.content !== "") {
    return { report: lastMessage.content };
  }
  const forced = await callModel(
    [
      { role: "system", content: CODE_WORKSPACE_SYSTEM_PROMPT },
      ...state.messages.filter((m) => m.role !== "system"),
      {
        role: "user",
        content: "（预算已耗尽，不要再调用工具。基于以上过程立即给出最终报告：结论、产物、未尽事项。）",
      },
    ],
    undefined,
    undefined,
    false,
    "workspace-finalize",
    state.interruptSignal ?? undefined,
  );
  return { report: forced.content ?? "（任务没有产生报告）" };
}

// 路由一：llmCall 之后——无 tool_calls = 模型自认完成 → finalize；
// 有 tool_calls 且轮次/预算还有 → tools；否则也 finalize（强制收尾）。
function afterLlmCall(state: WorkspaceStateT): "tools" | "finalize" {
  if (state.interruptSignal?.aborted) return "finalize";
  const lastMessage = state.messages[state.messages.length - 1];
  const hasToolCalls = lastMessage?.tool_calls !== undefined && lastMessage.tool_calls.length > 0;
  const budgetLeft = state.turnCount < config.workspaceMaxTurns && Date.now() < state.deadline;
  if (hasToolCalls && budgetLeft) return "tools";
  return "finalize";
}

// 路由二：tools 之后——还有预算回 llmCall，没了 finalize。
function afterTools(state: WorkspaceStateT): "llmCall" | "finalize" {
  if (state.interruptSignal?.aborted) return "finalize";
  const budgetLeft = state.turnCount < config.workspaceMaxTurns && Date.now() < state.deadline;
  return budgetLeft ? "llmCall" : "finalize";
}

const workspaceGraph = new StateGraph(WorkspaceState)
  .addNode("prepareContext", prepareContext)
  .addNode("llmCall", llmCall)
  .addNode("tools", toolsNode)
  .addNode("finalize", finalizeNode)
  .addEdge(START, "prepareContext")
  .addEdge("prepareContext", "llmCall")
  .addConditionalEdges("llmCall", afterLlmCall, ["tools", "finalize"])
  .addConditionalEdges("tools", afterTools, ["llmCall", "finalize"])
  .addEdge("finalize", END)
  .compile();

// 图执行入口（run-task.ts 调）：容器生命周期不在这里管——executor 的创建/销毁
// 在 run-task 的 try/finally 里，图只负责决策循环。返回最终报告文本。
export async function runWorkspaceGraph(
  task: string,
  ctx: MessageContext,
  deadline: number,
  signal: AbortSignal | undefined,
): Promise<string> {
  const result = await workspaceGraph.invoke(
    {
      task,
      ctx,
      deadline,
      turnCount: 0,
      interruptSignal: signal ?? null,
    },
    // recursionLimit：默认 25 对工作台不够——写代码任务的"写→跑→看报错→改→
    // 再跑"循环每轮 2 个超步 × WORKSPACE_MAX_TURNS 默认 12 轮 = 24 步，加上
    // prepareContext/finalize 就贴着上限了。60 与另两图统一；真正的轮次约束
    // 由 workspaceMaxTurns 承担。
    { recursionLimit: 60 },
  );
  const report = (result as WorkspaceStateT).report;
  if (report === null || report === "") {
    logger.warn("workspace", "图执行完毕但 report 为空（可能被中断）");
    return "";
  }
  return report;
}
