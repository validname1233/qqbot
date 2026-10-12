// test/agent_tool_accuracy/rescore.ts —— 离线重判与合并（一次性分析工具，不调模型）。
// 用途：评分器修复（轮次限定/allowNoTool）后，对旧 trajectory.jsonl 重算 verdict；
// semantic judge 结论按 (caseId, callId, tool.field) 从旧 verdict 沿用，不重复调模型。
// 用法：
//   npx tsx test/agent_tool_accuracy/rescore.ts merge <旧报告目录> <重跑报告目录...> <输出目录>
//   npx tsx test/agent_tool_accuracy/rescore.ts rescore <报告目录>   （原地重判，输出到 <目录>-rescored）

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { scoreCase, aggregate, renderSummaryMarkdown, type CaseVerdict, type TestCase, type ToolCallRecord, type ArgRule } from "./score.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface Row {
  trajectory: {
    caseId: string;
    repeat: number;
    input: string;
    reply: string | null;
    infraError: string | null;
    llmCalls: unknown[];
    externalRequests: number;
    toolCalls: ToolCallRecord[];
    durationMs: number;
  };
  verdict: CaseVerdict;
}

function loadCases(): Map<string, TestCase & { argumentRules: ArgRule[] }> {
  const raw = JSON.parse(readFileSync(join(__dirname, "cases.json"), "utf8"));
  return new Map(raw.map((c: TestCase) => [c.id, c]));
}

function loadRows(dir: string): Row[] {
  return readFileSync(join(dir, "trajectory.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Row);
}

// judge 结论沿用表：仅当新旧行（caseId, repeat）一致且 callId 相同才可信。
function buildJudgeCarryover(rows: Row[]): Map<string, "pass" | "fail"> {
  const map = new Map<string, "pass" | "fail">();
  for (const { trajectory, verdict } of rows) {
    for (const chk of verdict.argChecks) {
      if (chk.status === "judged-pass") map.set(judgeKey(trajectory.caseId, trajectory.repeat, chk.callId, chk.tool, chk.field), "pass");
      else if (chk.status === "judged-fail") map.set(judgeKey(trajectory.caseId, trajectory.repeat, chk.callId, chk.tool, chk.field), "fail");
    }
  }
  return map;
}

function judgeKey(caseId: string, repeat: number, callId: string, tool: string, field: string): string {
  return `${caseId}|${repeat}|${callId}|${tool}.${field}`;
}

function rescoreRow(row: Row, cases: Map<string, TestCase & { argumentRules: ArgRule[] }>, carry: Map<string, "pass" | "fail">): Row {
  const testCase = cases.get(row.trajectory.caseId);
  if (testCase === undefined) return row; // mock fixture 等不在 cases.json 的行原样保留
  const verdict = scoreCase({
    testCase,
    calls: row.trajectory.toolCalls,
    repeat: row.trajectory.repeat,
    infraError: row.trajectory.infraError,
    llmCalls: Array.isArray(row.trajectory.llmCalls)
      ? row.trajectory.llmCalls.filter((m) => (m as { hadTools?: boolean; judging?: boolean }).hadTools === true && (m as { judging?: boolean }).judging !== true).length
      : 0,
    durationMs: row.trajectory.durationMs,
    semanticJudge: (rule, call) =>
      carry.get(judgeKey(row.trajectory.caseId, row.trajectory.repeat, call.id, rule.tool, rule.field)) ?? null,
  });
  return { trajectory: row.trajectory, verdict };
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === "rescore") {
  const dir = args[0];
  const rows = loadRows(dir);
  const carry = buildJudgeCarryover(rows);
  const cases = loadCases();
  const out = rescoreRows(rows, cases, carry);
  const outDir = dir.replace(/\/$/, "") + "-rescored";
  mkdirSync(outDir, { recursive: true });
  writeOut(outDir, out, "live");
  console.log(`重判完成：${out.length} 行 → ${outDir}`);
} else if (cmd === "merge") {
  const outDir = args[args.length - 1];
  const inputDirs = args.slice(0, -1);
  const cases = loadCases();
  // 每个 input 目录各自带一份 judge 沿用表；行覆盖时连同来源的 carry 一起切换——
  // rerun 行的 semantic 结论来自 rerun 自己的 verdict，主报告中同用例是 ERR 无结论。
  const perDir = inputDirs.map((dir) => {
    const rows = loadRows(dir);
    return { rows, carry: buildJudgeCarryover(rows) };
  });
  const merged = new Map<string, Row & { _carry?: Map<string, "pass" | "fail"> }>();
  for (const { rows, carry } of perDir) {
    for (const row of rows) {
      merged.set(`${row.trajectory.caseId}|${row.trajectory.repeat}`, { ...row, _carry: carry });
    }
  }
  const out: Row[] = [];
  for (const row of merged.values()) {
    const carry = row._carry ?? new Map<string, "pass" | "fail">();
    const { _carry, ...clean } = row;
    void _carry;
    out.push(rescoreRow(clean as Row, cases, carry));
  }
  mkdirSync(outDir, { recursive: true });
  writeOut(outDir, out, "live");
  console.log(`合并完成：${out.length} 行 → ${outDir}`);
} else {
  console.error("用法：rescore <目录> | merge <目录...> <输出目录>");
  process.exit(1);
}

function rescoreRows(rows: Row[], cases: Map<string, TestCase & { argumentRules: ArgRule[] }>, carry: Map<string, "pass" | "fail">): Row[] {
  return rows.map((r) => rescoreRow(r, cases, carry));
}

function writeOut(outDir: string, rows: Row[], mode: string): void {
  writeFileSync(join(outDir, "trajectory.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n"), "utf8");
  const verdicts = rows.map((r) => r.verdict);
  const metrics = aggregate(verdicts);
  const markdown = renderSummaryMarkdown(
    { mode, timestamp: new Date().toISOString(), judge: true },
    metrics,
    verdicts,
  );
  writeFileSync(join(outDir, "summary.md"), markdown, "utf8");
  console.log(`来源目录清单已隐含在合并参数中；输出 ${basename(outDir)}（${rows.length} 行）`);
  void readdirSync;
}
