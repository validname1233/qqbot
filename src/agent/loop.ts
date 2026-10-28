// agent/loop.ts —— agent 的核心流程：LangGraph StateGraph 五节点小图
//（2026-10-28 记忆与上下文重构后的形态，总方案 docs/features/
// 2026-10-28-记忆与上下文重构总方案.md 模块二）：
//   prepareContext —— 装配 L1 投影（assembly.projectWindow：最新 reset 之后的
//                        chat 行 → 形态 B 增量 blob），拼 [system, ...投影, u_now]。
//   llmCall       —— 带 tools 调模型（judge：意图推断 + 工具决策）。每拿到一次
//                        输出就地写一行 process（库存真相，v2 就地入库决议）。
//   plainReply    —— judge 判定无需工具：换人设重答。输入含 judge 的固定话术
//                        碎念（v6：选项二保留；连续 assistant 协议安全已实证）。
//   tools         —— 并发执行 tool_calls，结果拼回 messages；每条结果就地写
//                        process 行（原文全文，零策略）。
//   finalize      —— 调过工具后的收尾：system 含收尾指令（INSTR 已取消并入
//                        agent_finalize），user 侧 = 投影 + u_now + 本轮裸序列。
//   轮次上限 MAX_TOOL_TURNS 不变；改它不用动图结构。
//
// 入库职责（v2/v7 决议）：本文件只写 process 行（llmCall/toolsNode 就地）；
// chat_user 由 dispatcher 入站收口、chat_bot 由出站收口（messages.ts）——
// runAgentTurn 尾部的批量落库段已删除。

import { StateGraph, StateSchema, ReducedValue, START, END } from "@langchain/langgraph";
import { z } from "zod";
import { config } from "../config.js";
import type { MessageContext } from "../types.js";
import { projectWindow, buildCurrentUserMessage } from "./assembly.js";
import { callModel } from "../services/model.js";
import { logger } from "../services/logger.js";
import { getSystemPrompt } from "../services/prompts/builder.js";
import { runTool, toolSchemas } from "./registry.js";
import { appendEvent } from "./memory/events.js";
import { beginControlledFlow, endControlledFlow } from "../session/interrupt.js";
import { tenantKey } from "../session/key.js";
import { subscribeProgress } from "../services/progress-bus.js";
import type { ChatMessage } from "./types.js";

// llmCall 用的系统提示词：只负责"读历史 → 推断意图 → 判断要不要调工具"，
// 不承担人设/表达任务（纯功能场景，builder 不拼人格）。它的文字输出在无工具
// 路径被塑形为固定话术（见 agent_judge 提示词），不会展示给用户。

// 工具调用最多几轮。2 表示：允许一次串行依赖——第一轮工具（如 get_time）的
// 返回值可以被第二轮工具（如 search）当参数用。
const MAX_TOOL_TURNS = 2;

// messages 用累加式的 ReducedValue：每个节点只管返回"这一步新增的消息"。
// ctx 用 z.custom 只当类型标记，不做运行时校验（进程内对象）。
// projection：prepareContext 写入的 L1 投影（plainReply/finalize 复用）。
// interruptSignal：/stop 的中断信号，llmCall 的模型调用带它。
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
    { role: "system", content: getSystemPrompt(state.ctx.event, "agent_judge") },
    ...projected,
    uNow,
  ];

  return { messages: initialMessages, projection: projected };
}

// 节点一：带 tools 调模型（judge）。输出就地写一行 process（库存真相）——
// 含 tool_calls 的 Thought 与无工具路径的固定话术碎念都落。
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

  return {
    messages: [
      { role: "assistant", content: response.content, tool_calls: response.tool_calls },
    ],
  };
}

// 节点一.五：judge 判定"不需要工具"时走到这里。输入数组 = 投影 + u_now +
// judge 的固定话术碎念（v6 决议：选项二保留——连续 assistant 协议安全已实证，
// 碎念被塑形为完整自洽的一句话，续写风险极低）。换成日常人设重新生成。
async function plainReply(state: AgentStateT): Promise<AgentUpdateT> {
  // state.messages：[0] agent_judge system, [1..n-1] 投影+u_now, [n] 碎念。
  // 新 messages：日常 system + 投影 + u_now + 碎念（保留 v6；daily 的 system
  // 声明"判断话术是路由中间产物，无视其表达、回答用户最后的问题"）。
  const messages: ChatMessage[] = [
    { role: "system", content: getSystemPrompt(state.ctx.event, "daily") },
    ...state.projection,
    ...state.messages.slice(-2), // u_now + 碎念（最后两条）
  ];

  const plain = await callModel(messages, undefined, undefined, undefined, "plainReply");
  const reply = plain.content ?? "（Agent 没有返回内容）";
  return { messages: [{ role: "assistant", content: reply }], reply };
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

// 节点三：调过工具后的统一收尾。user 侧 = 投影 + u_now + 本轮裸序列
//（assistant(tool_calls)/tool 对，协议配对原样）；system 含收尾指令
//（agent_finalize，INSTR 已取消并入）。不再把历史重引用成平文本。
async function finalizeNode(state: AgentStateT): Promise<AgentUpdateT> {
  logger.node("agent", `finalize 收尾（基于 ${state.messages.filter((m) => m.role === "tool").length} 条工具结果）`);
  // 本轮新增 = 投影之后的消息（u_now 起到末尾，含全部工具序列）。
  const afterProjection = state.messages.slice(state.projection.length + 1);

  const messages: ChatMessage[] = [
    { role: "system", content: getSystemPrompt(state.ctx.event, "agent_finalize") },
    ...state.projection,
    ...afterProjection,
  ];

  // thinking 必须关（2026-10-28 真机事故）：DeepSeek 思考模式要求输入里的
  // assistant 消息携带 reasoning_content 回传——新架构的 finalize 复用真实
  // 消息序列（含投影里的 chat_bot 历史 + 本轮 judge 输出），而思维链从未被
  // 存储（ChatMessage 无此字段，judge 轮 thinking=off 本就无产出），永远
  // 拿不出 reasoning_content → 400 "must be passed back"。旧架构的巨型
  // user 文本 blob 恰好零 assistant，意外合规；结构修对后此雷才暴露。
  // 强模型（agentModel）保留，thinking 舍弃——收尾质量的主体在模型本身。
  const final = await callModel(messages, undefined, config.agentModel, false, "finalizeNode");
  const reply = final.content ?? "（Agent 没有返回内容）";
  return { messages: [{ role: "assistant", content: reply }], reply };
}

// 路由一：llmCall 之后。plainReply 唯一入口 = 从未调过工具（历史性判据）：
// "调完工具后主动停止"的路径（看完工具结果给纯文本）必须走 finalize——
// 那里显式拼工具结果 + pro 模型收尾，答案保住（2026-09-18 事故的教训）。
function afterLlmCall(state: AgentStateT): "plainReply" | "tools" | "finalize" {
  const lastMessage = state.messages[state.messages.length - 1];
  const toolCalls = lastMessage?.tool_calls;
  const hasToolCalls = toolCalls !== undefined && toolCalls.length > 0;
  if (hasToolCalls && state.turnCount < MAX_TOOL_TURNS) {
    return "tools";
  }
  const usedTools = state.messages.some((msg) => msg.role === "tool");
  return usedTools ? "finalize" : "plainReply";
}

// 路由二：tools 之后——轮次未到上限回 llmCall，到了去 finalize。
function afterTools(state: AgentStateT): "llmCall" | "finalize" {
  return state.turnCount < MAX_TOOL_TURNS ? "llmCall" : "finalize";
}

const agentGraph = new StateGraph(AgentState)
  .addNode("prepareContext", prepareContext)
  .addNode("llmCall", llmCall)
  .addNode("plainReply", plainReply)
  .addNode("tools", toolsNode)
  .addNode("finalize", finalizeNode)
  .addEdge(START, "prepareContext")
  .addEdge("prepareContext", "llmCall")
  .addConditionalEdges("llmCall", afterLlmCall, ["plainReply", "tools", "finalize"])
  .addEdge("plainReply", END)
  .addConditionalEdges("tools", afterTools, ["llmCall", "finalize"])
  .addEdge("finalize", END)
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
    // 入库不再在此处发生——chat_user 由 dispatcher 收口、process 由节点就地、
    // chat_bot 由出站收口（旧批量落库段已删除，v2 决议）。
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
  } finally {
    unsubscribeProgress();
    endControlledFlow(flowKey, controller);
  }
}
