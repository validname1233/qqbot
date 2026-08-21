// test/recall/eval.ts —— 召回准确率评测。
// 对 queries.json 的每条查询跑 config.modes 里的每种召回模式（rag / keyword / hybrid），
// 全部走生产的 hybridRecall（test 测的就是线上在跑的那份逻辑），按 Recall@topK 和
// MRR 输出对比表。同一 query 的 embedding 只算一次、多模式复用，保证模式间对比公平。
// 用法：npx tsx --env-file=.env test/recall/eval.ts [--verbose]

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  hybridRecall,
  longTermMemoryStore,
  type RecallParams,
} from "../../src/agent/memory/long-term.js";
import { embedText } from "../../src/services/embedding.js";

type Mode = "rag" | "keyword" | "hybrid";

interface CorpusEntry {
  id: string;
  content: string;
  memory_index: string;
}

interface QueryEntry {
  query: string;
  gold: string[];
}

interface TestConfig {
  dbKey: string;
  corpusFile: string;
  queriesFile: string;
  modes: Mode[];
  topK: number;
  minSimilarity: number;
  rrfK: number;
  vecWeight: number;
  kwWeight: number;
  bm25K1: number;
  bm25B: number;
}

interface ModeMetrics {
  recallSum: number;
  mrrSum: number;
  full: number; // gold 全部命中
  partial: number; // 命中一部分
  miss: number; // 一条没中
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const config: TestConfig = JSON.parse(readFileSync(join(__dirname, "config.json"), "utf-8"));
const corpus: CorpusEntry[] = JSON.parse(readFileSync(join(__dirname, config.corpusFile), "utf-8"));
const queries: QueryEntry[] = JSON.parse(readFileSync(join(__dirname, config.queriesFile), "utf-8"));
const verbose = process.argv.includes("--verbose");

// ---- 前置校验：库非空、gold 引用有效 ----
const rows = await longTermMemoryStore.list(config.dbKey);
if (rows.length === 0) {
  console.error("[eval] 测试库为空，先跑 ./run.sh seed 灌库");
  process.exit(1);
}

const corpusIdByContent = new Map(corpus.map((c) => [c.content, c.id] as const));
const validIds = new Set(corpus.map((c) => c.id));
for (const q of queries) {
  for (const g of q.gold) {
    if (!validIds.has(g)) {
      console.error(`[eval] gold 引用了不存在的语料 id：${g}（query: ${q.query}）`);
      process.exit(1);
    }
  }
}
console.log(`[eval] 库中 ${rows.length} 条记忆，${queries.length} 条查询，模式：${config.modes.join("/")}`);

// ---- 模式 → RecallParams：权重 0 的通道被 hybridRecall 整体关闭 ----
function paramsFor(mode: Mode): RecallParams {
  const base = {
    topK: config.topK,
    minSimilarity: config.minSimilarity,
    rrfK: config.rrfK,
    bm25K1: config.bm25K1,
    bm25B: config.bm25B,
  };
  if (mode === "rag") return { ...base, vecWeight: 1, kwWeight: 0 };
  if (mode === "keyword") return { ...base, vecWeight: 0, kwWeight: 1 };
  return { ...base, vecWeight: config.vecWeight, kwWeight: config.kwWeight };
}

const metrics = new Map<Mode, ModeMetrics>();
for (const mode of config.modes) {
  metrics.set(mode, { recallSum: 0, mrrSum: 0, full: 0, partial: 0, miss: 0 });
}
// 只有存在启用向量通道的模式才需要算 query embedding（纯 keyword 模式省掉 API 调用）
const needEmbedding = config.modes.some((m) => paramsFor(m).vecWeight > 0);

// ---- 逐查询评测：一次 embedding，多模式复用 ----
for (let qi = 0; qi < queries.length; qi++) {
  const { query, gold } = queries[qi];
  const queryEmbedding = needEmbedding ? await embedText(query) : undefined;
  const goldSet = new Set(gold);

  for (const mode of config.modes) {
    const result = await hybridRecall(config.dbKey, query, paramsFor(mode), queryEmbedding);
    // 召回的行 → corpus id（content 唯一映射；理论上都在，防御性过滤 undefined）
    const hitIds = result.items
      .map((i) => corpusIdByContent.get(i.memory.content))
      .filter((x): x is string => x !== undefined);
    const hitSet = new Set(hitIds);
    const hitCount = gold.filter((g) => hitSet.has(g)).length;
    const firstRank = hitIds.findIndex((id) => goldSet.has(id));

    const m = metrics.get(mode) as ModeMetrics;
    m.recallSum += hitCount / gold.length;
    m.mrrSum += firstRank === -1 ? 0 : 1 / (firstRank + 1);
    if (hitCount === gold.length) m.full += 1;
    else if (hitCount > 0) m.partial += 1;
    else m.miss += 1;

    if (verbose) {
      const marks = hitIds.map((id) => (goldSet.has(id) ? `${id}✓` : `${id}✗`));
      console.log(`  [${mode}] ${query} → [${marks.join(" ")}]（gold: ${gold.join(",")}）`);
    }
  }
  console.log(`[eval] ${qi + 1}/${queries.length} ${query}`);
}

// ---- 报表 ----
console.log("\n================ 评测结果 =================");
console.log(
  `参数：topK=${config.topK}  minSimilarity=${config.minSimilarity}  rrfK=${config.rrfK}  ` +
    `hybrid权重 vec:kw=${config.vecWeight}:${config.kwWeight}  bm25 k1/b=${config.bm25K1}/${config.bm25B}`,
);
const n = queries.length;
for (const mode of config.modes) {
  const m = metrics.get(mode) as ModeMetrics;
  console.log(
    `${mode.padEnd(9)} Recall@${config.topK}=${(m.recallSum / n).toFixed(3)}  MRR=${(m.mrrSum / n).toFixed(3)}  ` +
      `全对=${m.full}  部分=${m.partial}  全miss=${m.miss}`,
  );
}
console.log("==========================================");
