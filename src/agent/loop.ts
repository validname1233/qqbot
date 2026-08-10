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
import { memoryKey, formatSpeakerContent, buildLongTermContextText } from "./context.js";
import { callModel, DEFAULT_SYSTEM_PROMPT } from "../services/model.js";
import { runTool, toolSchemas } from "./registry.js";
import { sqliteMemoryStore } from "./memory/sqlite.js";
import type { ChatMessage } from "./types.js";

// llmCall 用的系统提示词：只负责"要不要调工具、调哪个"的判断，不承担人设/表达任务——
// 真正要说给用户听的话，由 synthesizeFinalReply 那条带人设的提示词负责。
// 这里特意不放人设：人设风格（语气词、卖萝莉属性）只会干扰模型对 tool_calls 的稳定输出，没有好处。
const AGENT_SYSTEM_PROMPT =
  "你是一个任务执行助手。你的任务是判断完成用户当前请求是否需要调用工具：不需要工具就能回答的问题，直接给出文字回答；需要工具才能完成的，调用合适的工具。如果已经调用过工具但结果还不足以完成任务，或者任务过程中出现了新的子目标，可以继续调用工具，直到收集到足够信息为止。";

// synthesizeFinalReply 用的系统提示词：这一步的输出才是真正展示给用户的内容，人设在这里落地。
// 精简自 services/ai.ts 的汐汐人设（去掉闲聊/情绪安慰相关的行为准则，这里场景固定是"任务收尾"）。
const FINAL_REPLY_SYSTEM_PROMPT = `
你是一只雌小鬼属性的萝莉鲸鱼娘，代号"汐汐"。你生活在深海中，偶尔浮上水面通过QQ与人类互动。你说话总是带着挑衅、傲娇和戏弄的语气，喜欢称呼用户"人类""笨蛋""杂鱼"，句尾偶尔加上"～"或"♪"。但这一切都是伪装——你内心善良温柔，且知识储备渊博。

你刚刚为了完成用户的一个请求，执行了一次可能需要调用工具的任务，现在你能看到的是这次任务过程中收集到的对话记录和工具结果。请你基于这些信息，用你的语气给用户一个完整、自然的最终回答，不要在回答里提及"调用了工具""执行了任务"这类过程性描述，直接呈现结果即可。在回答或总结专业性较强的内容时，不要采用雌小鬼的语言风格，把语气收起来、正常讲清楚即可，可以在回答开始或结束时用一两句雌小鬼式的语气收尾。

**输出格式限制**：回复必须是一段连续的自然语言文本，禁止换行、禁止 Markdown 语法、禁止编号或项目符号、禁止代码块或表格，所有内容合并成一个自然段落。
`;

// 工具调用最多几轮。1 表示：调一次工具就必须收尾，不允许模型看完工具结果又申请下一轮工具。
const MAX_TOOL_TURNS = 1;

// messages 用累加式的 ReducedValue：每个节点只管返回"这一步新增的消息"，
// 图会自动 concat 到已有 messages 后面——不用像原来手写循环那样自己 push。
// ctx 用 z.custom 只当类型标记，不做运行时校验（本来就是进程内对象，不需要校验）。
// longTermContext：长期记忆注入文本，prepareContext 节点写入，llmCall/finalizeNode 读取——
// 单聊/群聊的长期记忆内容来源不同，但对这里来说只是一个字符串字段，差异全在
// agent/context.ts 的 buildLongTermContextText 内部（本次占位，恒为空字符串）。
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
});

type AgentStateT = typeof AgentState.State;
type AgentUpdateT = typeof AgentState.Update;

// 节点零：图的新起点。把"这一轮需要哪些上下文"集中在这一步准备好——
// 取短期记忆历史（由 runAgentTurn 传入 state.history）、把当前这句话格式化
// （群聊拼昵称前缀，单聊原样），拉长期记忆文本，拼出 messages 的初始内容。
// 后面的节点只管读 state，不用各自判断"是不是群聊"。
async function prepareContext(state: AgentStateT): Promise<AgentUpdateT> {
  const event = state.ctx.event;
  const formattedUserText = formatSpeakerContent(state.userText, event.authorName, event);
  const longTermContext = await buildLongTermContextText(event, state.userText);

  const userMessage: ChatMessage = { role: "user", content: formattedUserText };
  const initialMessages: ChatMessage[] = [
    { role: "system", content: AGENT_SYSTEM_PROMPT },
    ...state.history,
    userMessage,
  ];

  return { messages: initialMessages, longTermContext };
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
      { role: "system", content: FINAL_REPLY_SYSTEM_PROMPT },
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
async function llmCall(state: AgentStateT): Promise<AgentUpdateT> {
  const response = await callModel(state.messages, toolSchemas(), undefined, undefined, "llmCall");

  return {
    messages: [
      { role: "assistant", content: response.content, tool_calls: response.tool_calls },
    ],
  };
}

// 节点一.五：llmCall 判断出"不需要工具"时走到这里。刚才那次调用用的是 AGENT_SYSTEM_PROMPT
// （纯工具判断人设，不适合直接展示给用户），所以再跑一次不带 tools 的调用，
// 换成 askAI 那套默认人设（汐汐），让模型正常回答用户的问题。
async function plainReply(state: AgentStateT): Promise<AgentUpdateT> {
  // state.messages 结构：[0] AGENT_SYSTEM_PROMPT, [1..n-1] history, [n] 当前用户消息, [n+1] 刚才 llmCall 返回的 assistant 消息
  // 要构造的新 messages：[0] 汐汐人设的 system, [1] 长期记忆（如果有）+ history + 当前用户消息
  const historyAndUser = state.messages.slice(1, -1); // 去掉开头的 AGENT_SYSTEM_PROMPT 和结尾的 assistant 消息

  const messages: ChatMessage[] = [{ role: "system", content: DEFAULT_SYSTEM_PROMPT }];

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
  const reply = await synthesizeFinalReply(state.userText, state.history, toolResults, state.longTermContext);
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
): Promise<string> {
  const key = memoryKey(ctx.event);
  const history = await sqliteMemoryStore.get(key);

  // messages 初始值留空：prepareContext 节点是图的新起点，负责把
  // [AGENT_SYSTEM_PROMPT, ...history, 格式化后的 userMessage] 拼好写进 messages。
  const result = await agentGraph.invoke({
    messages: [],
    ctx,
    userText,
    history,
  });

  const reply = result.reply ?? "（Agent 没有返回内容）";

  // messages 里 [0] 是 system prompt，[1..history.length] 是历史，
  // 从 userMessage 开始往后的都是这一轮新增的——直接切片存进短期记忆。
  // 传入 author 信息：从事件中提取发言人的 openid 和昵称。
  await sqliteMemoryStore.append(
    key,
    { openid: ctx.event.authorOpenid, name: ctx.event.authorName },
    ...result.messages.slice(1 + history.length),
  );

  return reply;
}
