// bench.ts —— 主基准：对比 A（检索时实时分词）vs B（写入时分词落库、检索时直接读）。
// 运行：npx tsx "面试/分词入库性能对比/src/bench.ts"
//
// 测量口径：只测"关键词通道"的检索耗时（分词/解析 + BM25 打分），不含 embedding
// 网络调用——那是向量通道的事，两组完全相同，排除在外才能看清差异。
// 每个 query 一次 search 计为一次采样；每规模预热 1 轮后测 ROUNDS 轮取统计量。

import { performance } from "node:perf_hooks";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tokenize } from "./tokenizer.js";
import { bm25Scores } from "./bm25.js";
import { generateCorpus, generateQueries } from "./corpus.js";
import { TokenStore } from "./sqlite.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCALES = [30, 300, 3000, 30000];
const ROUNDS = 3; // 轮数：每轮跑完整个查询集算一遍均值，取三轮的统计
const QUERIES = generateQueries();

// A 组：实时分词——每次 search 对全部候选 content 现场分词（生产现状）。
function searchA(contents: string[], query: string): number[] {
  const docs = contents.map((c) => tokenize(c));
  const q = tokenize(query);
  return bm25Scores(docs, q);
}

// B 组：落库读取——tokens 来自存储层（写入时已分好），检索时只做 JSON.parse（在 loadAll 里）。
function searchB(docs: string[][], query: string): number[] {
  const q = tokenize(query);
  return bm25Scores(docs, q);
}

interface Stats {
  mean: number;
  p50: number;
  p95: number;
}

function stats(samples: number[]): Stats {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.reduce((s, v) => s + v, 0) / samples.length;
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  return { mean, p50: at(0.5), p95: at(0.95) };
}

const fmt = (ms: number) => (ms >= 1 ? ms.toFixed(2) : (ms * 1000).toFixed(1) + "µs");

// 顺带拆分耗时占比：单独测"只分词不打分"的耗时，确认瓶颈归因。
function profileTokenizeShare(contents: string[]): number {
  const queries = QUERIES.map((q) => tokenize(q));
  let t0 = performance.now();
  for (const q of queries) bm25Scores(contents.map((c) => tokenize(c)), q);
  const total = performance.now() - t0;
  t0 = performance.now();
  for (const q of queries) bm25Scores([[]], q); // 只测 query 分词+空语料打分的基线
  const base = performance.now() - t0;
  void queries;
  return total === 0 ? 0 : (total - base) / total;
}

// 采样一次完整的"每 query 检索"：fn 是每 query 的待测函数。
function sample(fn: (query: string) => unknown): number[] {
  const samples: number[] = [];
  for (const q of QUERIES) {
    const t0 = performance.now();
    fn(q);
    samples.push(performance.now() - t0);
  }
  return samples;
}

async function main(): Promise<void> {
  console.log(`环境: Node ${process.version}, 查询数 ${QUERIES.length}, 每规模测 ${ROUNDS} 轮`);
  console.log("");

  const results: Array<{ scale: number; a: Stats; b: Stats; speedup: number; tokenizeShare: number }> = [];

  for (const scale of SCALES) {
    const contents = generateCorpus(scale);
    const store = new TokenStore(join(__dirname, `bench-${scale}.sqlite`));
    store.insertAll(contents); // B 组的预付成本（写入分词）不计入检索耗时
    const stored = store.loadAll();
    const bDocs = stored.map((d) => d.tokens);

    // 预热（JIT / 页缓存），不采样
    sample((q) => searchA(contents, q));
    sample((q) => searchB(bDocs, q));

    const aSamples: number[] = [];
    const bSamples: number[] = [];
    for (let r = 0; r < ROUNDS; r++) {
      aSamples.push(...sample((q) => searchA(contents, q)));
      bSamples.push(...sample((q) => searchB(bDocs, q)));
    }

    const a = stats(aSamples);
    const b = stats(bSamples);
    const tokenizeShare = profileTokenizeShare(contents);
    results.push({ scale, a, b, speedup: a.mean / b.mean, tokenizeShare });
    store.dispose();
  }

  // 结果表
  console.log("| 规模 | A 均值 | A P95 | B 均值 | B P95 | B/A 加速比 | A 中分词占比 |");
  console.log("|---|---|---|---|---|---|---|");
  for (const r of results) {
    console.log(
      `| ${r.scale} | ${fmt(r.a.mean)} | ${fmt(r.a.p95)} | ${fmt(r.b.mean)} | ${fmt(r.b.p95)} | ${r.speedup.toFixed(1)}x | ${(r.tokenizeShare * 100).toFixed(0)}% |`,
    );
  }
}

void main();
