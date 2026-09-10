// agent/deep-search.ts —— 深度检索的编排层：一张独立的 StateGraph（总设计 §3.1）。
// 与日常 Agent 图（loop.ts）的关系：完全独立、零共享状态——loop.ts 一行不改，
// 日常 /Agent 行为不变；两张图各自有循环预算、提示词场景和记忆策略。
//
// 图结构（修订四：searchNode 单节点版，单行道）：
//   preflightNode → [有URL] planNode → browseLlm ⇄ browseTools → synthesize → END
//                  → [无URL] searchNode → planNode → ...
//
//   preflightNode 纯代码分流：提取 URL（≤5 个）并行预读成页面材料；无 URL 则
//                 设 hasStartUrls=false 交给条件边路由去 searchNode。设墙钟 deadline。
//   searchNode    检索词改写 + 单次搜索（flash 只看 search 一个工具 schema）：
//                 模型输出改写后的检索词 tool_calls（可并行 2~3 个）→ 代码并发执行
//                 webSearch → 结果拼进 startMaterial。一次结束不回环（修订三的
//                 planTools 自寻循环被否决：不要"搜完回计划再看要不要搜"）。
//   planNode      制定计划（flash，deep_plan 场景，无工具）：看过起点材料
//                 （预读页面或搜索结果）输出纯文本计划，写 chain[0]。
//   browseLlm     浏览决策（deep_browse 场景，三工具含 search——起点搜索失败时
//                 浏览阶段仍可自救补搜）：思维链注入 + 多轮深挖。
//   browseTools   执行浏览工具。turnCount 只统计浏览圈（searchNode 不耗轮次）。
//   synthesize    汇总报告（pro + thinking，deep_report 场景）。
//
// 修订轨迹：修订三（planTools 带三工具自寻起点循环）实测后否决——搜索过程不可
// 控且耗浏览轮次；修订四把"改写"与"搜索"合并进专职 searchNode，一次结束。
//
// 思维链（chain，plan & execute 的记忆体）：planNode 写计划，browseLlm 每轮追加
// 本步复盘。content 为 null 时从 tool_calls 合成最小条目兜底。只在 browseLlm 注入
// 和 synthesize 拼报告时读取，刻意不进 state.messages。
//
// A 档浏览器生命周期：runDeepSearch 用 try/finally 包住图调用，finally 里
// releaseBrowser()——一次深检请求一套浏览器，请求结束状态归零（总设计 §5.6）。

import { StateGraph, StateSchema, ReducedValue, START, END } from "@langchain/langgraph";
import { z } from "zod";
import { config } from "../config.js";
import type { MessageContext } from "../types.js";
import type { ChatMessage, ToolSchema } from "./types.js";
import { webSearch, formatSearchResults } from "../services/search.js";
import { callModel } from "../services/model.js";
import { getSystemPrompt } from "../services/prompts/builder.js";
import { releaseBrowser } from "../services/browse/browser.js";
import { toolSchemas, runTool } from "./deep-search/registry.js";
import { loadPage } from "./tools/open-page.js";
import { searchTool } from "./tools/search.js";
import { emitProgress, subscribeProgress } from "../services/progress-bus.js";
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
  // preflightNode 装配的起点材料（URL 预读结果或空）。单独存字段而不是直接拼进
  // messages：planNode/browseLlm/synthesize 各自按需引用它，图内消息通道保持
  // "对话记录"的纯语义（preflight 的材料是环境输入，不是对话的一部分）。
  startMaterial: z.string().default(""),
  // preflight 分流标记：true = 用户给了 URL 且已预读，跳过 searchNode 直接进
  // planNode；false = 无 URL，先过 searchNode（flash 改写 + 单次搜索）。
  hasStartUrls: z.boolean().default(false),
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

// 节点零：preflight 分流（修订三，纯代码无模型）。有 URL → 并行预读成起点材料
// （不经模型转手，消灭"模型抄写 URL"的幻觉/丢字风险）；无 URL → 材料留空，
// 由 planNode 带三工具自寻起点。旧版的"Tavily 兜底/起点检索"整体移除——
// 起点检索移交 planTools（修订三的核心变更）。设墙钟 deadline（预读计入预算）。
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

async function preflightNode(state: DeepSearchStateT): Promise<DeepSearchUpdateT> {
  const deadline = Date.now() + config.browseTotalBudgetMs;
  const question = state.question.trim();
  const { urls, cleaned } = extractStartUrls(question);

  const parts: string[] = [];
  let hasStartUrls = false;
  if (urls.length > 0) {
    hasStartUrls = true;
    const { pages, failures } = await prefetchUrls(urls, state.ctx.event);
    if (pages.length > 0) {
      parts.push(`用户提供了起点网址，已直接读取页面内容如下：\n\n${pages.join("\n\n")}`);
    }
    if (failures.length > 0) {
      // 只注记失败：模型需要补充可以自己在浏览阶段 open_page/search（工具在浏览圈有）。
      parts.push(`以下网址无法访问，请勿再尝试打开：\n${failures.join("\n")}`);
    }
  }
  // 无 URL 不在此处理——条件边路由去 searchNode（flash 改写检索词 + 单次搜索）。

  // 问题本体（去掉 URL 后的文字）单独存：各节点引用 startMaterial 时都能拿到。
  return {
    startMaterial: `用户的调研问题是：${cleaned !== "" ? cleaned : question}${parts.length > 0 ? `\n\n${parts.join("\n\n")}` : ""}`,
    hasStartUrls,
    deadline,
  };
}

// searchNode 用的单工具 schema：只给模型看 search（从全局注册的 searchTool 取，
// 不走深检表——这个节点模型只该改写检索词，看见 open_page 反而可能跳过搜索）。
const SEARCH_ONLY_SCHEMA: ToolSchema[] = [{
  type: "function",
  function: {
    name: searchTool.name,
    description: searchTool.description,
    parameters: searchTool.parameters,
  },
}];

// 节点一：searchNode——检索词改写 + 单次搜索（修订四，一次结束不回环）。
// 流程：flash 只看 search schema → 输出 tool_calls（改写后的检索词，可能并行
// 2~3 个）→ 【代码】并发执行 webSearch → 结果拼进 startMaterial。与修订三
// （planTools 自寻起点循环）的关键差异：模型只策划检索词，不判断"够不够"、
// 不回流——搜完即走。轮次不消耗（turnCount 只统计浏览圈），墙钟已覆盖。
// 兜底链：模型没输出 tool_calls / 参数解析失败 → 拿原始问题直接搜一次；
// 全部搜索失败 → 材料注明"起点搜索失败"，planNode 拿着问题照样定计划，
// 浏览圈还有 search 工具可自救。
async function searchNode(state: DeepSearchStateT): Promise<DeepSearchUpdateT> {
  // 预算耗尽的极端情况：空过（planNode 对空材料也有兜底）
  if (Date.now() >= state.deadline) {
    return {};
  }

  const question = state.question.trim();

  // 第一步：flash 改写。AbortError 兜底与 browseLlm 同款（拉闸转收尾）。
  let response;
  try {
    response = await callModel(
      [
        { role: "system", content: getSystemPrompt(state.ctx.event, "deep_research") },
        { role: "user", content: question },
      ],
      SEARCH_ONLY_SCHEMA,
      config.aiModel,
      false,
      "searchNode",
      state.interruptSignal ?? undefined,
    );
  } catch (error) {
    if (state.interruptSignal?.aborted) {
      logger.info("agent", "searchNode 被 /stop 中断，转入收尾");
      return {};
    }
    throw error;
  }

  // 第二步：从 tool_calls 提取检索词（模型可能并行给多个；不给就退回原问题）。
  const queries: string[] = [];
  for (const call of response.tool_calls ?? []) {
    if (call.function.name !== "search") continue;
    try {
      const args = JSON.parse(call.function.arguments) as Record<string, unknown>;
      if (typeof args.query === "string" && args.query.trim() !== "") {
        queries.push(args.query.trim());
      }
    } catch {
      // 单个参数解析失败跳过，不影响其它检索词
    }
  }
  if (queries.length === 0) {
    queries.push(question);
    logger.debug("agent", `searchNode 模型未输出检索词，退回原问题直搜`);
  }
  logger.debug("agent", `searchNode 检索词改写: ${queries.join(" | ")}`);

  // 第三步：并发执行（allSettled——部分失败是常态，网络抖动不该全灭）。
  const settled = await Promise.allSettled(queries.map((q) => webSearch(q)));
  const blocks: string[] = [];
  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i];
    if (outcome.status === "fulfilled" && outcome.value.length > 0) {
      blocks.push(formatSearchResults(outcome.value));
    } else if (outcome.status === "rejected") {
      const reason = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
      logger.warn("search", `searchNode 起点检索失败 "${queries[i]}": ${reason.slice(0, 150)}`);
    }
  }

  const searchPart = blocks.length > 0
    ? `\n\n以下是起点搜索得到的材料（标题+摘要+链接）：\n${blocks.join("\n\n")}`
    : "\n\n（起点搜索没有结果。可以在浏览阶段用 search 工具换个检索词重试，或用 open_page 打开搜索引擎结果页如 https://www.bing.com/search?q=问题关键词 ）";

  return { startMaterial: `${state.startMaterial}${searchPart}` };
}

// 节点二：planNode——制定计划（无工具，纯文本方向）。
// 输入 = startMaterial（URL 预读页面 或 searchNode 的搜索结果），输出写 chain[0]。
// 不计入 turnCount（不是浏览轮次，墙钟预算覆盖耗时）。检索已由 searchNode 完成，
// 这里只做"看过材料定方向"。
async function planNode(state: DeepSearchStateT): Promise<DeepSearchUpdateT> {
  // 预算已耗尽（预读/起点搜索吃光预算的极端情况）：跳过模型调用，交给条件边直接收尾
  if (Date.now() >= state.deadline) {
    return { chain: [] };
  }

  // 进度推送（走 progress-bus：节点没有 runTool 切面，直接 emit——订阅由
  // runDeepSearch 挂载，群/私聊分支和失败兜底都在 bus 内部，节点只声明"发生了什么"）。
  emitProgress(state.ctx.event, "---正在规划路线---");

  const plan = await callModel(
    [
      { role: "system", content: getSystemPrompt(state.ctx.event, "deep_plan") },
      { role: "user", content: state.startMaterial },
    ],
    undefined,
    config.aiModel,
    false,
    "planNode",
    state.interruptSignal ?? undefined,
  );

  const planText = plan.content ?? "（计划生成为空，直接开始浏览）";
  // 链全文打 debug：计划是 chain[0]，浏览每步的思维链都有对应日志，排查
  // 导航行为时可以完整复盘模型的思考轨迹。多行 content 原样输出不截断。
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
  // messages 通道在修订三后的语义：preflight 不再写 messages，第一条 user 消息
  // 由这里补（system: deep_browse + user: startMaterial），之后是 planTools 轮次
  // 留下的 assistant/tool 记录——浏览决策能看见计划阶段做过什么搜索。
  const messages: ChatMessage[] = [
    { role: "system", content: getSystemPrompt(state.ctx.event, "deep_browse") },
    { role: "user", content: state.startMaterial },
    ...state.messages,
  ];
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
  // 浏览记录：messages 全量（planTools/browseLlm 留下的 assistant/tool 消息，
  // 含计划阶段的自寻起点轮次——它们也是调研过程的一部分）。
  const browseLog = state.messages
    .map((msg) => {
      if (msg.role === "assistant") {
        return msg.tool_calls !== undefined
          ? `（浏览动作：${msg.tool_calls.map((c) => c.function.name).join("、")}）`
          : `助手材料小结：${msg.content ?? ""}`;
      }
      return `页面内容/工具结果：${msg.content ?? ""}`;
    })
    .join("\n\n");
  const chainText =
    state.chain.length > 0 ? renderChainItems(state.chain) : "（没有生成计划）";
  // 思维链的规模日志：链断了/没累计（ReducedValue 出问题）在这里一眼可见。
  logger.debug("agent", `synthesize 收尾：思维链 ${state.chain.length} 条（1 计划 + ${Math.max(state.chain.length - 1, 0)} 步）`);

  const final = await callModel(
    [
      { role: "system", content: getSystemPrompt(state.ctx.event, "deep_report") },
      {
        role: "user",
        content: `用户的调研问题是：${state.question}\n\n调研起点材料：\n${state.startMaterial}\n\n调研计划与逐步进展（思维链）：\n${chainText}\n\n调研过程中的浏览记录：\n${browseLog || "（没有浏览记录）"}\n\n请基于以上材料撰写最终调研报告。`,
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

// 路由零：preflightNode 之后。有 URL（已预读）直接进 planNode；
// 无 URL 先过 searchNode（flash 改写 + 单次搜索）再进 planNode。
function afterPreflight(state: DeepSearchStateT): "searchNode" | "planNode" {
  return state.hasStartUrls ? "planNode" : "searchNode";
}

// 路由零.五：planNode 之后。还有预算就开始浏览；预算已耗尽（预读/起点搜索吃光
// 预算的极端情况，planNode 已跳过模型调用）直接收尾。
function afterPlan(state: DeepSearchStateT): "browseLlm" | "synthesize" {
  if (state.interruptSignal?.aborted) return "synthesize";
  return Date.now() < state.deadline ? "browseLlm" : "synthesize";
}

// 路由一：browseLlm 之后。无 tool_calls（模型自认材料够了，输出的是材料小结）→ 收尾；
// 有 tool_calls 但预算耗尽 → 收尾（优雅降级，synthesize 拿部分材料照样能出报告）。
// /stop 拉闸 → 收尾：与预算耗尽同一条优雅降级路径，synthesize 拿已读材料出部分报告。
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
  .addNode("preflightNode", preflightNode)
  .addNode("searchNode", searchNode)
  .addNode("planNode", planNode)
  .addNode("browseLlm", browseLlm)
  .addNode("browseTools", browseTools)
  .addNode("synthesize", synthesize)
  .addEdge(START, "preflightNode")
  .addConditionalEdges("preflightNode", afterPreflight, ["searchNode", "planNode"])
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

  // 进度推送订阅（progress-bus，二期接入）：planNode 的"正在规划路线"和浏览循环
  // 里声明了 progressNote 的工具（search/open_page/interact_page，经 runTool 切面）
  // 的进度，都送到发起这次深检的会话。本地入口（runDeepSearchLocally）不挂订阅，
  // emit 到无订阅者是 no-op——测试输出不被推送污染。
  const unsubscribeProgress = subscribeProgress(ctx.event);

  try {
    const result = await deepSearchGraph.invoke({
      messages: [],
      chain: [],
      startMaterial: "",
      hasStartUrls: false,
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
    unsubscribeProgress();
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
      startMaterial: "",
      hasStartUrls: false,
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
