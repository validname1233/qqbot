// agent/loop.ts —— agent 的核心流程：LangGraph StateGraph 四节点图
//（v9 直通架构，2026-10-28；方案 docs/features/2026-10-28-记忆与上下文重构
// 总方案.md 模块二 §1.2 v9 决议）：
//   prepareContext  —— 装配 L1 投影（assembly.projectWindow）+ u_now。
//   llmCall         —— 唯一的模型节点：人格+工具一体的 system（agent_unified）。
//                         无 tool_calls → 输出即最终回复（带人格，直出）；
//                         有 tool_calls → 进 tools 循环。碎念作为中间产物
//                         结构性不存在（v6"保留碎念"决议随三场景架构退役——
//                         真机证实末位 assistant 会被模型当"自己说到一半的
//                         话"续写，回复只剩后半句）。
//   tools           —— 并发执行 tool_calls，结果拼回 messages + 就地写
//                         process 行；轮次未满回 llmCall。
//   forcedFinalize  —— 轮次触顶的按需降级分支（dsh overflow 模式）：
//                         消息原样（同 system 同模型，缓存家族不分裂）、
//                         不传 tools（协议级逼出文本）、末尾注入恒定降级
//                         指令。主动停路径不经过这里（天然有内容可出）。
//
// 入库职责（v2/v7 决议）：本文件只写 process 行（llmCall/toolsNode 就地）；
// chat_user 由 dispatcher 入站收口、chat_bot 由出站收口（messages.ts）。

import { StateGraph, StateSchema, ReducedValue, START, END } from "@langchain/langgraph";
import { z } from "zod";
import type { MessageContext } from "../types.js";
import { projectWindow, buildCurrentUserMessage } from "./assembly.js";
import { callModel, isAbortError } from "../services/model.js";
import { logger } from "../services/logger.js";
import { getAgentSystemPrompt, LOOP_EXHAUSTED_SIGNAL } from "../services/prompts/functional.js";
import { runTool, toolSchemas } from "./registry.js";
import { appendEvent } from "./memory/events.js";
import { beginControlledFlow, endControlledFlow } from "../session/interrupt.js";
import { tenantKey } from "../session/key.js";
import { subscribeProgress } from "../services/progress-bus.js";
import type { ChatMessage } from "./types.js";

// 工具调用最多几轮。2 表示：允许一次串行依赖。轮次触顶且模型仍想调工具时
// 走 forcedFinalize 降级（v9：二期 token 预算判定落地后，触发器可换成预算）。
const MAX_TOOL_TURNS = 2;

// messages 用累加式的 ReducedValue：每个节点只管返回"这一步新增的消息"。
const AgentState = new StateSchema({
  messages: new ReducedValue(z.custom<ChatMessage[]>(), {
    reducer: (current: ChatMessage[], next: ChatMessage[]) => [...current, ...next],
  }),
  ctx: z.custom<MessageContext>(),
  userText: z.string(),
  projection: z.custom<ChatMessage[]>(),
  turnCount: z.number().default(0),
  reply: z.string().nullable().default(null),
  // /stop 中断信号：拉闸时正在等的 fetch 立刻抛 AbortError，当前轮当场结束。
  interruptSignal: z.custom<AbortSignal>().nullable().default(null),
});

type AgentStateT = typeof AgentState.State;
type AgentUpdateT = typeof AgentState.Update;

// 节点零：装配。projectWindow 从库投影（无状态，每次现算）；u_now 由 ctx 构造
// 恒在末尾。图片展开（懒识图）是这步的主要耗时来源（秒级）。
async function prepareContext(state: AgentStateT): Promise<AgentUpdateT> {
  const t0 = Date.now();
  const step = (name: string): void => {
    logger.node("agent", `prepareContext ${name} 完成（累计 +${Date.now() - t0}ms）`);
  };

  const { messages: projected } = await projectWindow(state.ctx);
  step("L1 投影");

  const uNow = await buildCurrentUserMessage(state.ctx, state.userText);
  step("u_now 构造（含当轮图片展开）");

  const initialMessages: ChatMessage[] = [
    { role: "system", content: getAgentSystemPrompt(state.ctx.event) },
    ...projected,
    uNow,
  ];

  return { messages: initialMessages, projection: projected };
}

// 节点一：唯一的模型节点（judge 职责已并入，v9）。带 tools 调用；
// 无 tool_calls 的输出直接就是最终回复（reply 出去，出站收口记 chat_bot）。
async function llmCall(state: AgentStateT): Promise<AgentUpdateT> {
  const response = await callModel(
    state.messages,
    toolSchemas(),
    undefined,
    undefined,
    "llmCall",
    state.interruptSignal ?? undefined,
  );

  // 就地入库（v2）：process 行，原文全文（tool_calls 含 id 的 JSON）。
  appendEvent({
    key: tenantKey(state.ctx.event),
    kind: "process",
    role: "assistant",
    content: response.content,
    toolCalls: response.tool_calls,
    origin: "agent",
  });

  const hasToolCalls = response.tool_calls !== undefined && response.tool_calls.length > 0;
  return {
    messages: [
      { role: "assistant", content: response.content, tool_calls: response.tool_calls },
    ],
    // 无 tool_calls = 最终回复（直通）；有 tool_calls 时 reply 不设（由后续
    // 轮次或 forcedFinalize 产出）。
    ...(hasToolCalls ? {} : { reply: response.content ?? "（Agent 没有返回内容）" }),
  };
}

// 节点二：本地并发执行 tool_calls。结果拼回 messages + 就地写 process 行
//（原文全文，零策略——体积控制由 reset 承担，装配侧零过滤）。
async function toolsNode(state: AgentStateT): Promise<AgentUpdateT> {
  const lastMessage = state.messages[state.messages.length - 1];
  const toolCalls = lastMessage?.tool_calls ?? [];
  const key = tenantKey(state.ctx.event);

  const toolMessages = await Promise.all(
    toolCalls.map(async (call): Promise<ChatMessage> => {
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(call.function.arguments) as Record<string, unknown>;
      } catch {
        args = {};
      }
      const result = await runTool(call.function.name, args, state.ctx);
      // 就地入库（v2）：tool 结果 process 行，保 tool_call_id（配对真相）。
      appendEvent({
        key,
        kind: "process",
        role: "tool",
        content: result,
        toolCallId: call.id,
        origin: "agent",
      });
      return { role: "tool", content: result, tool_call_id: call.id };
    }),
  );

  return { messages: toolMessages, turnCount: state.turnCount + 1 };
}

// 节点三（按需降级）：轮次触顶且模型仍在要工具时，撤 tools + 注入恒定降级
// 指令重试一次——协议级逼出文本（无工具可选，只能作答）。消息原样、同
// system 同模型：缓存家族不分裂（仅 tools 字段有无的差别，降级轮独付一次）。
async function forcedFinalize(state: AgentStateT): Promise<AgentUpdateT> {
  logger.node("agent", `轮次触顶降级收尾（基于 ${state.messages.filter((m) => m.role === "tool").length} 条工具结果）`);
  // messages[0] 是 system；其后原样 + 降级指令（单一真相源：M2.3 提示词引述
  // 同一信号的语义，冒烟测试锚定一致）。
  const messages: ChatMessage[] = [
    ...state.messages,
    { role: "user", content: LOOP_EXHAUSTED_SIGNAL },
  ];

  const final = await callModel(
    messages,
    undefined, // 不传 tools：撤工具是本节点存在的全部理由
    undefined,
    false,
    "forcedFinalize",
    state.interruptSignal ?? undefined,
  );
  const reply = final.content ?? "（Agent 没有返回内容）";
  return { messages: [{ role: "assistant", content: reply }], reply };
}

// 路由一：llmCall 之后。有 tool_calls → tools；没有 → END（reply 已在 llmCall
// 设好——无工具路径直出，主动停路径（看完工具结果给纯文本）同理直出）。
function afterLlmCall(state: AgentStateT): "tools" | "__end__" {
  const lastMessage = state.messages[state.messages.length - 1];
  const toolCalls = lastMessage?.tool_calls;
  return toolCalls !== undefined && toolCalls.length > 0 ? "tools" : "__end__";
}

// 路由二：tools 之后——轮次未满回 llmCall 再问一次；触顶去 forcedFinalize
//（降级只在"轮次用尽"时发生；轮次内模型的主动停止由 afterLlmCall 处理）。
function afterTools(state: AgentStateT): "llmCall" | "forcedFinalize" {
  return state.turnCount < MAX_TOOL_TURNS ? "llmCall" : "forcedFinalize";
}

const agentGraph = new StateGraph(AgentState)
  .addNode("prepareContext", prepareContext)
  .addNode("llmCall", llmCall)
  .addNode("tools", toolsNode)
  .addNode("forcedFinalize", forcedFinalize)
  .addEdge(START, "prepareContext")
  .addEdge("prepareContext", "llmCall")
  .addConditionalEdges("llmCall", afterLlmCall, ["tools", "__end__"])
  .addConditionalEdges("tools", afterTools, ["llmCall", "forcedFinalize"])
  .addEdge("forcedFinalize", END)
  .compile();

export async function runAgentTurn(
  userText: string,
  ctx: MessageContext,
): Promise<string> {
  // /stop 中断挂载（拒绝并发语义）：登记失败 = 该会话已有长流程在跑，直接拒绝。
  const flowKey = tenantKey(ctx.event);
  const controller = beginControlledFlow(flowKey);
  if (controller === null) {
    return "上一个任务还在跑哦～先发 /stop 停掉它，再重新发起吧。";
  }

  // 进度推送订阅（progress-bus）：正常完成、/stop 中断、异常三条路径都经
  // finally 退订。
  const unsubscribeProgress = subscribeProgress(ctx.event);
  const startedAt = Date.now();
  logger.node("agent", `[/Agent] 收到（${userText.slice(0, 40)}${userText.length > 40 ? "…" : ""}）`);

  try {
    // messages 初始值留空：prepareContext 负责拼 [system, ...投影, u_now]。
    // 入库不在 runAgentTurn：chat_user 由 dispatcher 收口、process 由节点
    // 就地、chat_bot 由出站收口（v2 决议）。
    const result = await agentGraph.invoke({
      messages: [],
      ctx,
      userText,
      interruptSignal: controller.signal,
    });

    if (controller.signal.aborted) {
      return "";
    }

    const reply = result.reply ?? "（Agent 没有返回内容）";
    logger.node("agent", `[/Agent] 完成 → 回复 ${reply.length} 字 (+${((Date.now() - startedAt) / 1000).toFixed(1)}s)`);
    return reply;
  } catch (err) {
    // /stop 拉闸时正在等的 fetch 抛 AbortError——这是"用户主动停"的正常信号，
    // 不是故障：静默返回空串（不发"任务失败"类消息，与 interrupt.ts 宣称的
    // 语义对齐）。不识别的话它会一路冒泡——自动路由下被 webhook 的 catch
    // 静默吞掉（留一行误导性的 error 日志），显式 /Agent 下触发"功能坏了"
    // 兜底文案，两条路径行为不一致。
    if (isAbortError(err)) {
      logger.info("agent", "[/Agent] 被 /stop 中断，静默收尾");
      return "";
    }
    throw err;
  } finally {
    unsubscribeProgress();
    endControlledFlow(flowKey, controller);
  }
}
