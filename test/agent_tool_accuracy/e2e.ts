// test/agent_tool_accuracy/e2e.ts —— Agent 工具调用准确率端到端评测脚本（方案.md §5）。
//
// 两种模式：
//   mock —— 在 fetch 层注入固定模型响应，跑同一张生产 LangGraph 图，验证：
//           捕获（原始 tool_calls/最终执行参数分开留证）、路由、两轮依赖、并发匹配、
//           评分器能识别预设错误。不访问任何网络，不需要真实 key，不计入模型准确率。
//   live —— 真实 DeepSeek 调用（--env-file=.env），fetch 透传仅旁路记录；
//           工具执行体全部换成替身（同名同 schema 同描述，run 返回 cases.json 的固定
//           toolResults），无 QQ 推送、无真实提醒、无真实搜索/抓取。
//
// 隔离（方案.md §5.2）：
//   - 长期记忆：MEMORY_DB_PATH=agent-eval-test.sqlite（独立文件，config 读取 env）。
//   - 短期记忆：sqlite.ts 的库路径写死为生产 data/memory.sqlite（无法 env 覆盖），
//     采用「键级隔离」——每次运行用唯一假 openid/groupOpenid（eval-<case>-<repeat>-<rand>），
//     与真实用户键永不碰撞；运行结束 sqliteMemoryStore.clear(key) 清掉本次写入。
//   - MCP：MCP_CONFIG_PATH 指向不存在的文件 → loadMcpConfig 返回空，MCP 层不启用。
//   - QQ：不 import webhook/handler；进度推送只在工具声明 progressNote 时触发，
//     替身不声明 → 无任何 QQ 外呼；mock 模式下非 DeepSeek 的外呼直接抛错兜底。
//
// 运行（项目根目录）：
//   npx tsx test/agent_tool_accuracy/e2e.ts --mode mock
//   npx tsx --env-file=.env test/agent_tool_accuracy/e2e.ts --mode live --limit 5
//   npx tsx --env-file=.env test/agent_tool_accuracy/e2e.ts --mode live --repeat 3

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Tool } from "../../src/agent/tool.js";
import type { MessageContext } from "../../src/types.js";
import type { BotEvent } from "../../src/events/registry.js";
import type { ChatMessage } from "../../src/agent/types.js";
import {
  scoreCase,
  aggregate,
  renderSummaryMarkdown,
  TOOL_SCHEMAS,
  type CaseVerdict,
  type TestCase,
  type ToolCallRecord,
  type ArgRule,
} from "./score.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");

// ---------- CLI ----------

interface CliOpts {
  mode: "mock" | "live";
  caseIds: string[];
  category: string | null;
  limit: number | null;
  repeat: number;
  judge: boolean;
}

function parseArgs(argv: string[]): CliOpts {
  const opts: CliOpts = { mode: "mock", caseIds: [], category: null, limit: null, repeat: 1, judge: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--mode": opts.mode = (argv[++i] === "live" ? "live" : "mock"); break;
      case "--case": opts.caseIds.push(argv[++i]); break;
      case "--category": opts.category = argv[++i] ?? null; break;
      case "--limit": opts.limit = Number(argv[++i]); break;
      case "--repeat": opts.repeat = Math.max(1, Number(argv[++i]) || 1); break;
      case "--judge": opts.judge = argv[++i] !== "off"; break;
      default: throw new Error(`未知参数 ${a}（可用：--mode mock|live --case id --category name --limit n --repeat n --judge on|off）`);
    }
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

// ---------- 环境变量：必须在任何生产模块 import 之前设置 ----------
// config.ts 在模块加载时读 env 并校验必填项；测试专用值只补缺（live 模式的真实
// AI_API_KEY 由 --env-file=.env 提供，优先保留）。

if (opts.mode === "live" && (process.env.AI_API_KEY ?? "") === "") {
  console.error("live 模式需要真实 AI_API_KEY：npx tsx --env-file=.env test/agent_tool_accuracy/e2e.ts --mode live ...");
  process.exit(1);
}
process.env.QQ_BOT_APP_ID ??= "eval-dummy";
process.env.QQ_BOT_APP_SECRET ??= "eval-dummy";
process.env.AI_API_KEY ??= "eval-dummy";
process.env.TAVILY_API_KEY ??= "eval-dummy";
process.env.EMBEDDING_API_KEY ??= "eval-dummy";
process.env.MEMORY_DB_PATH ??= "agent-eval-test.sqlite";
process.env.MCP_CONFIG_PATH = "__eval_no_mcp__.json"; // 不存在 → MCP 层不启用
process.env.LOG_DETAIL ??= "off"; // 不写文件日志（评测轨迹自己落盘）
process.env.LOG_LEVEL ??= "warn";

// ---------- fetch 拦截（装好后才动态 import 生产模块） ----------
// DeepSeek 请求旁路记录：请求体（是否带 tools / 发了哪些工具）+ 响应 message
// （content + 原始 tool_calls，arguments 保持字符串原样）。带 tools 的请求即一轮
// llmCall——收到请求时 round+1，替身执行时读当前 round，即得「第几轮的调用」。

interface ModelCallRecord {
  model: string;
  hadTools: boolean;
  toolNamesSent: string[];
  messageCount: number;
  userPreview: string; // 最后一条 user 消息前 80 字（排查用，不落全量正文）
  // 响应（mock 为脚本注入，live 为透传时 clone 读出）
  content: string | null;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  ok: boolean;
  error: string | null;
  judging: boolean; // live 模式的 semantic judge 请求（不计轮次、单列统计）
}

interface ExecutionRecord {
  name: string;
  finalArgs: Record<string, unknown>;
  round: number;
}

const harness = {
  round: 0,
  judging: false,
  modelCalls: [] as ModelCallRecord[],
  executions: [] as ExecutionRecord[],
  activeToolResults: {} as Record<string, string>,
  mockQueue: [] as ChatMessage[],
  externalRequests: 0,
  reset(toolResults: Record<string, string>, mockResponses: ChatMessage[]): void {
    this.round = 0;
    this.modelCalls = [];
    this.executions = [];
    this.activeToolResults = toolResults;
    this.mockQueue = [...mockResponses];
    this.externalRequests = 0;
  },
};

const DEEPSEEK_MARK = "api.deepseek.com";
const EMBEDDING_MARK = "open.bigmodel.cn"; // prepareContext 长期召回：空库也会先 embed query
const realFetch = globalThis.fetch;

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : String(input);
  if (!url.includes(DEEPSEEK_MARK)) {
    if (url.includes(EMBEDDING_MARK)) {
      // mock：返回固定向量（不联网）——测试库为空，候选为 0，向量内容不影响检索结果；
      // live：透传真实 embedding 请求（.env 的 EMBEDDING_API_KEY），费用可忽略。
      if (opts.mode === "mock") {
        return new Response(
          JSON.stringify({ data: [{ embedding: new Array(8).fill(0) }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      harness.externalRequests++;
      return realFetch(input as Parameters<typeof realFetch>[0], init);
    }
    if (opts.mode === "mock") {
      throw new Error(`eval: mock 模式出现预期外的外部请求 ${url}（工具应已全部替换为替身）`);
    }
    harness.externalRequests++;
    return realFetch(input as Parameters<typeof realFetch>[0], init);
  }
  const body = JSON.parse(String(init?.body ?? "{}")) as {
    model?: string; messages?: ChatMessage[]; tools?: Array<{ function?: { name?: string } }>;
  };
  const hadTools = Array.isArray(body.tools) && body.tools.length > 0;
  const messages = body.messages ?? [];
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const record: ModelCallRecord = {
    model: body.model ?? "",
    hadTools,
    toolNamesSent: (body.tools ?? []).map((t) => t.function?.name ?? "?"),
    messageCount: messages.length,
    userPreview: (lastUser?.content ?? "").slice(0, 80),
    content: null,
    toolCalls: [],
    ok: false,
    error: null,
    judging: harness.judging,
  };
  if (hadTools && !harness.judging) harness.round++;
  harness.modelCalls.push(record);

  if (opts.mode === "mock") {
    const next = harness.mockQueue.shift();
    if (next === undefined) {
      record.error = "mock 响应队列耗尽";
      throw new Error("eval: mock 响应队列耗尽（fixture 未覆盖全部模型调用）");
    }
    record.ok = true;
    record.content = next.content ?? null;
    record.toolCalls = (next.tool_calls ?? []).map((c) => ({
      id: c.id,
      name: c.function.name,
      arguments: c.function.arguments,
    }));
    return new Response(JSON.stringify({ choices: [{ message: next }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const response = await realFetch(input as Parameters<typeof realFetch>[0], init);
  if (!response.ok) {
    record.error = `HTTP ${response.status}: ${(await response.text()).slice(0, 150)}`;
    return response;
  }
  const data = (await response.clone().json()) as {
    choices?: Array<{ message?: ChatMessage }>;
  };
  const message = data.choices?.[0]?.message;
  if (message !== undefined) {
    record.ok = true;
    record.content = message.content ?? null;
    record.toolCalls = (message.tool_calls ?? []).map((c) => ({
      id: c.id,
      name: c.function.name,
      arguments: c.function.arguments,
    }));
  } else {
    record.error = "响应缺 message 字段";
  }
  return response;
}) as typeof fetch;

// ---------- 生产模块加载（在 fetch 拦截与 env 就绪之后） ----------

const { runAgentTurn } = await import("../../src/agent/loop.js");
const { registerTool } = await import("../../src/agent/registry.js");
await import("../../src/services/agent.js"); // 副作用：注册 8 个生产工具
const { sqliteMemoryStore } = await import("../../src/agent/memory/sqlite.js");
const { tenantKey } = await import("../../src/session/key.js");
const { callModel } = await import("../../src/services/model.js");
const { setReminderTool } = await import("../../src/agent/tools/set-reminder.js");
const { searchTool } = await import("../../src/agent/tools/search.js");
const { addMemoryTool } = await import("../../src/agent/tools/add-memory.js");
const { deleteMemoryTool } = await import("../../src/agent/tools/delete-memory.js");
const { clearAllMemoriesTool } = await import("../../src/agent/tools/clear-all-memories.js");
const { agentOpenPageTool } = await import("../../src/agent/tools/open-page.js");
const { getTimeTool } = await import("../../src/agent/tools/get-time.js");
const { recallMemoryTool } = await import("../../src/agent/tools/recall-memory.js");

// 工具替身：名称/描述/参数 schema 全部沿用生产定义（模型看到的工具表不变），
// 只替换 run——记录注入后的最终执行参数，返回 cases.json 配置的固定结果。
// progressNote 一律去掉（不触发进度推送 → 无 QQ 外呼）；skipMemory 保留
// （recall_memory 的落库豁免属于 Runtime 语义，评测照走）。
const productionTools: Tool[] = [
  setReminderTool, searchTool, addMemoryTool, deleteMemoryTool,
  clearAllMemoriesTool, agentOpenPageTool, getTimeTool, recallMemoryTool,
];
for (const tool of productionTools) {
  registerTool({
    ...tool,
    progressNote: undefined,
    run: async (args) => {
      harness.executions.push({ name: tool.name, finalArgs: args, round: harness.round });
      return harness.activeToolResults[tool.name] ?? `（评测替身：${tool.name} 未配置固定结果）`;
    },
  });
}

// ---------- 用例驱动 ----------

interface CaseFile {
  id: string;
  category: string;
  description: string;
  input: string;
  context: { scene: "c2c" | "group"; authorName: string };
  historySeed: Array<{ role: "user" | "assistant"; content: string }>;
  expected: { shouldCallTools: boolean; paths: Array<Array<{ tool: string; round: number }>> };
  argumentRules: ArgRule[];
  toolResults: Record<string, string>;
  notes: string;
}

function loadCases(): CaseFile[] {
  return JSON.parse(readFileSync(join(__dirname, "cases.json"), "utf8")) as CaseFile[];
}

function buildEvent(c: CaseFile, runTag: string): BotEvent {
  if (c.context.scene === "group") {
    return {
      type: "GROUP_AT_MESSAGE_CREATE",
      content: `/Agent ${c.input}`,
      attachments: [],
      groupOpenid: `group-eval-${runTag}`,
      authorOpenid: `eval-${runTag}`,
      authorRole: null,
      authorName: c.context.authorName,
      msgId: `msg-eval-${runTag}`,
    };
  }
  return {
    type: "C2C_MESSAGE_CREATE",
    content: `/Agent ${c.input}`,
    attachments: [],
    authorOpenid: `eval-${runTag}`,
    authorName: c.context.authorName,
    msgId: `msg-eval-${runTag}`,
  };
}

// 轨迹拼装：模型原始 tool_calls（按 llmCall 轮次）↔ 替身执行记录（同名+同轮按序配对）。
function buildToolCallRecords(): ToolCallRecord[] {
  const records: ToolCallRecord[] = [];
  let llmRound = 0;
  for (const call of harness.modelCalls) {
    if (!call.hadTools || call.judging) continue;
    llmRound++;
    for (const tc of call.toolCalls) {
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(tc.arguments) as Record<string, unknown>;
      } catch {
        parsed = null;
      }
      // 执行配对：同轮同名、按出现顺序消费（toolsNode 顺序发起，替身同步记录）
      const execIdx = harness.executions.findIndex(
        (e) => e.round === llmRound && e.name === tc.name,
      );
      const exec = execIdx === -1 ? null : harness.executions[execIdx];
      if (execIdx !== -1) harness.executions.splice(execIdx, 1);
      records.push({
        id: tc.id,
        name: tc.name,
        round: llmRound,
        rawArguments: tc.arguments,
        parsed,
        executedArgs: exec?.finalArgs ?? null,
        result: exec !== null ? harness.activeToolResults[tc.name] ?? "（评测替身）" : null,
      });
    }
  }
  return records;
}

interface RunTrajectory {
  caseId: string;
  repeat: number;
  input: string;
  reply: string | null;
  infraError: string | null;
  llmCalls: ModelCallRecord[];
  externalRequests: number;
  toolCalls: ToolCallRecord[];
  durationMs: number;
}

async function runOneCase(
  c: CaseFile,
  repeat: number,
  mockResponses: ChatMessage[],
): Promise<RunTrajectory> {
  const runTag = `${c.id}-r${repeat}-${Math.random().toString(36).slice(2, 8)}`;
  const event = buildEvent(c, runTag);
  const ctx: MessageContext = {
    event,
    text: `/Agent ${c.input}`,
    command: "Agent",
    args: c.input,
  };
  const key = tenantKey(event); // c2c:eval-… / group:group-eval-…，均带唯一 runTag
  harness.reset(c.toolResults, mockResponses);

  // 历史种子：走生产写入路径（带 speaker 前缀的口径由 runAgentTurn 读取时自行处理）
  if (c.historySeed.length > 0) {
    await sqliteMemoryStore.append(
      key,
      { openid: event.authorOpenid, name: event.authorName },
      ...c.historySeed,
    );
  }

  const startedAt = Date.now();
  let reply: string | null = null;
  let infraError: string | null = null;
  try {
    reply = await runAgentTurn(c.input, ctx, []);
  } catch (error) {
    infraError = error instanceof Error ? error.message : String(error);
  } finally {
    await sqliteMemoryStore.clear(key); // 清掉本次写入（种子 + 本轮消息）
  }

  return {
    caseId: c.id,
    repeat,
    input: c.input,
    reply,
    infraError,
    llmCalls: harness.modelCalls,
    externalRequests: harness.externalRequests,
    toolCalls: buildToolCallRecords(),
    durationMs: Date.now() - startedAt,
  };
}

// ---------- semantic judge（live 模式） ----------
// 一次独立模型调用批量判一个用例的全部 semantic 断言；失败不影响确定性指标，
// 相关规则保持 pending 并计数。

const JUDGE_PROMPT_HEAD = `你是参数质量评审。下面每条断言给出工具、字段、要求（hint）、模型的生成值和用户原话，
请判断生成值是否满足要求。语义等价即可算通过（如「十分钟后」的 description 写「拿快递」或「去阳台取快递」都算）。
只输出一个 JSON 数组，每项形如 {"i":<序号>,"pass":true|false,"reason":"一句话理由"}，不要输出其他文字。

`;

async function judgeSemantic(
  c: CaseFile,
  calls: ToolCallRecord[],
): Promise<(rule: ArgRule, call: ToolCallRecord) => "pass" | "fail" | null> {
  const pending: Array<{ rule: ArgRule; call: ToolCallRecord }> = [];
  const pairs = pairCallsForJudge(c, calls);
  for (const rule of c.argumentRules) {
    if (rule.rule !== "semantic") continue;
    for (const call of pairs.filter((p) => p.name === rule.tool)) {
      pending.push({ rule, call });
    }
  }
  if (pending.length === 0) return () => null;
  const lines = pending.map((p, i) => {
    const value = p.call.parsed?.[p.rule.field];
    return `断言 ${i}：工具 ${p.rule.tool} 的字段 ${p.rule.field}，要求：${p.rule.hint ?? ""}\n  生成值：${JSON.stringify(value ?? null)}\n  用户原话：${c.input}`;
  });
  const results = new Map<string, "pass" | "fail">();
  try {
    harness.judging = true;
    const response = await callModel(
      [{ role: "user", content: JUDGE_PROMPT_HEAD + lines.join("\n\n") }],
      undefined,
      undefined,
      false,
      "eval:judge",
    );
    harness.judging = false;
    const text = response.content ?? "";
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start !== -1 && end > start) {
      const parsed = JSON.parse(text.slice(start, end + 1)) as Array<{ i?: number; pass?: boolean }>;
      for (let i = 0; i < pending.length; i++) {
        const item = parsed.find((p) => p.i === i);
        if (item?.pass === true) results.set(judgeKey(pending[i].rule, pending[i].call), "pass");
        else if (item?.pass === false) results.set(judgeKey(pending[i].rule, pending[i].call), "fail");
      }
    }
  } catch {
    harness.judging = false; // judge 失败 → 全部维持 pending
  }
  return (rule, call) => results.get(judgeKey(rule, call)) ?? null;
}

function judgeKey(rule: ArgRule, call: ToolCallRecord): string {
  return `${rule.tool}.${rule.field}.${call.id}`;
}

// judge 用的「该工具的候选调用」= 与金标同轮同名的生成调用（复用 score 的配对语义，
// 但这里独立实现轻量版，避免循环依赖 score 内部函数）。
function pairCallsForJudge(c: CaseFile, calls: ToolCallRecord[]): ToolCallRecord[] {
  const wanted: Array<{ tool: string; round: number }> = [];
  const path = c.expected.paths[0] ?? [];
  for (const step of path) wanted.push(step);
  const remaining = [...calls];
  const picked: ToolCallRecord[] = [];
  for (const w of wanted) {
    const idx = remaining.findIndex((r) => r.round === w.round && r.name === w.tool);
    if (idx !== -1) {
      picked.push(remaining[idx]);
      remaining.splice(idx, 1);
    }
  }
  return picked.length > 0 ? picked : calls; // 选择失败时对该工具全部生成调用做 judge（诊断价值）
}

// ---------- mock 自检（fixtures 内置，验证链路与评分器） ----------

interface MockFixture {
  name: string;
  case: CaseFile;
  responses: ChatMessage[]; // 按模型请求顺序弹出（含 plainReply/finalize 的纯文本响应）
  semantic?: Record<string, "pass" | "fail">; // key `${tool}.${field}`（简单声明式 judge）
  expect: {
    selectionPass: boolean;
    jsonValid: number;
    jsonTotal: number;
    schemaValid: number;
    schemaTotal: number;
    ruleFail?: Array<string>; // 期望判 fail 的 `${tool}.${field}.${rule}` 键
    rulePending?: Array<string>; // 期望 pending 的 `${tool}.${field}` 键
  };
}

function assistantMsg(partial: {
  content?: string | null;
  toolCalls?: Array<{ id: string; name: string; args: string }>;
}): ChatMessage {
  return {
    role: "assistant",
    content: partial.content ?? null,
    tool_calls: partial.toolCalls?.map((t) => ({
      id: t.id,
      type: "function" as const,
      function: { name: t.name, arguments: t.args },
    })),
  };
}

const FIXED_TIME = '{"datetime":"2026-10-12T21:00:00+08:00","date":"2026-10-12","timezone":"Asia/Shanghai"}';

const FIXTURES: MockFixture[] = [
  {
    name: "纯闲聊不调工具（plainReply 路径）",
    case: {
      id: "mock-no-tool", category: "no_tool", description: "", input: "讲个笑话呗",
      context: { scene: "c2c", authorName: "测试用户" }, historySeed: [],
      expected: { shouldCallTools: false, paths: [] }, argumentRules: [], toolResults: {}, notes: "",
    },
    responses: [
      assistantMsg({ content: "（碎念：直接讲）" }),
      assistantMsg({ content: "好呀，来一个冷笑话～" }),
    ],
    expect: { selectionPass: true, jsonValid: 0, jsonTotal: 0, schemaValid: 0, schemaTotal: 0 },
  },
  {
    name: "单工具 get_time 正常调用（finalize 路径 + 轮次归属）",
    case: {
      id: "mock-get-time", category: "get_time", description: "", input: "现在几点了",
      context: { scene: "c2c", authorName: "测试用户" }, historySeed: [],
      expected: { shouldCallTools: true, paths: [[{ tool: "get_time", round: 1 }]] },
      argumentRules: [{ tool: "get_time", field: "*", rule: "empty_params" }],
      toolResults: { get_time: FIXED_TIME }, notes: "",
    },
    responses: [
      assistantMsg({ toolCalls: [{ id: "t1", name: "get_time", args: "{}" }] }),
      assistantMsg({ content: "（材料够了）" }),
      assistantMsg({ content: "现在是晚上 9 点～" }),
    ],
    expect: { selectionPass: true, jsonValid: 1, jsonTotal: 1, schemaValid: 1, schemaTotal: 1 },
  },
  {
    name: "非法 JSON arguments（回退 {} 仍执行，JSON/空参均判错）",
    case: {
      id: "mock-illegal-json", category: "get_time", description: "", input: "几点了",
      context: { scene: "c2c", authorName: "测试用户" }, historySeed: [],
      expected: { shouldCallTools: true, paths: [[{ tool: "get_time", round: 1 }]] },
      argumentRules: [{ tool: "get_time", field: "*", rule: "empty_params" }],
      toolResults: { get_time: FIXED_TIME }, notes: "",
    },
    responses: [
      assistantMsg({ toolCalls: [{ id: "t2", name: "get_time", args: "{oops" }] }),
      assistantMsg({ content: "（材料够了）" }),
      assistantMsg({ content: "现在 21 点。" }),
    ],
    expect: {
      selectionPass: true, jsonValid: 0, jsonTotal: 1, schemaValid: 0, schemaTotal: 1,
      ruleFail: ["get_time.*.empty_params"],
    },
  },
  {
    name: "未知工具名（schema 不合规 + 选择失败）",
    case: {
      id: "mock-unknown-tool", category: "search", description: "", input: "帮我搜下天气",
      context: { scene: "c2c", authorName: "测试用户" }, historySeed: [],
      expected: { shouldCallTools: true, paths: [[{ tool: "search", round: 1 }]] },
      argumentRules: [{ tool: "search", field: "query", rule: "semantic", hint: "含「天气」" }],
      toolResults: { search: "（结果）" }, notes: "",
    },
    responses: [
      assistantMsg({ toolCalls: [{ id: "t3", name: "web_search", args: '{"query":"北京天气"}' }] }),
      assistantMsg({ content: "（材料够了）" }),
      assistantMsg({ content: "（最终回复）" }),
    ],
    expect: {
      selectionPass: false, jsonValid: 1, jsonTotal: 1, schemaValid: 0, schemaTotal: 1,
      rulePending: ["search.query"],
    },
  },
  {
    name: "类型错误：seconds 传字符串（schema fail + exact fail）",
    case: {
      id: "mock-wrong-type", category: "set_reminder", description: "", input: "十分钟后提醒我喝水",
      context: { scene: "c2c", authorName: "测试用户" }, historySeed: [],
      expected: { shouldCallTools: true, paths: [[{ tool: "set_reminder", round: 1 }]] },
      argumentRules: [
        { tool: "set_reminder", field: "seconds", rule: "exact", value: 600 },
        { tool: "set_reminder", field: "description", rule: "semantic", hint: "含「喝水」" },
      ],
      toolResults: { set_reminder: "提醒已设置" }, notes: "",
    },
    responses: [
      assistantMsg({ toolCalls: [{ id: "t4", name: "set_reminder", args: '{"seconds":"600","description":"喝水"}' }] }),
      assistantMsg({ content: "（材料够了）" }),
      assistantMsg({ content: "设好啦。" }),
    ],
    expect: {
      selectionPass: true, jsonValid: 1, jsonTotal: 1, schemaValid: 0, schemaTotal: 1,
      ruleFail: ["set_reminder.seconds.exact"],
    },
    semantic: { "set_reminder.description": "pass" },
  },
  {
    name: "两轮依赖：open_page url → link=1（轮次匹配 + link 精确）",
    case: {
      id: "mock-two-turn", category: "two_turn", description: "", input: "打开页面再点第 1 条链接",
      context: { scene: "c2c", authorName: "测试用户" }, historySeed: [],
      expected: {
        shouldCallTools: true,
        paths: [[{ tool: "open_page", round: 1 }, { tool: "open_page", round: 2 }]],
      },
      argumentRules: [
        { tool: "open_page", field: "url", rule: "exact", value: "https://example.com/tech/roundup" },
        { tool: "open_page", field: "link", rule: "exact", value: 1 },
      ],
      toolResults: { open_page: "页面标题：测试。页面内链接：1. https://example.com/a 2. https://example.com/b" },
      notes: "",
    },
    responses: [
      assistantMsg({ toolCalls: [{ id: "t5", name: "open_page", args: '{"url":"https://example.com/tech/roundup"}' }] }),
      assistantMsg({ toolCalls: [{ id: "t6", name: "open_page", args: '{"link":1}' }] }),
      assistantMsg({ content: "（最终回复）" }),
    ],
    expect: { selectionPass: true, jsonValid: 2, jsonTotal: 2, schemaValid: 2, schemaTotal: 2 },
  },
  {
    name: "同轮并发两次 search（轮内无序多重集合匹配）",
    case: {
      id: "mock-concurrent", category: "multi_tool", description: "", input: "搜两个主题",
      context: { scene: "c2c", authorName: "测试用户" }, historySeed: [],
      expected: { shouldCallTools: true, paths: [[{ tool: "search", round: 1 }, { tool: "search", round: 1 }]] },
      argumentRules: [{ tool: "search", field: "query", rule: "semantic", hint: "与主题相关" }],
      toolResults: { search: "（结果）" }, notes: "",
    },
    responses: [
      assistantMsg({
        toolCalls: [
          { id: "t7", name: "search", args: '{"query":"新电影"}' },
          { id: "t8", name: "search", args: '{"query":"周末遛娃"}' },
        ],
      }),
      assistantMsg({ content: "（材料够了）" }),
      assistantMsg({ content: "两件事都查到啦。" }),
    ],
    expect: { selectionPass: true, jsonValid: 2, jsonTotal: 2, schemaValid: 2, schemaTotal: 2 },
    semantic: { "search.query": "pass" },
  },
  {
    name: "无参工具生成多余字段（empty_params fail + schema fail）",
    case: {
      id: "mock-extra-param", category: "hidden_param", description: "", input: "现在几点",
      context: { scene: "c2c", authorName: "测试用户" }, historySeed: [],
      expected: { shouldCallTools: true, paths: [[{ tool: "get_time", round: 1 }]] },
      argumentRules: [{ tool: "get_time", field: "*", rule: "empty_params" }],
      toolResults: { get_time: FIXED_TIME }, notes: "",
    },
    responses: [
      assistantMsg({ toolCalls: [{ id: "t9", name: "get_time", args: '{"timezone":"Asia/Shanghai"}' }] }),
      assistantMsg({ content: "（材料够了）" }),
      assistantMsg({ content: "21 点。" }),
    ],
    expect: {
      selectionPass: true, jsonValid: 1, jsonTotal: 1, schemaValid: 0, schemaTotal: 1,
      ruleFail: ["get_time.*.empty_params"],
    },
  },
];

async function runMockSelfCheck(): Promise<void> {
  console.log("=== mock 自检：固定模型响应跑生产 Runtime，验证捕获/路由/评分 ===\n");
  let allPass = true;
  for (const fixture of FIXTURES) {
    const trajectory = await runOneCase(fixture.case, 1, fixture.responses);
    const semanticJudge = (rule: ArgRule, call: ToolCallRecord): "pass" | "fail" | null => {
      void call;
      return fixture.semantic?.[`${rule.tool}.${rule.field}`] ?? null;
    };
    const verdict = scoreCase({
      testCase: fixture.case as TestCase,
      calls: trajectory.toolCalls,
      repeat: 1,
      infraError: trajectory.infraError,
      llmCalls: trajectory.llmCalls.filter((m) => !m.judging && m.hadTools).length,
      durationMs: trajectory.durationMs,
      semanticJudge,
    });
    const problems: string[] = [];
    if (trajectory.infraError !== null) problems.push(`infra: ${trajectory.infraError}`);
    if (verdict.selectionPass !== fixture.expect.selectionPass) {
      problems.push(`selectionPass=${verdict.selectionPass}（期望 ${fixture.expect.selectionPass}）`);
    }
    if (verdict.jsonValid !== fixture.expect.jsonValid || verdict.jsonTotal !== fixture.expect.jsonTotal) {
      problems.push(`json ${verdict.jsonValid}/${verdict.jsonTotal}（期望 ${fixture.expect.jsonValid}/${fixture.expect.jsonTotal}）`);
    }
    if (verdict.schemaValid !== fixture.expect.schemaValid || verdict.schemaTotal !== fixture.expect.schemaTotal) {
      problems.push(`schema ${verdict.schemaValid}/${verdict.schemaTotal}（期望 ${fixture.expect.schemaValid}/${fixture.expect.schemaTotal}）`);
    }
    for (const key of fixture.expect.ruleFail ?? []) {
      const hit = verdict.argChecks.find(
        (c) => `${c.tool}.${c.field}.${c.rule}` === key && (c.status === "fail" || c.status === "judged-fail"),
      );
      if (hit === undefined) problems.push(`规则 ${key} 未按预期判 fail（实际 ${verdict.argChecks.map((c) => `${c.tool}.${c.field}.${c.rule}:${c.status}`).join(" ")}）`);
    }
    for (const key of fixture.expect.rulePending ?? []) {
      const hit = verdict.argChecks.find((c) => `${c.tool}.${c.field}` === key && c.status === "pending");
      if (hit === undefined) problems.push(`规则 ${key} 未按预期 pending`);
    }
    const ok = problems.length === 0;
    allPass = allPass && ok;
    console.log(`${ok ? "PASS" : "FAIL"}  ${fixture.name}${ok ? "" : "\n      - " + problems.join("\n      - ")}`);
  }
  console.log("");
  if (!allPass) {
    console.error("mock 自检未全部通过，禁止进入 live 评测。");
    process.exit(1);
  }
  console.log("mock 自检全部通过：捕获、两轮路由、并发匹配与评分器工作正常。");
}

// ---------- live 评测主流程 ----------

async function runEvaluation(): Promise<void> {
  const all = loadCases();
  let selected = all;
  if (opts.caseIds.length > 0) selected = selected.filter((c) => opts.caseIds.includes(c.id));
  if (opts.category !== null) selected = selected.filter((c) => c.category === opts.category);
  if (opts.limit !== null) selected = selected.slice(0, opts.limit);
  if (selected.length === 0) {
    console.error("没有匹配的用例（检查 --case/--category/--limit）。");
    process.exit(1);
  }

  console.log(
    `=== live 评测：${selected.length} 个用例 × ${opts.repeat} 次 = ${selected.length * opts.repeat} 次运行 ===`,
  );
  console.log(`semantic judge：${opts.judge ? "开启（每用例一次额外模型调用）" : "关闭（semantic 记为未定）"}\n`);

  const trajectories: RunTrajectory[] = [];
  const verdicts: CaseVerdict[] = [];
  let done = 0;
  const total = selected.length * opts.repeat;
  for (const c of selected) {
    for (let r = 1; r <= opts.repeat; r++) {
      const trajectory = await runOneCase(c, r, []);
      const judge = opts.judge && trajectory.infraError === null
        ? await judgeSemantic(c, trajectory.toolCalls)
        : undefined;
      const verdict = scoreCase({
        testCase: c as TestCase,
        calls: trajectory.toolCalls,
        repeat: r,
        infraError: trajectory.infraError,
        llmCalls: trajectory.llmCalls.filter((m) => !m.judging && m.hadTools).length,
        durationMs: trajectory.durationMs,
        semanticJudge: judge,
      });
      trajectories.push(trajectory);
      verdicts.push(verdict);
      done++;
      const mark =
        verdict.infraError !== null ? "ERR"
        : verdict.jointPass === true ? "PASS"
        : verdict.jointPass === false ? "FAIL" : "UNSETTLED";
      console.log(`[${String(done).padStart(String(total).length, " ")}/${total}] ${mark}  ${c.id} (r${r}) ${trajectory.durationMs}ms`);
    }
  }

  // 报告落盘：reports/agent-eval-live-<时间戳>/
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outDir = join(ROOT, "test", "agent_tool_accuracy", "reports", `agent-eval-${opts.mode}-${timestamp}`);
  mkdirSync(outDir, { recursive: true });
  const jsonl = trajectories
    .map((t, i) => JSON.stringify({ trajectory: t, verdict: verdicts[i] }))
    .join("\n");
  writeFileSync(join(outDir, "trajectory.jsonl"), jsonl, "utf8");

  const metrics = aggregate(verdicts);
  const markdown = renderSummaryMarkdown(
    { mode: opts.mode, timestamp, judge: opts.judge },
    metrics,
    verdicts,
  );
  writeFileSync(join(outDir, "summary.md"), markdown, "utf8");

  console.log(`\n${markdown}`);
  console.log(`\n轨迹与报告已写入 ${join("test", "agent_tool_accuracy", "reports", `agent-eval-${opts.mode}-${timestamp}`)}`);
}

// ---------- 入口 ----------

if (opts.mode === "mock") {
  await runMockSelfCheck();
} else {
  await runEvaluation();
}
process.exit(0);
