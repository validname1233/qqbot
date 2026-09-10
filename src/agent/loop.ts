// agent/loop.ts —— agent 的核心流程：用 LangGraph 的 StateGraph 搭一个五节点小图，
//   顶替之前手写的 for 循环，语义完全对齐：
//     prepareContext —— 装配这一轮需要的上下文：取短期记忆历史、格式化当前这句话
//                        （单聊/群聊差异只在这一步体现）、拉长期记忆文本，写进 state。
//     llmCall       —— 带 tools 调模型，无论结果如何都原样返回，交给条件边路由。
//     plainReply    —— llmCall 判断出"不需要工具"时走到这里：换成汐汐人设、不带 tools
//                        再调一次，得到最终回复后直接结束（走 END）。
//     tools         —— llmCall 判断出"需要工具"时走到这里：本地并发执行 tool_calls，
//                        结果拼回 messages，turnCount+1。turnCount 还没到上限就绕回
//                        llmCall 再来一轮，到了上限就转去 finalize。
//     finalize      —— 轮次用完但 reply 还是空：单独拼一段「人设+需求+工具结果」的提示词，
//                        不带聊天历史、不带 tools，逼模型只根据这些信息收尾。
//   以后想让模型连续调多轮工具，还是只改 MAX_TOOL_TURNS 这个数字，不用动图结构。
//
// 记忆：短期记忆（最近若干条消息）+ 长期记忆占位，单聊/群聊的差异全部收在
// agent/context.ts 里（memoryKey / formatSpeakerContent / buildLongTermContextText），
// 本文件的节点只管调用，不用各自判断 event.type。

import { StateGraph, StateSchema, ReducedValue, START, END } from "@langchain/langgraph";
import { z } from "zod";
import { config } from "../config.js";
import type { MessageContext } from "../types.js";
import type { BotEvent } from "../events/registry.js";
import { memoryKey, formatSpeakerContent, buildLongTermContextText } from "./context.js";
import { expandImagePlaceholders } from "./memory/images.js";
import { callModel } from "../services/model.js";
import { logger } from "../services/logger.js";
import { getSystemPrompt } from "../services/prompts/builder.js";
import { runTool, toolSchemas, memoryExemptToolNames } from "./registry.js";
import { sqliteMemoryStore } from "./memory/sqlite.js";
import { beginControlledFlow, endControlledFlow } from "../session/interrupt.js";
import { sessionKey } from "../session/key.js";
import type { ChatMessage } from "./types.js";

// llmCall 用的系统提示词：只负责"要不要调工具、调哪个"的判断，不承担人设/表达任务。
// 这里特意不放人设：人设风格（语气词、卖萝莉属性）只会干扰模型对 tool_calls 的稳定输出，
// 而且这次调用的文字输出不会展示给用户（plainReply/finalize 会换人设重新生成）。
// 规则文本在 FUNCTIONAL_PROMPTS.agent_judge；agent_judge 在 builder.ts 登记为
// "纯功能场景"，getSystemPrompt 对它只返回功能规则、不拼人格。

// 工具调用最多几轮。2 表示：允许一次串行依赖——第一轮工具（如 get_time）的
// 返回值可以被第二轮工具（如 search）当参数用；不需要串行的请求模型第一轮
// 就收尾，不会白付第二轮的调用成本。
const MAX_TOOL_TURNS = 2;

// messages 用累加式的 ReducedValue：每个节点只管返回"这一步新增的消息"，
// 图会自动 concat 到已有 messages 后面——不用像原来手写循环那样自己 push。
// ctx 用 z.custom 只当类型标记，不做运行时校验（本来就是进程内对象，不需要校验）。
// longTermContext：长期记忆注入文本，prepareContext 节点写入，plainReply/finalize 读取。
// imageIds：/Agent 消息自带图片的 message_images id 列表（agentService.handle 下载后
// 传入），prepareContext 用来在当前 userMessage 里拼 [图片:<id>] 占位符。历史消息的
// 占位符在落库时就已带上（memory-log observer / runAgentTurn 的 append）。
const AgentState = new StateSchema({
  messages: new ReducedValue(z.custom<ChatMessage[]>(), {
    reducer: (current: ChatMessage[], next: ChatMessage[]) => [...current, ...next],
  }),
  ctx: z.custom<MessageContext>(),
  userText: z.string(),
  history: z.custom<ChatMessage[]>(),
  turnCount: z.number().default(0),
  reply: z.string().nullable().default(null),
  longTermContext: z.string().default(""),
  imageIds: z.custom<number[]>().default([]),
  // /stop 的中断信号：runAgentTurn 挂进 state，llmCall 的模型调用带它
  // （拉闸时正在等的 fetch 立刻抛 AbortError，当前轮当场结束）。
  interruptSignal: z.custom<AbortSignal>().nullable().default(null),
});

type AgentStateT = typeof AgentState.State;
type AgentUpdateT = typeof AgentState.Update;

// 节点零：图的新起点。把"这一轮需要哪些上下文"集中在这一步准备好——
// 取短期记忆历史（由 runAgentTurn 传入 state.history）、把当前这句话格式化
// （群聊拼昵称前缀，单聊原样）、拉长期记忆文本，最后把 history 和当前消息里的
// [图片:<id>] 占位符展开成 [图片]{描述}（懒加载识图：描述此刻才生成，见
// memory/images.ts）。后面的节点只管读 state，不用各自判断"是不是群聊"。
async function prepareContext(state: AgentStateT): Promise<AgentUpdateT> {
  const event = state.ctx.event;
  // 临时计时日志：排查 prepareContext 各步耗时用，看完可删。
  // 基准点取函数入口，每步打"累计耗时"而不是分段差值——分段差值要记上一段时间戳，
  // 累计值一行代码就能算，且各步加起来是否等于总耗时一眼可验。
  const t0 = Date.now();
  const step = (name: string, since: number): void => {
    logger.debug("agent", `prepareContext ${name} 完成（累计 +${Date.now() - since}ms）`);
  };

  // 当前消息：占位符拼在文字前（与 memory-log 的口径一致），再套群聊昵称前缀。
  const rawUserText = buildTextWithPlaceholders(state.userText, state.imageIds);
  const formattedUserText = formatSpeakerContent(rawUserText, event.authorName, event);
  step("占位符拼接与说话人格式化", t0);

  // 展开懒加载占位符：history 的 user 消息 + 当前 userMessage（/Agent 带图当轮就要看）。
  // 只展开 user 消息——assistant 回复万一复读了 "[图片:17]" 字样，不能被误替换。
  // 展开后的 history 覆盖写回 state：finalize 节点读 state.history，必须拿到展开版。
  const expandedHistory = await expandHistoryImages(state.history);
  step("history 图片占位符展开", t0);
  const expandedUserText = await expandImagePlaceholders(formattedUserText);
  step("当前消息图片占位符展开", t0);

  const longTermContext = await buildLongTermContextText(event, state.userText);
  step("长期记忆召回", t0);

  const userMessage: ChatMessage = { role: "user", content: expandedUserText };
  const initialMessages: ChatMessage[] = [
    { role: "system", content: getSystemPrompt(event, "agent_judge") },
    ...expandedHistory,
    userMessage,
  ];

  return { messages: initialMessages, history: expandedHistory, longTermContext };
}

// 当前消息的占位符拼接：图片在前、文字在后。逻辑与 memory-log 的
// buildContentWithPlaceholders 同款，这里不 import 是因为那边还要处理观察者
// 特有的空文本分支——两处各留一份三行小函数，好过为一行逻辑建公共依赖。
function buildTextWithPlaceholders(text: string, imageIds: number[]): string {
  const parts: string[] = imageIds.map((id) => `[图片:${id}]`);
  if (text !== "") parts.push(text);
  return parts.join(" ");
}

// history 里 user 消息的图片占位符批量展开（并发识图在 expandImagePlaceholders
// 内部做，这里只是逐条调用）。assistant/tool 消息原样保留。
async function expandHistoryImages(history: ChatMessage[]): Promise<ChatMessage[]> {
  return Promise.all(
    history.map(async (msg) => {
      if (msg.role !== "user" || msg.content === null) return msg;
      const expanded = await expandImagePlaceholders(msg.content);
      return expanded === msg.content ? msg : { ...msg, content: expanded };
    }),
  );
}

// 轮次用完但 reply 还是空时的收尾：单独拼一段提示词——人设 + 长期记忆 + 用户原始需求 +
// 工具结果——不带聊天历史、不带 tools，逼模型只根据这些信息给出一段干净的最终回复。
// 单开一个函数是因为这段提示词本身有点长，混在节点函数里会显得臃肿。
//
// 系统提示词和动态内容必须分开成两条消息：之前把 FINAL_REPLY_SYSTEM_PROMPT 和历史/需求/
// 工具结果整段拼成一条 role:"user" 消息发出去，等于把"人设+格式限制"这些本该受更高优先级
// 保护的系统指令，降级成了模型眼里"用户说的话"——指令层级一降，模型更容易被问出/复述这段
// 系统提示词。改成 role:"system" 单独一条，配合下面 role:"user" 只放会变化的上下文数据。
async function synthesizeFinalReply(
  userText: string,
  history: ChatMessage[],
  toolResults: ChatMessage[],
  longTermContext: string,
  event: BotEvent,
): Promise<string> {
  const historyText =
    history.length === 0
      ? "（无历史对话）"
      : history
          .map((msg) => `${msg.role}：${msg.content ?? "(无内容)"}`)
          .join("\n");

  const toolResultsText = toolResults
    .map((msg, i) => `工具结果 ${i + 1}：${msg.content ?? "(无内容)"}`)
    .join("\n\n");

  const userContentParts: string[] = [];

  if (longTermContext) {
    userContentParts.push(longTermContext);
    userContentParts.push("");
  }

  userContentParts.push(`以下是最近的对话记录（供参考上下文）：
${historyText}

用户现在想要实现的需求是：${userText}

以下是为完成这个需求而调用工具得到的结果：
${toolResultsText}

请你根据以上对话记录和工具结果，直接给用户一段完整、自然的最终回复，不要再调用任何工具。`);

  const final = await callModel(
    [
      { role: "system", content: getSystemPrompt(event, "agent_finalize") },
      { role: "user", content: userContentParts.join("\n") },
    ],
    undefined,
    config.agentModel,
    true,
    "finalizeNode",
  );
  return final.content ?? "（Agent 没有返回内容）";
}

// 节点一：带 tools 调模型。只负责判断"需不需要工具"，无论结果如何都把 response 原样返回，
// 交给条件边路由：有 tool_calls → tools 节点；没有 tool_calls → plainReply 节点。
// fetch 带 interruptSignal：/stop 拉闸时正在等的模型调用立刻抛 AbortError 中断。
async function llmCall(state: AgentStateT): Promise<AgentUpdateT> {
  const response = await callModel(
    state.messages,
    toolSchemas(),
    undefined,
    undefined,
    "llmCall",
    state.interruptSignal ?? undefined,
  );

  return {
    messages: [
      { role: "assistant", content: response.content, tool_calls: response.tool_calls },
    ],
  };
}

// 节点一.五：llmCall 判断出"不需要工具"时走到这里。刚才那次调用用的是 agent_judge
// （纯工具判断人设，不适合直接展示给用户），所以再跑一次不带 tools 的调用，
// 换成日常对话人设，让模型正常回答用户的问题。
async function plainReply(state: AgentStateT): Promise<AgentUpdateT> {
  // state.messages 结构：[0] agent_judge system, [1..n-1] history(含展开后的图片描述), [n] 当前用户消息, [n+1] 刚才 llmCall 返回的 assistant 消息
  // 要构造的新 messages：[0] 日常对话人设的 system, [1] 长期记忆（如果有）+ history + 当前用户消息
  // 图片描述已经内联在 history / 当前消息的 content 里（prepareContext 展开过），
  // 这里不需要任何图片相关的特判——占位符"长在消息里"的方案红利。
  const historyAndUser = state.messages.slice(1, -1); // 去掉开头的 agent_judge 和结尾的 assistant 消息

  const messages: ChatMessage[] = [{ role: "system", content: getSystemPrompt(state.ctx.event, "daily") }];

  if (state.longTermContext) {
    messages.push({ role: "user", content: state.longTermContext });
  }

  messages.push(...historyAndUser);

  const plain = await callModel(messages, undefined, undefined, undefined, "plainReply");
  const reply = plain.content ?? "（Agent 没有返回内容）";
  return { messages: [{ role: "assistant", content: reply }], reply };
}

// 节点二：本地并发执行上一步模型给的 tool_calls。结果拼回 messages，turnCount+1。
// 单个工具失败不影响其它工具——runTool 内部已把异常兜成固定短语"工具执行失败"。
async function toolsNode(state: AgentStateT): Promise<AgentUpdateT> {
  const lastMessage = state.messages[state.messages.length - 1];
  const toolCalls = lastMessage?.tool_calls ?? [];

  const toolMessages = await Promise.all(
    toolCalls.map(async (call): Promise<ChatMessage> => {
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(call.function.arguments) as Record<string, unknown>;
      } catch {
        args = {};
      }
      const result = await runTool(call.function.name, args, state.ctx);
      return { role: "tool", content: result, tool_call_id: call.id };
    }),
  );

  return { messages: toolMessages, turnCount: state.turnCount + 1 };
}

// 节点三：轮次用完但 reply 还是空时的收尾。只在这一种情况下会被走到。
async function finalizeNode(state: AgentStateT): Promise<AgentUpdateT> {
  // messages[0] 是 system prompt，之后是历史 + 这一轮新增的——挑出 role:"tool" 的
  // 部分喂给 synthesizeFinalReply，和原来 allToolMessages 的口径一致。
  const toolResults = state.messages.filter((msg) => msg.role === "tool");
  const reply = await synthesizeFinalReply(
    state.userText,
    state.history,
    toolResults,
    state.longTermContext,
    state.ctx.event,
  );
  return { messages: [{ role: "assistant", content: reply }], reply };
}

// 路由一：llmCall 之后——检查最后一条消息的 tool_calls：
//   - 轮次已到上限 → finalize（兜底）
//   - 没有 tool_calls → plainReply（换人设直接回答）
//   - 有 tool_calls → tools（执行工具）
function afterLlmCall(state: AgentStateT): "plainReply" | "tools" | "finalize" {
  if (state.turnCount >= MAX_TOOL_TURNS) {
    return "finalize";
  }
  const lastMessage = state.messages[state.messages.length - 1];
  const toolCalls = lastMessage?.tool_calls;
  return toolCalls === undefined || toolCalls.length === 0 ? "plainReply" : "tools";
}

// 路由二：tools 之后——轮次还没到上限就回 llmCall 再问模型一次，到上限就去 finalize 收尾。
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
  imageIds: number[] = [],
): Promise<string> {
  // /stop 中断挂载（拒绝并发语义）：登记失败 = 该会话已有长流程在跑，直接拒绝。
  const flowKey = sessionKey(ctx.event);
  const controller = beginControlledFlow(flowKey);
  if (controller === null) {
    return "上一个任务还在跑哦～先发 /stop 停掉它，再重新发起吧。";
  }

  try {
    const key = memoryKey(ctx.event);
    const history = await sqliteMemoryStore.get(key);

    // messages 初始值留空：prepareContext 节点是图的新起点，负责把
    // [AGENT_SYSTEM_PROMPT, ...history, 格式化后的 userMessage] 拼好写进 messages。
    // interruptSignal 进 state，供 llmCall 的模型调用和条件边感知 /stop。
    const result = await agentGraph.invoke({
      messages: [],
      ctx,
      userText,
      history,
      imageIds,
      interruptSignal: controller.signal,
    });

    // 被 /stop 中断的标志：reply 为空且 signal 已拉闸。正常完成 reply 一定非空
    // （plainReply/finalize 都会产出），不需要再给用户发"任务失败"——/stop 已确认过。
    if (controller.signal.aborted) {
      return "";
    }

    const reply = result.reply ?? "（Agent 没有返回内容）";

    // messages 里 [0] 是 system prompt，[1..history.length] 是历史，
    // 从 userMessage 开始往后的都是这一轮新增的——直接切片存进短期记忆。
    // 注意存的是"占位符版"（prepareContext 展开前的原始消息）：messages 里的
    // history 是展开版，但这一轮新增的切片（userMessage 及之后）来自初始构造，
    // prepareContext 返回的 userMessage 已是展开版——所以这里要用占位符版重拼，
    // 保证库里存的是引用（懒加载语义：描述不落库，下次读取再展开/复用缓存）。
    // 传入 author 信息：从事件中提取发言人的 openid 和昵称。
    const event = ctx.event;
    const rawUserText = buildTextWithPlaceholders(userText, imageIds);
    const storedUserMessage: ChatMessage = {
      role: "user",
      content: formatSpeakerContent(rawUserText, event.authorName, event),
    };
    // 声明了 skipMemory 的工具，其 tool 结果不入库（如 recall_memory 的切片是
    // 旧对话复印件，落库会挤爆热窗口并被再次检索到）。身份判定走结构化关联：
    // tool 消息的 tool_call_id ↔ assistant 消息 tool_calls[].id 反查出工具名，
    // 再查注册表的豁免名单——不按内容猜（前缀匹配那类做法，工具返回格式一改
    // 或内容碰巧相似就静默失效）。
    // 豁免的不是"删除"而是"换成占位符"：assistant(tool_calls) 与 tool 回话消息
    // 在 API 协议里绑定成对，删掉 tool 会让 assistant(tool_calls) 悬空——下轮
    // 这段 history 重放时撞上 DeepSeek 的消息格式校验直接 400。占位符保住
    // tool_call_id 的配对，正文换成一句说明，协议合法、语义也不误导。
    const exemptTools = memoryExemptToolNames();
    const toolCallNames = new Map<string, string>();
    for (const msg of result.messages) {
      if (msg.role === "assistant" && msg.tool_calls !== undefined) {
        for (const call of msg.tool_calls) toolCallNames.set(call.id, call.function.name);
      }
    }
    const newMessages = result.messages.slice(1 + history.length).map((msg) => {
      if (msg.role !== "tool") return msg;
      const toolName =
        msg.tool_call_id !== undefined ? toolCallNames.get(msg.tool_call_id) : undefined;
      if (toolName === undefined || !exemptTools.has(toolName)) return msg;
      return {
        role: "tool" as const,
        content: `${toolName} 结果返回`,
        tool_call_id: msg.tool_call_id,
      };
    });
    await sqliteMemoryStore.append(
      key,
      { openid: event.authorOpenid, name: event.authorName },
      storedUserMessage,
      ...newMessages.slice(1),
    );

    return reply;
  } finally {
    endControlledFlow(flowKey, controller);
  }
}
