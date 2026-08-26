// agent/deep-search.ts —— 深度检索的编排层：一张独立的 StateGraph（总设计 §3.1）。
// 与日常 Agent 图（loop.ts）的关系：完全独立、零共享状态——loop.ts 一行不改，
// 日常 /Agent 行为不变；两张图各自有循环预算、提示词场景和记忆策略。
//
// 图结构（四节点 + 两条条件边）：
//   searchNode → browseLlm ⇄ browseTools → synthesize → END
//
//   searchNode   Tavily 起点检索（确定性，无模型参与）。参数本身是 URL 时跳过搜索，
//                直接以它为起点材料。设墙钟 deadline。
//   browseLlm    带 [open_page, interact_page] 调模型（flash：导航判断是轻任务且要调很多次）。
//                模型输出 tool_calls → browseTools；输出纯文本（材料小结）→ synthesize。
//   browseTools  并发执行 tool_calls（open_page 可真并发，同域串行由 fetch 层队列保证；
//                interact_page 经 browser.ts 的链自动串行），结果拼回 messages。
//   synthesize   汇总成报告（pro 模型 + thinking，deep_report 场景带人设）。
//
// A 档浏览器生命周期：runDeepSearch 用 try/finally 包住图调用，finally 里
// releaseBrowser()——一次深检请求一套浏览器，请求结束状态归零（总设计 §5.6）。

import { StateGraph, StateSchema, ReducedValue, START, END } from "@langchain/langgraph";
import { z } from "zod";
import { config } from "../config.js";
import type { MessageContext } from "../types.js";
import type { ChatMessage, ToolSchema } from "./types.js";
import { tavilySearch, formatSearchResults } from "../services/search.js";
import { callModel } from "../services/model.js";
import { getSystemPrompt } from "../services/prompts/builder.js";
import { releaseBrowser } from "../services/browse/browser.js";
import { openPageSchema, runOpenPage } from "./tools/open-page.js";
import { interactPageSchema, runInteractPage } from "./tools/interact-page.js";
import { logger } from "../services/logger.js";

// 深检图自持工具表：不进 agent/registry.ts 共享注册表（总设计 §4——进了共享表会被
// 日常 /Agent 的 toolSchemas() 一并发给闲聊模型）。同时绕开 runTool 的统一兜底
// "工具执行失败"：open_page/interact_page 需要细粒度错误文案让模型自愈重试。
const DEEP_TOOLS: ToolSchema[] = [openPageSchema, interactPageSchema];

// 深检工具的分发表：browseTools 节点按名字查这里。run 函数签名统一为
// (args, event)，event 用于页面池的人粒度隔离。
function runDeepTool(name: string, args: Record<string, unknown>, event: Parameters<typeof runOpenPage>[1]): Promise<string> {
  if (name === "open_page") return runOpenPage(args, event);
  if (name === "interact_page") return runInteractPage(args, event);
  return Promise.resolve(`未知工具 ${name}，可用：open_page / interact_page`);
}

const DeepSearchState = new StateSchema({
  // messages 用累加式 ReducedValue（与 loop.ts 同款）：每个节点只返回"新增的消息"。
  messages: new ReducedValue(z.custom<ChatMessage[]>(), {
    reducer: (current: ChatMessage[], next: ChatMessage[]) => [...current, ...next],
  }),
  question: z.string(),
  ctx: z.custom<MessageContext>(),
  // 本地测试用的开关：true 时跳过短期记忆落库（runDeepSearchLocally 设，
  // 防止测试污染生产 memory.sqlite）。
  skipMemory: z.boolean().default(false),
  turnCount: z.number().default(0),
  deadline: z.number().default(0),
  report: z.string().nullable().default(null),
});

type DeepSearchStateT = typeof DeepSearchState.State;
type DeepSearchUpdateT = typeof DeepSearchState.Update;

// 节点一：起点检索。纯确定性——问题 → Tavily top-6；参数是 URL 则直接作起点。
async function searchNode(state: DeepSearchStateT): Promise<DeepSearchUpdateT> {
  const question = state.question.trim();
  const isUrl = /^https?:\/\//i.test(question);

  let startMaterial: string;
  if (isUrl) {
    startMaterial = `用户直接提供了起点网址：${question}\n请用 open_page 打开它开始调研。`;
  } else {
    const results = await tavilySearch(question);
    startMaterial =
      results.length === 0
        ? "起点搜索没有结果。可以用 open_page 打开搜索引擎结果页（如 https://www.bing.com/search?q=问题关键词 ）自行寻找起点。"
        : `以下是搜索得到的起点材料（标题+摘要+链接）：\n${formatSearchResults(results)}`;
  }

  const initialMessages: ChatMessage[] = [
    { role: "system", content: getSystemPrompt(state.ctx.event, "deep_browse") },
    {
      role: "user",
      content: `用户的调研问题是：${question}\n\n${startMaterial}\n\n请开始逐步深入调研。`,
    },
  ];

  return {
    messages: initialMessages,
    deadline: Date.now() + config.browseTotalBudgetMs,
  };
}

// 节点二：浏览决策。带工具表调模型，原样返回交给条件边路由。
async function browseLlm(state: DeepSearchStateT): Promise<DeepSearchUpdateT> {
  const response = await callModel(
    state.messages,
    DEEP_TOOLS,
    config.aiModel,
    false,
    "browseLlm",
  );
  return {
    messages: [{ role: "assistant", content: response.content, tool_calls: response.tool_calls }],
  };
}

// 节点三：执行工具。open_page 并发（fetch 层同域队列兜底）、interact_page 自动串行
// （browser.ts 的 chain）。工具的细粒度错误文案原样进 messages——模型能据此修正重试。
async function browseTools(state: DeepSearchStateT): Promise<DeepSearchUpdateT> {
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
      const result = await runDeepTool(call.function.name, args, state.ctx.event);
      return { role: "tool", content: result, tool_call_id: call.id };
    }),
  );

  return { messages: toolMessages, turnCount: state.turnCount + 1 };
}

// 节点四：汇总报告。仿 loop.ts synthesizeFinalReply 的两条消息模式——
// system 放 deep_report 人设，user 只放动态内容（问题+起点+浏览记录）。
async function synthesize(state: DeepSearchStateT): Promise<DeepSearchUpdateT> {
  // 浏览记录：messages 里 user 之后的内容（起点消息之后的所有 assistant/tool 消息）
  const startIdx = state.messages.findIndex((msg) => msg.role === "user");
  const browseLog = state.messages
    .slice(startIdx + 1)
    .map((msg) => {
      if (msg.role === "assistant") {
        return msg.tool_calls !== undefined
          ? `（浏览动作：${msg.tool_calls.map((c) => c.function.name).join("、")}）`
          : `助手材料小结：${msg.content ?? ""}`;
      }
      return `页面内容/工具结果：${msg.content ?? ""}`;
    })
    .join("\n\n");
  const startMaterial = state.messages[startIdx]?.content ?? "";

  const final = await callModel(
    [
      { role: "system", content: getSystemPrompt(state.ctx.event, "deep_report") },
      {
        role: "user",
        content: `用户的调研问题是：${state.question}\n\n调研起点材料：\n${startMaterial}\n\n调研过程中的浏览记录：\n${browseLog || "（没有浏览记录）"}\n\n请基于以上材料撰写最终调研报告。`,
      },
    ],
    undefined,
    config.agentModel,
    true,
    "synthesize",
  );

  const report = final.content ?? "（深度检索没有生成报告）";
  return { messages: [{ role: "assistant", content: report }], report };
}

// 路由一：browseLlm 之后。无 tool_calls（模型自认材料够了，输出的是材料小结）→ 收尾；
// 有 tool_calls 但预算耗尽 → 收尾（优雅降级，synthesize 拿部分材料照样能出报告）。
function afterBrowseLlm(state: DeepSearchStateT): "browseTools" | "synthesize" {
  const lastMessage = state.messages[state.messages.length - 1];
  const hasToolCalls = lastMessage?.tool_calls !== undefined && lastMessage.tool_calls.length > 0;
  const budgetLeft = state.turnCount < config.browseMaxTurns && Date.now() < state.deadline;
  if (hasToolCalls && budgetLeft) return "browseTools";
  return "synthesize";
}

// 路由二：browseTools 之后。还有预算就回 browseLlm 看材料继续决策，没预算直接收尾。
function afterBrowseTools(state: DeepSearchStateT): "browseLlm" | "synthesize" {
  const budgetLeft = state.turnCount < config.browseMaxTurns && Date.now() < state.deadline;
  return budgetLeft ? "browseLlm" : "synthesize";
}

const deepSearchGraph = new StateGraph(DeepSearchState)
  .addNode("searchNode", searchNode)
  .addNode("browseLlm", browseLlm)
  .addNode("browseTools", browseTools)
  .addNode("synthesize", synthesize)
  .addEdge(START, "searchNode")
  .addEdge("searchNode", "browseLlm")
  .addConditionalEdges("browseLlm", afterBrowseLlm, ["browseTools", "synthesize"])
  .addConditionalEdges("browseTools", afterBrowseTools, ["browseLlm", "synthesize"])
  .addEdge("synthesize", END)
  .compile();

// 生产入口：/深度检索 命令进来走这里。记忆策略（总设计 §3.5）：只落
// 「问题 + 报告」两条进短期记忆，中间的 tool 消息全部不落库——后续 /Agent 能看到
// "查过什么、结论是什么"，但 20 条窗口不被页面正文挤爆。
export async function runDeepSearch(
  question: string,
  ctx: MessageContext,
): Promise<string> {
  const { memoryKey, sqliteMemoryStore } = await importMemory();
  const key = memoryKey(ctx.event);

  try {
    const result = await deepSearchGraph.invoke({
      messages: [],
      question,
      ctx,
      skipMemory: false,
    });
    const report = result.report ?? "（深度检索没有生成报告）";

    await sqliteMemoryStore.append(
      key,
      { openid: ctx.event.authorOpenid, name: ctx.event.authorName },
      { role: "user", content: `${ctx.event.authorName}：/深度检索 ${question}` },
      { role: "assistant", content: report },
    );
    return report;
  } finally {
    // A 档生命周期落点：无论成败，图跑完就关浏览器
    await releaseBrowser();
  }
}

// 延迟 import：memory 依赖 node:sqlite，本地测试（run-graph.ts）不想连生产库时
// 也能复用本模块。放函数内而不是顶部，避免测试路径加载存储层。
async function importMemory() {
  const { memoryKey } = await import("../agent/context.js");
  const { sqliteMemoryStore } = await import("./memory/sqlite.js");
  return { memoryKey, sqliteMemoryStore };
}

// 本地测试入口（test/deep_research/run-graph.ts 用）：跳过短期记忆落库，
// mock 一个最小 MessageContext——图的节点只用到 event 的 authorName/authorOpenid
// （页面池 sessionKey、getSystemPrompt 的 memoryKey），这些字段用假值即可。
// 注意 skipMemory 绕过了 sqliteMemoryStore：不会创建/写 data/memory.sqlite。
export async function runDeepSearchLocally(question: string): Promise<string> {
  const mockEvent = {
    type: "C2C_MESSAGE_CREATE",
    authorOpenid: "local-test",
    authorName: "本地测试",
  } as unknown as MessageContext["event"];

  const ctx: MessageContext = {
    command: null,
    text: `/深度检索 ${question}`,
    args: question,
    event: mockEvent,
  };

  try {
    const result = await deepSearchGraph.invoke({
      messages: [],
      question,
      ctx,
      skipMemory: true,
    });
    return result.report ?? "（深度检索没有生成报告）";
  } finally {
    await releaseBrowser();
  }
}
