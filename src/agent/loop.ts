// agent/loop.ts —— agent 的核心流程：用 LangGraph 的 StateGraph 搭一个三节点小图，
//   顶替之前手写的 for 循环，语义完全对齐：
//     llmCall  —— 带 tools 调模型。模型直接给文本就记下 reply，图走向 END；
//                  模型给 tool_calls 就原样记进 messages，转去 tools 节点。
//     tools    —— 本地并发执行上一步的 tool_calls，结果拼回 messages，turnCount+1。
//                  turnCount 还没到 MAX_TOOL_TURNS 就绕回 llmCall 再来一轮，
//                  到了上限就转去 finalize。
//     finalize —— 轮次用完但 reply 还是空：单独拼一段「人设+需求+工具结果」的提示词，
//                  不带聊天历史、不带 tools，逼模型只根据这些信息收尾。
//   以后想让模型连续调多轮工具，还是只改 MAX_TOOL_TURNS 这个数字，不用动图结构。
//
// 记忆：只存「短期记忆」（最近若干条消息），键用现成的 sessionKey(ctx.event)，
// 和状态机共享同一套「每人每场景」隔离粒度。长期记忆（数据库、跨会话）本次不做。

import { StateGraph, StateSchema, ReducedValue, START, END } from "@langchain/langgraph";
import { z } from "zod";
import { config } from "../config.js";
import type { MessageContext } from "../types.js";
import { sessionKey } from "../session/key.js";
import { callModelWithTools } from "./client.js";
import { runTool, toolSchemas } from "./registry.js";
import { inMemoryStore } from "./memory/in-memory.js";
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
const AgentState = new StateSchema({
  messages: new ReducedValue(z.custom<ChatMessage[]>(), {
    reducer: (current: ChatMessage[], next: ChatMessage[]) => [...current, ...next],
  }),
  ctx: z.custom<MessageContext>(),
  userText: z.string(),
  history: z.custom<ChatMessage[]>(),
  turnCount: z.number().default(0),
  reply: z.string().nullable().default(null),
});

type AgentStateT = typeof AgentState.State;
type AgentUpdateT = typeof AgentState.Update;

// 轮次用完但 reply 还是空时的收尾：单独拼一段提示词——人设 + 用户原始需求 +
// 工具结果——不带聊天历史、不带 tools，逼模型只根据这些信息给出一段干净的最终回复。
// 单开一个函数是因为这段提示词本身有点长，混在节点函数里会显得臃肿。
async function synthesizeFinalReply(
  userText: string,
  history: ChatMessage[],
  toolResults: ChatMessage[],
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

  const prompt = `${FINAL_REPLY_SYSTEM_PROMPT}

以下是最近的对话记录（供参考上下文）：
${historyText}

用户现在想要实现的需求是：${userText}

以下是为完成这个需求而调用工具得到的结果：
${toolResultsText}

请你根据以上对话记录和工具结果，直接给用户一段完整、自然的最终回复，不要再调用任何工具。`;

  // 收尾话术用 agentModel：不传 tools（undefined），换成更强的模型，
  // 并打开 enableThinking，让模型多想一步再给最终回复。
  const final = await callModelWithTools(
    [{ role: "user", content: prompt }],
    undefined,
    config.agentModel,
    true,
  );
  return final.content ?? "（Agent 没有返回内容）";
}

// 节点一：带 tools 调模型。模型没发起工具调用就直接收尾（设置 reply）；
// 发起了工具调用就把这条 assistant 消息记进 messages，交给 tools 节点去执行。
async function llmCall(state: AgentStateT): Promise<AgentUpdateT> {
  const response = await callModelWithTools(state.messages, toolSchemas());

  if (response.tool_calls === undefined || response.tool_calls.length === 0) {
    const reply = response.content ?? "（Agent 没有返回内容）";
    return { messages: [{ role: "assistant", content: reply }], reply };
  }

  //console.log("[agent:debug] callModelWithTools response:", JSON.stringify(response, null, 2));
  
  return {
    messages: [
      { role: "assistant", content: response.content, tool_calls: response.tool_calls },
    ],
  };
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
  const reply = await synthesizeFinalReply(state.userText, state.history, toolResults);
  return { messages: [{ role: "assistant", content: reply }], reply };
}

// 路由一：llmCall 之后——reply 已经有了（模型没调工具）就直接结束，否则去执行工具。
function afterLlmCall(state: AgentStateT): "tools" | typeof END {
  return state.reply === null ? "tools" : END;
}

// 路由二：tools 之后——轮次还没到上限就回 llmCall 再问模型一次，到上限就去 finalize 收尾。
function afterTools(state: AgentStateT): "llmCall" | "finalize" {
  return state.turnCount < MAX_TOOL_TURNS ? "llmCall" : "finalize";
}

const agentGraph = new StateGraph(AgentState)
  .addNode("llmCall", llmCall)
  .addNode("tools", toolsNode)
  .addNode("finalize", finalizeNode)
  .addEdge(START, "llmCall")
  .addConditionalEdges("llmCall", afterLlmCall, ["tools", END])
  .addConditionalEdges("tools", afterTools, ["llmCall", "finalize"])
  .addEdge("finalize", END)
  .compile();

export async function runAgentTurn(
  userText: string,
  ctx: MessageContext,
): Promise<string> {
  const key = sessionKey(ctx.event);
  const history = await inMemoryStore.get(key);

  const userMessage: ChatMessage = { role: "user", content: userText };
  const initialMessages: ChatMessage[] = [
    { role: "system", content: AGENT_SYSTEM_PROMPT },
    ...history,
    userMessage,
  ];

  const result = await agentGraph.invoke({
    messages: initialMessages,
    ctx,
    userText,
    history,
  });

  const reply = result.reply ?? "（Agent 没有返回内容）";

  // messages 里 [0] 是 system prompt，[1..history.length] 是历史，
  // 从 userMessage 开始往后的都是这一轮新增的——直接切片存进短期记忆。
  await inMemoryStore.append(key, ...result.messages.slice(1 + history.length));

  return reply;
}
