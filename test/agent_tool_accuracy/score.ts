// test/agent_tool_accuracy/score.ts —— 评分器：纯函数，不依赖任何生产模块。
// 输入是 e2e.ts 捕获的轨迹（模型原始 tool_calls + 工具替身收到的最终执行参数），
// 输出用例级 verdict 与汇总指标。semantic 规则在这里只标 pending，结论由
// e2e.ts 的 judge 阶段（live 模式，一次独立模型调用批量判）或人工复核补充。
//
// 三个关键口径（与 方案.md §7 对齐）：
//   1. 工具选择按「轮次有序、轮内无序（多重集合）」匹配——同轮并发不能按完成顺序判，
//      重复调用也不能被集合去重隐藏。
//   2. 参数规则只作用于「与金标路径配对成功」的调用；生成错工具时参数无从评，
//      记 pending 并从分母剔除，不用参数指标掩盖选择错误。
//   3. forbidden / empty_params 作用于该工具的全部生成调用（无需路径命中）——
//      幻觉参数在任何路径下都是错误。

// ---------- 用例与轨迹的类型（与 cases.json 字段一一对应） ----------

export interface ToolStep {
  tool: string;
  round: number; // 1 或 2（Runtime MAX_TOOL_TURNS = 2）
}

export interface Expected {
  shouldCallTools: boolean;
  paths: ToolStep[][]; // 多条 path 为「或」关系；一条 path 内同轮并列 = 并发
  // 多解用例：true 时「不调用任何工具」也算选择通过（与 paths 任一命中为或关系）。
  // 用于金标存在「直接回答 / 检索降级」两种可接受行为的场景（如长期记忆未注入时）。
  allowNoTool?: boolean;
  // 宽松口径（金标修订 2026-10-13）：true 时匹配退化为「子序列覆盖」——
  // 生成调用（按发生顺序）按序覆盖金标 path 的全部工具即算通过；多出的调用
  // （get_time/重复 search/拆多次记忆等）与轮次先后都不判错。用于「危害小的
  // 过度调用」口径；漏调、调错工具仍判错。后续收紧口径删掉标记即可。
  allowExtraCalls?: boolean;
}

export type RuleKind =
  | "exact"
  | "type"
  | "range"
  | "regex"
  | "semantic"
  | "forbidden"
  | "optional_omitted_or_enum"
  | "empty_params";

export interface ArgRule {
  tool: string;
  field: string; // "*" 仅配合 empty_params 使用
  rule: RuleKind;
  // 字段所属轮次（可选）：同一工具跨两轮、各轮参数不同时（如 open_page round1 传
  // url、round2 传 link），用它把规则钉到具体一轮，避免 url 规则套到 round2 调用上。
  round?: number;
  value?: unknown;
  min?: number;
  max?: number;
  enum?: Array<string | number>;
  pattern?: string;
  hint?: string;
}

export interface TestCase {
  id: string;
  category: string;
  input: string;
  expected: Expected;
  argumentRules: ArgRule[];
}

// 单次工具调用的完整轨迹：模型原始输出 → 解析 → 实际执行。
export interface ToolCallRecord {
  id: string; // 模型返回的 tool_call id
  name: string;
  round: number; // 来自第几轮 llmCall 的响应（1-based）
  rawArguments: string; // 模型原始 arguments 字符串
  parsed: Record<string, unknown> | null; // JSON.parse 结果；null = 非法 JSON
  executedArgs: Record<string, unknown> | null; // 替身收到的最终参数（经注入器后）；null = 未执行
  result: string | null; // 替身返回文本；null = 未执行
}

// ---------- 生产工具 schema 的精简副本（仅用于 schema 合规性检查） ----------
// 字段清单与 src/agent/tools/*.ts 严格同源；评测器不能反向修改生产 schema。
// 新工具上线时在此补一份即可（多字段即失败的原则让遗漏很快暴露）。

interface SchemaField {
  type: "string" | "integer" | "number" | "boolean" | "array";
  enum?: unknown[];
  items?: { type: "string" }; // 仅 array 用
}

export const TOOL_SCHEMAS: Record<
  string,
  { properties: Record<string, SchemaField>; required: string[] }
> = {
  get_time: { properties: {}, required: [] },
  search: {
    properties: {
      query: { type: "string" },
      max_results: { type: "integer" },
      search_depth: { type: "string", enum: ["basic", "advanced"] },
    },
    required: ["query"],
  },
  open_page: {
    properties: { url: { type: "string" }, link: { type: "number" } },
    required: [],
  },
  set_reminder: {
    properties: { seconds: { type: "integer" }, description: { type: "string" } },
    required: ["seconds", "description"],
  },
  add_memory: { properties: { content: { type: "string" } }, required: ["content"] },
  delete_memory: { properties: { query: { type: "string" } }, required: ["query"] },
  clear_all_memories: { properties: {}, required: [] },
  recall_memory: {
    properties: { keywords: { type: "array", items: { type: "string" } } },
    required: ["keywords"],
  },
};

// ---------- 路径匹配 ----------

// 一轮内的调用名多重集合（排序后拼接，保留重复计数）。
function multiset(names: string[]): string {
  return [...names].sort().join("\u0000");
}

function roundsOf(steps: ToolStep[]): number[] {
  return [...new Set(steps.map((s) => s.round))].sort((a, b) => a - b);
}

// 在全部可接受 path 里找命中的那条；返回索引，未命中返回 null。
// 严格口径：生成调用的轮集合 === path 的轮集合，且每轮内工具名多重集合相等。
// 轮集合必须完全一致——path 只写了 round1 而模型拆成两轮，不算命中（歧义分支
// 需要写多条 path 表达，cases.json 的 multi_tool 类就是这么做的）。
// 宽松口径（allowExtraCalls）：改用 coversPath 的「子序列覆盖」——金标工具按序
// 都被覆盖即命中，多余调用与轮次先后不判错；漏调、调错工具仍不命中。
export function matchPaths(paths: ToolStep[][], calls: ToolCallRecord[], allowExtraCalls = false): number | null {
  for (let i = 0; i < paths.length; i++) {
    const path = paths[i];
    if (allowExtraCalls) {
      if (coversPath(path, calls)) return i;
      continue;
    }
    const callRounds = roundsOf(calls.map((c) => ({ tool: c.name, round: c.round })));
    const pathRounds = roundsOf(path);
    if (callRounds.length !== pathRounds.length || callRounds.some((r, j) => r !== pathRounds[j])) {
      continue;
    }
    const ok = pathRounds.every((r) => {
      const inRound = calls.filter((c) => c.round === r).map((c) => c.name);
      const want = path.filter((s) => s.round === r).map((s) => s.tool);
      return multiset(inRound) === multiset(want);
    });
    if (ok) return i;
  }
  return null;
}

// 覆盖模式匹配：生成调用按发生顺序（round 升序、轮内原序）能否按序覆盖 path 的
// 全部工具。path 按轮次分组（同轮并列 = 顺序无关的一袋工具）；对每一袋，在生成
// 序列的剩余部分里贪心找「凑齐整袋」的最小窗口——窗口里夹着的其他调用（get_time、
// 重复 search 等）视为无害多余调用放行；凑不齐即漏调，判不覆盖。
function coversPath(path: ToolStep[], calls: ToolCallRecord[]): boolean {
  const seq = [...calls].sort((a, b) => a.round - b.round).map((c) => c.name);
  // path 步按「连续同轮」分袋
  const bags: string[][] = [];
  let lastRound = -1;
  for (const step of path) {
    if (step.round !== lastRound || bags.length === 0) {
      bags.push([step.tool]);
      lastRound = step.round;
    } else {
      bags[bags.length - 1].push(step.tool);
    }
  }
  let cursor = 0;
  for (const bag of bags) {
    const need: Record<string, number> = {};
    for (const n of bag) need[n] = (need[n] ?? 0) + 1;
    let remaining = bag.length;
    const got: Record<string, number> = {};
    while (cursor < seq.length && remaining > 0) {
      const name = seq[cursor];
      cursor++;
      if ((need[name] ?? 0) > (got[name] ?? 0)) {
        got[name] = (got[name] ?? 0) + 1;
        remaining--;
      }
      // 窗口内其他调用：多余，跳过继续扩窗
    }
    if (remaining > 0) return false; // 剩余部分耗尽也没凑齐 → 漏调
  }
  return true;
}
// 算 precision/recall 用；selection 通过时恒等于 path 步数）。
function diagnosticMatches(path: ToolStep[], calls: ToolCallRecord[]): number {
  let matched = 0;
  for (const r of roundsOf(path)) {
    const gen: Record<string, number> = {};
    for (const c of calls.filter((c) => c.round === r)) gen[c.name] = (gen[c.name] ?? 0) + 1;
    const want: Record<string, number> = {};
    for (const s of path.filter((s) => s.round === r)) want[s.tool] = (want[s.tool] ?? 0) + 1;
    for (const [name, n] of Object.entries(want)) matched += Math.min(n, gen[name] ?? 0);
  }
  return matched;
}

// 金标步与生成调用的配对（selection 命中时使用；失败时取诊断交集最优的 path 做尽力配对）。
// 配对结果决定「参数规则作用在哪些生成调用上」。
export function pairCalls(
  paths: ToolStep[][],
  calls: ToolCallRecord[],
  matchedIndex: number | null,
): Array<{ step: ToolStep; call: ToolCallRecord }> {
  let path: ToolStep[] | null = null;
  if (matchedIndex !== null) {
    path = paths[matchedIndex];
  } else {
    let best = -1;
    for (const p of paths) {
      const m = diagnosticMatches(p, calls);
      if (m > best) {
        best = m;
        path = p;
      }
    }
  }
  if (path === null) return [];
  const pairs: Array<{ step: ToolStep; call: ToolCallRecord }> = [];
  const remaining = [...calls];
  for (const step of path) {
    const idx = remaining.findIndex((c) => c.round === step.round && c.name === step.tool);
    if (idx === -1) continue;
    pairs.push({ step, call: remaining[idx] });
    remaining.splice(idx, 1);
  }
  return pairs;
}

// ---------- 单项检查 ----------

export interface CheckResult {
  status: "pass" | "fail" | "pending";
  reason: string;
}

// schema 合规：未知工具 / 非法 JSON / 缺 required / 类型不符 / 枚举外取值 / 多余字段，任一即 fail。
export function checkSchema(name: string, parsed: Record<string, unknown> | null): CheckResult {
  const schema = TOOL_SCHEMAS[name];
  if (schema === undefined) return { status: "fail", reason: `未知工具 ${name}（不在注册表内）` };
  if (parsed === null) return { status: "fail", reason: "arguments 不是合法 JSON" };
  for (const key of Object.keys(parsed)) {
    if (!(key in schema.properties)) {
      return { status: "fail", reason: `多余字段 ${key}（schema 中不存在）` };
    }
  }
  for (const req of schema.required) {
    if (!(req in parsed)) return { status: "fail", reason: `缺少必填字段 ${req}` };
  }
  for (const [key, field] of Object.entries(schema.properties)) {
    const value = parsed[key];
    if (value === undefined) continue;
    if (field.type === "integer") {
      if (typeof value !== "number" || !Number.isInteger(value)) {
        return { status: "fail", reason: `字段 ${key} 应为整数，实际 ${JSON.stringify(value)}` };
      }
    } else if (field.type === "number") {
      if (typeof value !== "number") {
        return { status: "fail", reason: `字段 ${key} 应为数字，实际 ${JSON.stringify(value)}` };
      }
    } else if (field.type === "string") {
      if (typeof value !== "string") {
        return { status: "fail", reason: `字段 ${key} 应为字符串，实际 ${JSON.stringify(value)}` };
      }
    } else if (field.type === "array") {
      if (
        !Array.isArray(value) ||
        !value.every((v) => typeof v === "string" && v.trim() !== "")
      ) {
        return { status: "fail", reason: `字段 ${key} 应为非空字符串数组，实际 ${JSON.stringify(value)}` };
      }
    }
    if (field.enum !== undefined && !field.enum.includes(value)) {
      return { status: "fail", reason: `字段 ${key} 取值 ${JSON.stringify(value)} 不在枚举内` };
    }
  }
  return { status: "pass", reason: "" };
}

// 单条参数规则对一个生成调用的检查。semantic 一律 pending（结论由外部 judge 补）。
export function checkRuleOnCall(
  rule: ArgRule,
  call: ToolCallRecord,
): CheckResult {
  const parsed = call.parsed;
  switch (rule.rule) {
    case "exact": {
      if (parsed === null) return { status: "fail", reason: "arguments 非法 JSON，无法比对" };
      const actual = parsed[rule.field];
      if (actual === rule.value) return { status: "pass", reason: "" };
      return { status: "fail", reason: `期望 ${JSON.stringify(rule.value)}，实际 ${JSON.stringify(actual)}` };
    }
    case "range": {
      if (parsed === null) return { status: "fail", reason: "arguments 非法 JSON，无法比对" };
      const v = parsed[rule.field];
      if (typeof v !== "number" || !Number.isFinite(v)) {
        return { status: "fail", reason: `${rule.field} 应为数字，实际 ${JSON.stringify(v)}` };
      }
      if (v >= (rule.min ?? -Infinity) && v <= (rule.max ?? Infinity)) {
        return { status: "pass", reason: "" };
      }
      return { status: "fail", reason: `${rule.field}=${v} 超出 [${rule.min}, ${rule.max}]` };
    }
    case "regex": {
      if (parsed === null) return { status: "fail", reason: "arguments 非法 JSON，无法比对" };
      const v = parsed[rule.field];
      if (typeof v !== "string" || !new RegExp(rule.pattern ?? "").test(v)) {
        return { status: "fail", reason: `${rule.field}=${JSON.stringify(v)} 不匹配 ${rule.pattern}` };
      }
      return { status: "pass", reason: "" };
    }
    case "type": {
      if (parsed === null) return { status: "fail", reason: "arguments 非法 JSON，无法比对" };
      const v = parsed[rule.field];
      // 现用例中 type 只用于 recall_memory.keywords（string[]，工具描述限定 1~5 个）
      if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
        return { status: "fail", reason: `${rule.field} 应为字符串数组，实际 ${JSON.stringify(v)}` };
      }
      if (v.length < 1 || v.length > 5) {
        return { status: "fail", reason: `${rule.field} 长度 ${v.length}，应在 1~5` };
      }
      return { status: "pass", reason: "" };
    }
    case "optional_omitted_or_enum": {
      if (parsed === null) return { status: "fail", reason: "arguments 非法 JSON，无法比对" };
      const v = parsed[rule.field];
      if (v === undefined) return { status: "pass", reason: "省略可选字段" };
      if ((rule.enum ?? []).includes(v as string | number)) return { status: "pass", reason: "" };
      return { status: "fail", reason: `可选字段取值 ${JSON.stringify(v)} 不在 ${JSON.stringify(rule.enum)} 内` };
    }
    case "forbidden": {
      if (parsed === null) return { status: "fail", reason: "arguments 非法 JSON，无法比对" };
      if (rule.field in parsed) {
        return { status: "fail", reason: `生成了禁止字段 ${rule.field}=${JSON.stringify(parsed[rule.field])}` };
      }
      return { status: "pass", reason: "" };
    }
    case "empty_params": {
      if (parsed === null) return { status: "fail", reason: "arguments 非法 JSON，无法判定空参" };
      const keys = Object.keys(parsed);
      if (keys.length === 0) return { status: "pass", reason: "" };
      return { status: "fail", reason: `无参工具生成了字段：${keys.join("、")}` };
    }
    case "semantic":
      return { status: "pending", reason: rule.hint ?? "" };
  }
}

// ---------- 用例级评分 ----------

export interface ArgCheck {
  tool: string;
  field: string;
  rule: RuleKind;
  callId: string; // 关联的生成调用（tool_call id）
  value: unknown; // 该字段的生成值（未执行也记录原始值，供人工复核/judge）
  status: "pass" | "fail" | "pending" | "judged-pass" | "judged-fail";
  reason: string;
}

export interface CaseVerdict {
  caseId: string;
  repeat: number;
  category: string;
  expectedShouldCallTools: boolean;
  infraError: string | null;
  selectionPass: boolean | null; // null = 基础设施失败，无法评
  matchedPathIndex: number | null;
  generatedCalls: number;
  executedCalls: number;
  expectedCalls: number | null; // 命中 path 的步数；no_tool 为 0；selection 失败时为诊断 path 步数
  diagnosticMatchedCalls: number;
  jsonValid: number;
  jsonTotal: number;
  schemaValid: number;
  schemaTotal: number;
  argChecks: ArgCheck[];
  fieldPass: number;
  fieldFail: number;
  fieldPending: number; // semantic 未 judge / 无配对调用
  wholeCallArgPass: boolean | null; // 所有配对调用的全部规则通过（pending → null）
  jointPass: boolean | null; // 选择 + 参数全对（存在 pending → null）
  llmCalls: number;
  durationMs: number;
}

// semantic 判官回调：返回 "pass"/"fail"（judge 结论），null = 维持 pending。
// e2e.ts 的 judge 阶段实现它；mock 自检用 fixture 声明的期望值实现它。
export type SemanticJudge = (rule: ArgRule, call: ToolCallRecord) => "pass" | "fail" | null;

export function scoreCase(input: {
  testCase: TestCase;
  calls: ToolCallRecord[];
  repeat: number;
  infraError: string | null;
  llmCalls: number;
  durationMs: number;
  semanticJudge?: SemanticJudge;
}): CaseVerdict {
  const { testCase, calls, repeat, infraError, llmCalls, durationMs } = input;
  const semanticJudge = input.semanticJudge ?? (() => null);

  const jsonTotal = calls.length;
  const jsonValid = calls.filter((c) => c.parsed !== null).length;
  const schemaResults = calls.map((c) => ({ call: c, check: checkSchema(c.name, c.parsed) }));
  const schemaValid = schemaResults.filter((s) => s.check.status === "pass").length;

  const matchedPathIndex = matchPaths(testCase.expected.paths, calls, testCase.expected.allowExtraCalls === true);
  const noToolAccepted =
    !testCase.expected.shouldCallTools ||
    testCase.expected.allowNoTool === true ||
    testCase.expected.paths.length === 0;
  const selectionPass =
    infraError !== null
      ? null
      : testCase.expected.shouldCallTools
        ? matchedPathIndex !== null || (testCase.expected.allowNoTool === true && calls.length === 0)
        : calls.length === 0;
  void noToolAccepted;

  const pairs = pairCalls(testCase.expected.paths, calls, matchedPathIndex);
  const diagnosticMatchedCalls =
    matchedPathIndex !== null
      ? testCase.expected.paths[matchedPathIndex].length
      : Math.max(0, ...testCase.expected.paths.map((p) => diagnosticMatches(p, calls)), 0);
  const expectedCalls = testCase.expected.shouldCallTools
    ? (testCase.expected.paths[matchedPathIndex ?? 0]?.length ?? diagnosticMatchedCalls)
    : 0;

  // 参数规则检查：非 forbidden/empty_params 的规则 → 作用于该工具的配对调用；
  // forbidden/empty_params → 作用于该工具的全部生成调用。
  // 轮次限定：金标路径里该工具只在特定轮出现时（如 two_turn 的 open_page），规则只
  // 作用于同轮的配对调用——同一工具跨两轮时各轮参数不同（round1 传 url、round2 传
  // link），把 url 规则套到 round2 的调用上会产生假失败。
  const referencePath =
    testCase.expected.paths[matchedPathIndex ?? 0] ?? [];
  const roundsByTool = new Map<string, Set<number>>();
  for (const step of referencePath) {
    const set = roundsByTool.get(step.tool) ?? new Set<number>();
    set.add(step.round);
    roundsByTool.set(step.tool, set);
  }
  const argChecks: ArgCheck[] = [];
  for (const rule of testCase.argumentRules) {
    const globalScope =
      rule.rule === "forbidden" || rule.rule === "empty_params" || rule.field === "*";
    let targets: ToolCallRecord[];
    if (globalScope) {
      targets = calls.filter((c) => c.name === rule.tool);
    } else {
      const allowedRounds =
        rule.round !== undefined
          ? new Set([rule.round]) // 规则显式声明轮次：只作用该轮（优先级最高）
          : roundsByTool.get(rule.tool);
      targets = pairs
        .filter((p) => p.step.tool === rule.tool)
        .map((p) => p.call)
        .filter((c) => allowedRounds === undefined || allowedRounds.has(c.round));
    }
    if (targets.length === 0) {
      argChecks.push({
        tool: rule.tool,
        field: rule.field,
        rule: rule.rule,
        callId: "-",
        value: undefined,
        status: "pending",
        reason: "未生成该工具的可配对调用，参数无从评",
      });
      continue;
    }
    for (const call of targets) {
      let check = checkRuleOnCall(rule, call);
      if (check.status === "pending") {
        const judged = semanticJudge(rule, call);
        if (judged === "pass") check = { status: "pass", reason: `judge：${rule.hint ?? ""}` };
        else if (judged === "fail") check = { status: "fail", reason: `judge 判不满足：${rule.hint ?? ""}` };
      }
      argChecks.push({
        tool: rule.tool,
        field: rule.field,
        rule: rule.rule,
        callId: call.id,
        value: call.parsed?.[rule.field] ?? null,
        status: check.status === "pass"
          ? check.reason.startsWith(JUDGE_PASS_MARK)
            ? "judged-pass"
            : "pass"
          : check.status === "fail"
            ? check.reason.startsWith(JUDGE_FAIL_MARK)
              ? "judged-fail"
              : "fail"
            : "pending",
        reason: check.reason,
      });
    }
  }

  const fieldPass = argChecks.filter((c) => c.status === "pass" || c.status === "judged-pass").length;
  const fieldFail = argChecks.filter((c) => c.status === "fail" || c.status === "judged-fail").length;
  const fieldPending = argChecks.filter((c) => c.status === "pending").length;

  // 整调用参数：每个配对调用适用的全部规则（含作用于它的 forbidden）都必须 pass。
  const pairedCallIds = new Set(pairs.map((p) => p.call.id));
  const perCallChecks = new Map<string, ArgCheck[]>();
  for (const chk of argChecks) {
    if (chk.callId === "-") continue;
    const list = perCallChecks.get(chk.callId) ?? [];
    list.push(chk);
    perCallChecks.set(chk.callId, list);
  }
  let wholeCallArgPass: boolean | null = true;
  for (const callId of pairedCallIds) {
    const checks = perCallChecks.get(callId) ?? [];
    if (checks.length === 0) continue;
    if (checks.some((c) => c.status === "fail" || c.status === "judged-fail")) {
      wholeCallArgPass = false;
    } else if (checks.some((c) => c.status === "pending")) {
      wholeCallArgPass = null; // 存在未定 → 整调用参数未定
    }
  }
  if (pairs.length === 0 && testCase.expected.shouldCallTools) {
    wholeCallArgPass = null; // 无配对调用（选择失败）→ 参数维度未定
  }

  const jointPass =
    selectionPass === null || wholeCallArgPass === null
      ? null
      : selectionPass && wholeCallArgPass;

  return {
    caseId: testCase.id,
    repeat,
    category: testCase.category,
    expectedShouldCallTools: testCase.expected.shouldCallTools,
    infraError,
    selectionPass,
    matchedPathIndex,
    generatedCalls: calls.length,
    executedCalls: calls.filter((c) => c.executedArgs !== null).length,
    expectedCalls,
    diagnosticMatchedCalls,
    jsonValid,
    jsonTotal,
    schemaValid,
    schemaTotal: calls.length,
    argChecks,
    fieldPass,
    fieldFail,
    fieldPending,
    wholeCallArgPass,
    jointPass,
    llmCalls,
    durationMs,
  };
}

// judge 回调写进 reason 的标记前缀（区分确定性 pass 与 judged pass，报告可分开统计）。
const JUDGE_PASS_MARK = "judge：";
const JUDGE_FAIL_MARK = "judge 判不满足";

// ---------- 汇总指标 ----------

export interface Metrics {
  runsTotal: number;
  infraErrors: number;
  validRuns: number; // 参与准确率分母的有效运行数
  selectionPass: number;
  selectionFail: number;
  falseCallOpportunities: number; // 不应调用工具的运行数
  falseCallViolations: number;
  matchedCalls: number;
  generatedCalls: number;
  expectedCalls: number;
  jsonValid: number;
  jsonTotal: number;
  schemaValid: number;
  schemaTotal: number;
  fieldPass: number;
  fieldFail: number;
  fieldPending: number;
  wholeCallPass: number;
  wholeCallFail: number;
  wholeCallUnknown: number;
  jointPassCount: number;
  jointFailCount: number;
  jointUnknown: number;
  byCategory: Array<{
    category: string;
    runs: number;
    selectionPass: number;
    jointPass: number;
    jointUnknown: number;
  }>;
}

function rate(n: number, d: number): string {
  return d === 0 ? "N/A" : `${((n / d) * 100).toFixed(1)}%`;
}

export function aggregate(verdicts: CaseVerdict[]): Metrics {
  const valid = verdicts.filter((v) => v.infraError === null);
  const noTool = valid.filter((v) => !v.expectedShouldCallTools);
  const categories = [...new Set(verdicts.map((v) => v.category))];
  return {
    runsTotal: verdicts.length,
    infraErrors: verdicts.filter((v) => v.infraError !== null).length,
    validRuns: valid.length,
    selectionPass: valid.filter((v) => v.selectionPass === true).length,
    selectionFail: valid.filter((v) => v.selectionPass === false).length,
    falseCallOpportunities: noTool.length,
    falseCallViolations: noTool.filter((v) => v.generatedCalls > 0).length,
    matchedCalls: valid.reduce((s, v) => s + v.diagnosticMatchedCalls, 0),
    generatedCalls: verdicts.reduce((s, v) => s + v.generatedCalls, 0),
    expectedCalls: valid.reduce((s, v) => s + (v.expectedCalls ?? 0), 0),
    jsonValid: verdicts.reduce((s, v) => s + v.jsonValid, 0),
    jsonTotal: verdicts.reduce((s, v) => s + v.jsonTotal, 0),
    schemaValid: verdicts.reduce((s, v) => s + v.schemaValid, 0),
    schemaTotal: verdicts.reduce((s, v) => s + v.schemaTotal, 0),
    fieldPass: verdicts.reduce((s, v) => s + v.fieldPass, 0),
    fieldFail: verdicts.reduce((s, v) => s + v.fieldFail, 0),
    fieldPending: verdicts.reduce((s, v) => s + v.fieldPending, 0),
    wholeCallPass: valid.filter((v) => v.wholeCallArgPass === true).length,
    wholeCallFail: valid.filter((v) => v.wholeCallArgPass === false).length,
    wholeCallUnknown: valid.filter((v) => v.wholeCallArgPass === null).length,
    jointPassCount: valid.filter((v) => v.jointPass === true).length,
    jointFailCount: valid.filter((v) => v.jointPass === false).length,
    jointUnknown: valid.filter((v) => v.jointPass === null).length,
    byCategory: categories.map((category) => {
      const rows = verdicts.filter((v) => v.category === category);
      return {
        category,
        runs: rows.length,
        selectionPass: rows.filter((v) => v.selectionPass === true).length,
        jointPass: rows.filter((v) => v.jointPass === true).length,
        jointUnknown: rows.filter((v) => v.jointPass === null).length,
      };
    }),
  };
}

// ---------- 报告渲染 ----------

export function renderSummaryMarkdown(
  meta: { mode: string; timestamp: string; judge: boolean; model?: string },
  metrics: Metrics,
  verdicts: CaseVerdict[],
): string {
  const lines: string[] = [];
  lines.push(`# Agent 工具调用准确率评测报告`);
  lines.push("");
  lines.push(`- 模式：${meta.mode}${meta.mode === "live" ? `（模型：${meta.model ?? "见 .env"}）` : "（固定响应，仅验证链路与评分器）"}`);
  lines.push(`- 时间：${meta.timestamp}`);
  lines.push(`- semantic 判官：${meta.judge ? "模型 judge" : "关闭（semantic 记为未定）"}`);
  lines.push(`- 运行总数：${metrics.runsTotal}，有效：${metrics.validRuns}，基础设施失败：${metrics.infraErrors}`);
  lines.push("");
  lines.push(`## 指标总览`);
  lines.push("");
  lines.push(`| 指标 | 分子/分母 | 值 |`);
  lines.push(`| --- | --- | --- |`);
  const rows: Array<[string, number, number]> = [
    ["工具选择准确率", metrics.selectionPass, metrics.selectionPass + metrics.selectionFail],
    ["调用 precision（诊断口径）", metrics.matchedCalls, metrics.generatedCalls],
    ["调用 recall（诊断口径）", metrics.matchedCalls, metrics.expectedCalls],
    ["原始 JSON 合法率", metrics.jsonValid, metrics.jsonTotal],
    ["schema 合规率", metrics.schemaValid, metrics.schemaTotal],
    ["参数字段准确率", metrics.fieldPass, metrics.fieldPass + metrics.fieldFail],
    ["整调用参数准确率", metrics.wholeCallPass, metrics.wholeCallPass + metrics.wholeCallFail],
    ["联合成功率", metrics.jointPassCount, metrics.jointPassCount + metrics.jointFailCount],
  ];
  for (const [name, n, d] of rows) lines.push(`| ${name} | ${n}/${d} | ${rate(n, d)} |`);
  lines.push(
    `| 误调用率（不应调用的运行中生成了调用） | ${metrics.falseCallViolations}/${metrics.falseCallOpportunities} | ${rate(metrics.falseCallViolations, metrics.falseCallOpportunities)} |`,
  );
  lines.push("");
  lines.push(
    `未定（semantic 待判/无配对调用）：字段 ${metrics.fieldPending} 项，整调用 ${metrics.wholeCallUnknown} 次，联合 ${metrics.jointUnknown} 次。`,
  );
  lines.push("");
  lines.push(`## 分类统计`);
  lines.push("");
  lines.push(`| 类别 | 运行 | 选择通过 | 联合通过 | 联合未定 |`);
  lines.push(`| --- | --- | --- | --- | --- |`);
  for (const c of metrics.byCategory) {
    lines.push(`| ${c.category} | ${c.runs} | ${c.selectionPass} | ${c.jointPass} | ${c.jointUnknown} |`);
  }
  lines.push("");
  const failures = verdicts.filter(
    (v) => v.selectionPass === false || v.jointPass === false || v.infraError !== null,
  );
  lines.push(`## 失败与未定样例（${failures.length} 条）`);
  lines.push("");
  for (const v of failures.slice(0, 50)) {
    lines.push(`### ${v.caseId} (repeat ${v.repeat})`);
    if (v.infraError !== null) lines.push(`- 基础设施错误：${v.infraError}`);
    if (v.selectionPass === false) {
      lines.push(
        `- 工具选择不符：命中 path=${v.matchedPathIndex}，生成 ${v.generatedCalls} 个调用（期望 ${v.expectedCalls}，诊断匹配 ${v.diagnosticMatchedCalls}）`,
      );
    }
    const failed = v.argChecks.filter((c) => c.status === "fail" || c.status === "judged-fail");
    for (const f of failed) {
      lines.push(`- 参数不符 [${f.tool}.${f.field} ${f.rule}]：${f.reason}（生成值 ${JSON.stringify(f.value)}）`);
    }
    lines.push("");
  }
  if (failures.length > 50) lines.push(`（其余 ${failures.length - 50} 条见 trajectory JSONL）`);
  return lines.join("\n");
}
