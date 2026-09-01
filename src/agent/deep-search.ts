// agent/deep-search.ts —— 深度检索的编排层：一张独立的 StateGraph（总设计 §3.1）。
// 与日常 Agent 图（loop.ts）的关系：完全独立、零共享状态——loop.ts 一行不改，
// 日常 /Agent 行为不变；两张图各自有循环预算、提示词场景和记忆策略。
//
// 图结构（五节点 + 三条条件边，plan & execute）：
//   searchNode → planNode → (browseLlm ⇄ browseTools)* → synthesize → END
//
//   searchNode   起点装配（确定性，无模型参与）。用户消息里的 URL 正则提取（≤5 个）后
//                逐个预读成页面材料——不经模型转手，消灭"模型抄写 URL"的幻觉/丢字
//                风险；没有 URL 或全部 URL 预读失败时走 Tavily 起点检索。设墙钟 deadline。
//   planNode     制定调研计划（flash，deep_plan 纯功能场景，不带 tools）——看过起点
//                材料再定方向，写入思维链 chain[0]。三期登录检测的挂点（届时给它
//                工具表）。预算耗尽则跳过模型调用直接收尾。
//   browseLlm    思维链注入提示词末尾后带 [open_page, interact_page] 调模型（flash：
//                导航判断是轻任务且要调很多次）。模型 content（本步复盘+下一步指示，
//                即思维链下一环）追加进 chain；无 tool_calls（Claude Code 式自然退出）
//                → synthesize，有 → browseTools。
//   browseTools  并发执行 tool_calls（open_page 可真并发，同域串行由 fetch 层队列保证；
//                interact_page 经 browser.ts 的链自动串行），结果拼回 messages。
//   synthesize   汇总成报告（pro 模型 + thinking，deep_report 场景带人设）；
//                user 消息含问题 + 起点材料 + 思维链 + 浏览记录。
//
// 思维链（chain，plan & execute 的记忆体）：planNode 写计划，browseLlm 每轮追加本步
// 复盘——「一次调用双职责」（content 承载 Thought，tool_calls 是 Action），content 为
// null 时从 tool_calls 合成最小条目兜底（DeepSeek 带 tool_calls 时 content 常为 null，
// 提示词压不死）。只在 browseLlm 注入和 synthesize 拼报告时读取，刻意不进
// state.messages（理由见 browseLlm 的注释）。
//
// A 档浏览器生命周期：runDeepSearch 用 try/finally 包住图调用，finally 里
// releaseBrowser()——一次深检请求一套浏览器，请求结束状态归零（总设计 §5.6）。

import { StateGraph, StateSchema, ReducedValue, START, END } from "@langchain/langgraph";
import { z } from "zod";
import { config } from "../config.js";
import type { MessageContext } from "../types.js";
import type { ChatMessage } from "./types.js";
import { webSearch, formatSearchResults } from "../services/search.js";
import { callModel } from "../services/model.js";
import { getSystemPrompt } from "../services/prompts/builder.js";
import { releaseBrowser } from "../services/browse/browser.js";
import { toolSchemas, runTool } from "./deep-search/registry.js";
import { loadPage } from "./tools/open-page.js";
import { beginControlledFlow, endControlledFlow } from "../session/interrupt.js";
import { sessionKey } from "../session/key.js";
import { logger } from "../services/logger.js";

// 深检工具走独立注册表（deep-search/registry.ts），不进 agent/registry.ts 共享注册表
// （总设计 §4——进了共享表会被日常 /Agent 的 toolSchemas() 一并发给闲聊模型）。
// 注册表 import 即完成注册，这里直接取 schema 发模型、按名字执行。

const DeepSearchState = new StateSchema({
  // messages 用累加式 ReducedValue（与 loop.ts 同款）：每个节点只返回"新增的消息"。
  messages: new ReducedValue(z.custom<ChatMessage[]>(), {
    reducer: (current: ChatMessage[], next: ChatMessage[]) => [...current, ...next],
  }),
  // 思维链（plan & execute）：planNode 写入计划（chain[0]），browseLlm 每轮追加
  // 本步复盘+下一步指示（content 为 null 时从 tool_calls 合成兜底条目）。
  // 与 messages 同款累加式 reducer；两个通道分开——链文不进 messages（见 browseLlm 注释）。
  chain: new ReducedValue(z.custom<string[]>(), {
    reducer: (current: string[], next: string[]) => [...current, ...next],
  }),
  question: z.string(),
  ctx: z.custom<MessageContext>(),
  // 本地测试用的开关：true 时跳过短期记忆落库（runDeepSearchLocally 设，
  // 防止测试污染生产 memory.sqlite）。
  skipMemory: z.boolean().default(false),
  turnCount: z.number().default(0),
  deadline: z.number().default(0),
  report: z.string().nullable().default(null),
  // /stop 的中断信号（与 loop.ts 同款）：browseLlm/planNode/synthesize 的模型调用
  // 带它，条件边查 aborted——拉闸后不再进下一轮，直接收尾。
  interruptSignal: z.custom<AbortSignal>().nullable().default(null),
});

type DeepSearchStateT = typeof DeepSearchState.State;
type DeepSearchUpdateT = typeof DeepSearchState.Update;

// 节点一：起点装配。纯确定性，无模型参与。三种入口情形：
//   a) 用户消息里带 URL（正则提取，最多 MAX_START_URLS 个）→ 逐个预读成页面材料
//      （不经模型转手，消灭"模型抄写用户 URL"的幻觉/丢字风险）。
//      部分失败：失败的注记进材料（"以下网址无法访问：…"），成功的照常用；
//      全部失败：退化成 Tavily 兜底，并明确告诉模型"提供的网址访问失败"。
//   b) 没有 URL → Tavily 起点检索（top-6 标题+摘要+链接）。
//   c) Tavily 也没结果 → 提示模型可用 open_page 打开搜索引擎结果页自寻起点。
// 墙钟 deadline 在本节点开头设定：预读和搜索都计入预算。
const MAX_START_URLS = 5;

// 从用户消息里提取 http(s) URL。不用 \S+ 一把抓：中文标点（，。！？）和右括号
// 常紧贴 URL 出现（"看 https://a.com/x，谢谢"），贪婪匹配会把标点粘进 URL。
// 排除集覆盖 CJK 标点+全角括号；匹配完后剩下去掉 URL 的文字回归问题本体。
const URL_PATTERN = /https?:\/\/[^\s，。！？；、）】》"'\]]+/gi;

function extractStartUrls(question: string): { urls: string[]; cleaned: string } {
  const urls: string[] = [];
  const cleaned = question.replace(URL_PATTERN, (match) => {
    if (urls.length < MAX_START_URLS) urls.push(match);
    return "";
  });
  return { urls, cleaned: cleaned.replace(/\s{2,}/g, " ").trim() };
}

// 用户 URL 的并行预读。allSettled：单个失败不影响其它 URL（部分成功是常态）。
async function prefetchUrls(
  urls: string[],
  event: Parameters<typeof loadPage>[1],
): Promise<{ pages: string[]; failures: string[] }> {
  const settled = await Promise.allSettled(urls.map((url) => loadPage(url, event)));
  const pages: string[] = [];
  const failures: string[] = [];
  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i];
    if (outcome.status === "fulfilled") {
      pages.push(outcome.value);
    } else {
      const reason = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
      logger.warn("browse", `起点 URL 预读失败 ${urls[i]}: ${reason}`);
      failures.push(`${urls[i]}（${reason}）`);
    }
  }
  return { pages, failures };
}

// Tavily 起点材料。0 结果不算失败——返回引导模型自寻起点的提示（情形 c）。
async function searchStartMaterial(question: string): Promise<string> {
  const results = await webSearch(question);
  if (results.length === 0) {
    return "起点搜索没有结果。可以用 open_page 打开搜索引擎结果页（如 https://www.bing.com/search?q=问题关键词 ）自行寻找起点。";
  }
  return `以下是搜索得到的起点材料（标题+摘要+链接）：\n${formatSearchResults(results)}`;
}

async function searchNode(state: DeepSearchStateT): Promise<DeepSearchUpdateT> {
  const deadline = Date.now() + config.browseTotalBudgetMs;
  const question = state.question.trim();
  const { urls, cleaned } = extractStartUrls(question);

  const parts: string[] = [];
  let tavilyFallback: string | null = null;

  if (urls.length > 0) {
    const { pages, failures } = await prefetchUrls(urls, state.ctx.event);
    if (pages.length > 0) {
      parts.push(`用户提供了起点网址，已直接读取页面内容如下：\n\n${pages.join("\n\n")}`);
    }
    if (failures.length > 0) {
      // 全败才跑 Tavily 兜底：部分成功时材料就是用户指的东西，再搜索只添噪音；
      // 模型真需要补充可以自己 open_page 搜索引擎。
      if (pages.length === 0) {
        try {
          tavilyFallback = await searchStartMaterial(cleaned !== "" ? cleaned : urls[0]);
          parts.push(`用户提供的网址访问失败，以下是搜索得到的起点材料：\n${tavilyFallback}`);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          logger.warn("browse", `Tavily 兜底搜索失败: ${reason}`);
          parts.push("起点搜索失败（用户提供的网址也无法访问）。可以用 open_page 打开搜索引擎结果页（如 https://www.bing.com/search?q=问题关键词 ）自行寻找起点。");
        }
      } else {
        parts.push(`以下网址无法访问，请勿再尝试打开：\n${failures.join("\n")}`);
      }
    }
  } else {
    parts.push(await searchStartMaterial(question));
  }

  // user 消息只放数据（问题+起点材料），不放指令——"开始调研"的指令在 deep_browse
  // 系统提示词里本来就有。保持纯数据的原因：这条消息会被 planNode 原样重发
  // （换 deep_plan 信封），也会被 synthesize 引用为"起点材料"，混进指令对两个
  // 消费者都是噪声。
  const initialMessages: ChatMessage[] = [
    { role: "system", content: getSystemPrompt(state.ctx.event, "deep_browse") },
    {
      role: "user",
      content: `用户的调研问题是：${cleaned !== "" ? cleaned : question}\n\n${parts.join("\n\n")}`,
    },
  ];

  return { messages: initialMessages, deadline };
}

// 节点二：制定计划（plan & execute 的 plan 半边，总设计 §5.2 修订二）。输入 =
// searchNode 拼好的问题 + 起点材料（system 换 deep_plan 场景），调 flash、不带
// tools——计划是纯文本方向而非动作；三期 login 工具就位后才给它工具表。
// 输出写入 chain[0]，不追加进 messages——浏览循环经思维链注入读它，两条通道
// 只会重复。放在 searchNode 之后（先见材料再定计划）：URL 预读的红利在这里
// 变现——登录墙、付费墙、空壳 SPA 在计划阶段就能被看见，对策直接写进计划。
// 不计入 turnCount（它不是浏览轮次，墙钟预算已覆盖它的耗时）。
async function planNode(state: DeepSearchStateT): Promise<DeepSearchUpdateT> {
  // 预算已耗尽（预读/起点检索吃光预算的极端情况）：跳过模型调用，交给条件边直接收尾
  if (Date.now() >= state.deadline) {
    return { chain: [] };
  }

  // messages 结构：[system: deep_browse, user: 问题+起点材料]——计划环节只需要
  // 这条 user 消息，deep_browse 的浏览纪律对计划是噪声，换成 deep_plan 场景重发。
  const startMessage = state.messages.find((msg) => msg.role === "user");

  const plan = await callModel(
    [
      { role: "system", content: getSystemPrompt(state.ctx.event, "deep_plan") },
      startMessage ?? { role: "user", content: state.question },
    ],
    undefined,
    config.aiModel,
    false,
    "planNode",
  );

  const planText = plan.content ?? "（计划生成为空，直接开始浏览）";
  // 链全文打 debug：计划是 chain[0]，浏览每步的思维链都有对应日志，排查
  // 导航行为时可以完整复盘模型的思考轨迹。多行 content 原样输出不截断——
  // 截断的思考链没有排查价值（vision.ts 的 150 字截断是给"看一眼"用的，
  // 这里是给"逐环分析"用的，口径不同）。
  logger.debug("agent", `思维链[0/计划]: ${planText}`);
  return { chain: [planText] };
}

// 节点三：浏览决策。调用前把思维链拼成一条临时 system 消息附在 messages 末尾
// （只进本次调用、不进 state.messages：链文入库会让每轮一份越来越长的快照在
// 历史里滚雪球，且很难不破坏 assistant(tool_calls) 与 tool 结果消息的邻接——
// 临时注入附在末尾，天然永远在最后一组 tool 结果之后）。模型 content 承载思维链
// 的下一环（本步复盘+下一步指示，deep_browse 提示词强制），追加进 chain；
// content 为 null 时从 tool_calls 合成最小条目兜底——DeepSeek 带 tool_calls 时
// content 常为 null（提示词压不死），链永不间断。
async function browseLlm(state: DeepSearchStateT): Promise<DeepSearchUpdateT> {
  const messages = [...state.messages];
  if (state.chain.length > 0) {
    messages.push({
      role: "system",
      content: `[调研计划与进展]（这是你此前的思考记录，请延续它继续思考）\n${renderChainItems(state.chain)}`,
    });
  }

  // AbortError 兜底：/stop 拉闸时正在等的模型调用抛 AbortError，若不接住会炸穿
  // 整个 graph.invoke。接住后返回一个"无 tool_calls 的空响应"，条件边看到
  // interruptSignal.aborted 自然路由去 synthesize 优雅收尾。
  let response;
  try {
    response = await callModel(
      messages,
      toolSchemas(),
      config.aiModel,
      false,
      "browseLlm",
      state.interruptSignal ?? undefined,
    );
  } catch (error) {
    if (state.interruptSignal?.aborted) {
      logger.info("agent", "browseLlm 被 /stop 中断，转入收尾");
      return { messages: [{ role: "assistant", content: "（任务已中断）", tool_calls: undefined }] };
    }
    throw error;
  }

  const content = response.content ?? "";
  const stepNote =
    content.trim() !== "" ? content.trim() : synthesizeStepNote(response.tool_calls);

  // 链全文打 debug（与 planNode 的计划日志同一口径）：第 N 步的思维链在
  // LOG_LEVEL=debug 下完整可复盘，多行 content 原样输出。
  logger.debug("agent", `思维链[${state.chain.length + 1}]: ${stepNote}`);

  return {
    messages: [{ role: "assistant", content: response.content, tool_calls: response.tool_calls }],
    chain: [stepNote],
  };
}

// 思维链渲染成编号列表（注入和收尾共用）。chain[0] 恒为计划，标注（计划）前缀；
// 其余是各步的复盘/兜底条目。
function renderChainItems(chain: string[]): string {
  return chain.map((item, i) => `${i + 1}. ${i === 0 ? `（计划）${item}` : item}`).join("\n");
}

// content 为 null 时的兜底条目：只有动作没有判断（行车记录仪，不是方向盘），
// 有 content 时永远不用它。
function synthesizeStepNote(toolCalls: ChatMessage["tool_calls"]): string {
  if (toolCalls === undefined || toolCalls.length === 0) {
    return "（本步没有输出文字，也没有调用工具）";
  }
  const actions = toolCalls.map((call) => {
    let target = "";
    try {
      const args = JSON.parse(call.function.arguments) as Record<string, unknown>;
      if (typeof args.url === "string") target = args.url;
      else if (typeof args.link === "number") target = `link:${args.link}`;
    } catch {
      // 参数 JSON 解析失败就只报工具名
    }
    return target !== "" ? `${call.function.name}(${target})` : call.function.name;
  });
  return `（本步调用了 ${actions.join("、")}，未输出文字思考）`;
}

// 节点四：执行工具。open_page 并发（fetch 层同域队列兜底）、interact_page 自动串行
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
      const result = await runTool(call.function.name, args, state.ctx);
      return { role: "tool", content: result, tool_call_id: call.id };
    }),
  );

  return { messages: toolMessages, turnCount: state.turnCount + 1 };
}

// 节点五：汇总报告。仿 loop.ts synthesizeFinalReply 的两条消息模式——
// system 放 deep_report 人设，user 只放动态内容（问题+起点+思维链+浏览记录）。
// 浏览记录给证据，思维链给意图脉络，报告模型两者都有。
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
  const chainText =
    state.chain.length > 0 ? renderChainItems(state.chain) : "（没有生成计划）";
  // 思维链的规模日志：链断了/没累计（ReducedValue 出问题）在这里一眼可见。
  logger.debug("agent", `synthesize 收尾：思维链 ${state.chain.length} 条（1 计划 + ${Math.max(state.chain.length - 1, 0)} 步）`);

  const final = await callModel(
    [
      { role: "system", content: getSystemPrompt(state.ctx.event, "deep_report") },
      {
        role: "user",
        content: `用户的调研问题是：${state.question}\n\n调研起点材料：\n${startMaterial}\n\n调研计划与逐步进展（思维链）：\n${chainText}\n\n调研过程中的浏览记录：\n${browseLog || "（没有浏览记录）"}\n\n请基于以上材料撰写最终调研报告。`,
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

// 路由零：planNode 之后。还有预算就开始浏览；预算已耗尽（预读/起点检索吃光预算的
// 极端情况，planNode 已跳过模型调用）直接收尾。
function afterPlan(state: DeepSearchStateT): "browseLlm" | "synthesize" {
  return Date.now() < state.deadline ? "browseLlm" : "synthesize";
}

// 路由一：browseLlm 之后。无 tool_calls（模型自认材料够了，输出的是材料小结）→ 收尾；
// 有 tool_calls 但预算耗尽 → 收尾（优雅降级，synthesize 拿部分材料照样能出报告）。
// /stop 拉闸 → 收尾：与预算耗尽同一条优雅降级路径，synthesze 拿已读材料出部分报告。
function afterBrowseLlm(state: DeepSearchStateT): "browseTools" | "synthesize" {
  if (state.interruptSignal?.aborted) return "synthesize";
  const lastMessage = state.messages[state.messages.length - 1];
  const hasToolCalls = lastMessage?.tool_calls !== undefined && lastMessage.tool_calls.length > 0;
  const budgetLeft = state.turnCount < config.browseMaxTurns && Date.now() < state.deadline;
  if (hasToolCalls && budgetLeft) return "browseTools";
  return "synthesize";
}

// 路由二：browseTools 之后。还有预算就回 browseLlm 看材料继续决策，没预算直接收尾。
function afterBrowseTools(state: DeepSearchStateT): "browseLlm" | "synthesize" {
  if (state.interruptSignal?.aborted) return "synthesize";
  const budgetLeft = state.turnCount < config.browseMaxTurns && Date.now() < state.deadline;
  return budgetLeft ? "browseLlm" : "synthesize";
}

const deepSearchGraph = new StateGraph(DeepSearchState)
  .addNode("searchNode", searchNode)
  .addNode("planNode", planNode)
  .addNode("browseLlm", browseLlm)
  .addNode("browseTools", browseTools)
  .addNode("synthesize", synthesize)
  .addEdge(START, "searchNode")
  .addEdge("searchNode", "planNode")
  .addConditionalEdges("planNode", afterPlan, ["browseLlm", "synthesize"])
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
  // /stop 中断挂载（拒绝并发语义，与 runAgentTurn 同款）：登记失败 = 该会话已有长流程。
  const flowKey = sessionKey(ctx.event);
  const controller = beginControlledFlow(flowKey);
  if (controller === null) {
    return "上一个任务还在跑哦～先发 /stop 停掉它，再重新发起吧。";
  }

  const { memoryKey, sqliteMemoryStore } = await importMemory();
  const key = memoryKey(ctx.event);

  try {
    const result = await deepSearchGraph.invoke({
      messages: [],
      chain: [],
      question,
      ctx,
      skipMemory: false,
      interruptSignal: controller.signal,
    });

    // 被 /stop 中断：拿部分材料出个简短的"已中断"说明（比静默更适合深检——
    // 用户可能想知道停在哪了），不落库（这条不是正式报告）。
    if (controller.signal.aborted) {
      return "";
    }

    const report = result.report ?? "（深度检索没有生成报告）";

    await sqliteMemoryStore.append(
      key,
      { openid: ctx.event.authorOpenid, name: ctx.event.authorName },
      { role: "user", content: `${ctx.event.authorName}：/深度检索 ${question}` },
      { role: "assistant", content: report },
    );
    return report;
  } finally {
    endControlledFlow(flowKey, controller);
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

  // 本地测试不挂中断注册表（不占用会话锁，/stop 也管不到测试进程），
  // signal 传 null：图内各节点对 null 容忍（可选链 + 默认不中断）。
  try {
    const result = await deepSearchGraph.invoke({
      messages: [],
      chain: [],
      question,
      ctx,
      skipMemory: true,
      interruptSignal: null,
    });
    return result.report ?? "（深度检索没有生成报告）";
  } finally {
    await releaseBrowser();
  }
}
