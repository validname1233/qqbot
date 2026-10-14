// agent/memory/long-term.ts —— 长期记忆的 node:sqlite 实现。
// 单聊/群聊共用一张表，隔离键直接复用 tenantKey()（c2c:<openid> / group:<groupOpenid>），
// 不新增一套隔离逻辑——和短期记忆（sqlite.ts）是同一个隔离粒度，两套表天然同步。
//
// 容量策略：每个 key 硬上限 MAX_MEMORIES 条，add() 内部包办 FIFO 淘汰，
// 调用方（add_memory 工具）不用关心容量逻辑。

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MessageAuthor } from "./types.js";
import { embedText } from "../../services/embedding.js";
import { tokenize } from "../../services/tokenizer.js";
import { logger } from "../../services/logger.js";
import { config } from "../../config.js";

const MAX_MEMORIES = 100;

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_DIR = join(__dirname, "../../../data");
// 库文件名可被 MEMORY_DB_PATH 覆盖（默认 memory.sqlite，与短期记忆共用）：
// 召回测试（test/recall）用它指向独立的 recall-test.sqlite，与生产库完全隔离，重置即删文件。
const DB_PATH = join(DB_DIR, config.memoryDbFile);

mkdirSync(DB_DIR, { recursive: true });

// 各自开一份连接——node:sqlite 允许同进程内多个 DatabaseSync 打开同一个文件，
// SQLite 本身处理并发访问。
const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS long_term_memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL,
    author_openid TEXT NOT NULL,
    author_name TEXT NOT NULL,
    content TEXT NOT NULL,
    memory_index TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_long_term_key ON long_term_memories(key);
`);

// 迁移：老数据库文件建表时没有 embedding 列，CREATE TABLE IF NOT EXISTS 不会给已存在的表补列，
// 所以启动时单独检查一次，不存在就 ALTER TABLE 补上。旧记录迁移后 embedding 是 NULL，
// 会被向量通道跳过，靠 FIFO 淘汰自然替换，不写回填脚本。
const columns = db.prepare(`PRAGMA table_info(long_term_memories)`).all() as Array<{ name: string }>;
if (!columns.some((c) => c.name === "embedding")) {
  db.exec(`ALTER TABLE long_term_memories ADD COLUMN embedding TEXT`);
}
// tokens 列：写入时落库的分词结果（JSON 数组），检索时免逐条现场分词。
// 注意：以后改停用词表或换分词器，库里已存的 tokens 还是旧口径，需要回填脚本
// 重新分词——这是"分词入库"方案固有的一致性代价。
// 旧记录该列为 NULL，检索时对 NULL 行现场分词兜底，不做批量回填。
if (!columns.some((c) => c.name === "tokens")) {
  db.exec(`ALTER TABLE long_term_memories ADD COLUMN tokens TEXT`);
}

export interface LongTermMemory {
  id: number;
  authorOpenid: string;
  authorName: string;
  content: string;
  memoryIndex: string;
  createdAt: number;
  updatedAt: number;
}

export interface LongTermMemoryStore {
  add(
    key: string,
    author: MessageAuthor,
    content: string,
    memoryIndex: string,
  ): Promise<void>;
  list(key: string): Promise<LongTermMemory[]>; // 按 updated_at 升序，最旧的在前；delete_memory 候选列表用
  remove(id: number): Promise<void>;
  search(key: string, queryText: string, topK: number): Promise<LongTermMemory[]>; // 混合召回（生产行为）
}

const listStmt = db.prepare(
  `SELECT id, author_openid, author_name, content, memory_index, created_at, updated_at
   FROM long_term_memories
   WHERE key = ?
   ORDER BY updated_at ASC`,
);

const insertStmt = db.prepare(`
  INSERT INTO long_term_memories (key, author_openid, author_name, content, memory_index, embedding, tokens, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const deleteStmt = db.prepare("DELETE FROM long_term_memories WHERE id = ?");

// 检索候选：一次读出该 key 全部行，向量/关键词两通道在应用层各自筛——
// embedding 和 tokens 都随写入落库，SQL 无需按列过滤（NULL 的旧行走各自兜底）。
const searchCandidatesStmt = db.prepare(`
  SELECT id, author_openid, author_name, content, memory_index, embedding, tokens, created_at, updated_at
  FROM long_term_memories
  WHERE key = ?
`);

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ---------- 关键词通道：BM25 ----------
// 输入已分好词：docs 是每篇文档的词项数组，query 是查询词项数组。
// IDF 按"本次参与检索的这组文档"（同一 key 下的候选记忆）计算——语料规模和
// 召回的隔离粒度对齐，不同 key 之间互不影响统计。
// BM25 分数无上界（0~∞），只在同一语料内可比，正好交给 RRF 按排名融合。
// k1/b 由调用方传入（生产走 config 环境变量，测试走测试配置文件）。
function bm25Scores(docs: string[][], query: string[], k1: number, b: number): number[] {
  const docCount = docs.length;
  // 每篇文档的词频表和长度
  const termFreqs = docs.map((tokens) => {
    const freq = new Map<string, number>();
    for (const t of tokens) freq.set(t, (freq.get(t) ?? 0) + 1);
    return freq;
  });
  const docLengths = docs.map((tokens) => tokens.length);
  const avgDocLength =
    docCount === 0 ? 0 : docLengths.reduce((sum, len) => sum + len, 0) / docCount;

  // 包含某查询词的文档数（只在查询词上统计，语料小没必要为全词表建索引）
  const docsContaining = new Map<string, number>();
  for (const term of query) {
    if (docsContaining.has(term)) continue;
    let count = 0;
    for (const freq of termFreqs) if (freq.has(term)) count += 1;
    docsContaining.set(term, count);
  }

  return docs.map((_, i) => {
    let score = 0;
    for (const term of query) {
      const tf = termFreqs[i].get(term) ?? 0;
      if (tf === 0) continue;
      const df = docsContaining.get(term) ?? 0;
      // 平滑 IDF：df 肯定 ≥ 1（tf > 0 说明本篇就包含它），+1 防除零，
      // 也压低"人人都含"的词的权重。
      const idf = Math.log(1 + (docCount - df + 0.5) / (df + 0.5));
      const norm = 1 - b + b * (docLengths[i] / (avgDocLength || 1));
      score += idf * ((tf * (k1 + 1)) / (tf + k1 * norm));
    }
    return score;
  });
}

// ---------- RRF 融合 ----------
// 输入：每条候选在各通道的排名（rank 从 0 开始；不在某通道则不出现在其排名表里），
// 以及每个通道的权重（不传则全 1）。score(d) = Σ wᵢ/(rrfK + rankᵢ(d))。
// 某条记忆同时被两个通道召回时分数自然叠加——这正是混合检索的核心收益：
// 字面命中和语义命中互相印证。权重为 0 的通道由调用方直接不喂进来（不贡献分数也不贡献候选）。
function rrfFuse(
  candidateIds: number[],
  rankings: number[][],
  rrfK: number,
  weights?: number[],
): Map<number, number> {
  const w = weights ?? rankings.map(() => 1);
  const scores = new Map<number, number>();
  for (const id of candidateIds) scores.set(id, 0);
  for (let c = 0; c < rankings.length; c++) {
    rankings[c].forEach((id, rank) => {
      scores.set(id, (scores.get(id) ?? 0) + w[c] / (rrfK + rank));
    });
  }
  return scores;
}

function rowToMemory(row: {
  id: number;
  author_openid: string;
  author_name: string;
  content: string;
  memory_index: string;
  created_at: number;
  updated_at: number;
}): LongTermMemory {
  return {
    id: row.id,
    authorOpenid: row.author_openid,
    authorName: row.author_name,
    content: row.content,
    memoryIndex: row.memory_index,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------- 可参数化的混合召回（生产 search 与 test/recall 评测共用） ----------
// 抽成独立函数而不是让评测脚本复制实现：保证测出来的数字就是线上行为的数字，
// 不会出现"快照代码和生产代码漂移"。

// 检索候选行的形状（embedding/tokens 为 NULL 表示迁移前的旧行）。
type CandidateRow = {
  id: number;
  author_openid: string;
  author_name: string;
  content: string;
  memory_index: string;
  embedding: string | null;
  tokens: string | null;
  created_at: number;
  updated_at: number;
};

export interface RecallParams {
  topK: number;
  minSimilarity: number; // 向量通道的余弦门槛
  rrfK: number; // RRF 融合常数
  bm25K1: number;
  bm25B: number;
  vecWeight: number; // 0 = 关闭向量通道（不打分、不进候选池、不调 embedding）
  kwWeight: number; // 0 = 关闭关键词通道
}

export interface RecallResultItem {
  memory: LongTermMemory;
  rrf: number; // 融合分
  vecRank: number | null; // 在向量通道的排名（0 起）；null = 该通道未召回它
  kwRank: number | null; // 在关键词通道的排名；null = 该通道未召回它
}

export interface RecallResult {
  items: RecallResultItem[]; // 融合后 topK，按 rrf 降序
  vecRanking: number[]; // 向量通道完整排名（行 id，过门槛后降序）
  kwRanking: number[]; // 关键词通道完整排名
}

// 混合召回主体：向量（语义）+ 关键词（BM25）双通道，各自过相关性门槛后按排名做
// 加权 RRF 融合。通道各自的意义：向量抓"意思相近但用词不同"，关键词抓"字面明确
// 命中"（专名、日期、数字等 embedding 容易对不上的场景）。
// 权重为 0 的通道被整体关闭——既不贡献分数也不贡献候选（否则垃圾候选会靠排名白嫖
// topK 名额，污染单通道消融实验）。precomputedQueryEmbedding 供评测复用同一份
// query 向量：多模式对比时消除 embedding 调用间的非确定性。
export async function hybridRecall(
  key: string,
  queryText: string,
  params: RecallParams,
  precomputedQueryEmbedding?: number[],
): Promise<RecallResult> {
  const useVec = params.vecWeight > 0;
  const useKw = params.kwWeight > 0;

  const rows = searchCandidatesStmt.all(key) as CandidateRow[];

  // ---- 向量通道：余弦 ≥ minSimilarity，降序得排名。跳过 embedding 为 NULL 的旧行 ----
  const vecRanking: number[] = [];
  if (useVec) {
    const queryEmbedding = precomputedQueryEmbedding ?? (await embedText(queryText));
    vecRanking.push(
      ...rows
        .filter((row) => row.embedding !== null)
        .map((row) => ({
          id: row.id,
          similarity: cosineSimilarity(queryEmbedding, JSON.parse(row.embedding as string) as number[]),
        }))
        .filter(({ similarity }) => similarity >= params.minSimilarity)
        .sort((a, b) => b.similarity - a.similarity)
        .map(({ id }) => id),
    );
  }

  // ---- 关键词通道：BM25 > 0（至少命中一个查询词），降序得排名。
  // tokens 为 NULL 的旧行现场分词兜底，保证旧记忆仍可被字面召回，不做批量回填 ----
  const kwRanking: number[] = [];
  if (useKw) {
    const queryTokens = tokenize(queryText);
    if (queryTokens.length > 0) {
      const docTokens = rows.map((row) =>
        row.tokens !== null ? (JSON.parse(row.tokens) as string[]) : tokenize(row.content),
      );
      const scores = bm25Scores(docTokens, queryTokens, params.bm25K1, params.bm25B);
      kwRanking.push(
        ...rows
          .map((row, i) => ({ id: row.id, score: scores[i] }))
          .filter(({ score }) => score > 0)
          .sort((a, b) => b.score - a.score)
          .map(({ id }) => id),
      );
    }
  }

  // ---- 加权 RRF 融合：只喂启用通道的排名，候选池也只由启用通道构成 ----
  const rankings: number[][] = [];
  const weights: number[] = [];
  if (useVec) {
    rankings.push(vecRanking);
    weights.push(params.vecWeight);
  }
  if (useKw) {
    rankings.push(kwRanking);
    weights.push(params.kwWeight);
  }
  const candidateIds = [...new Set(rankings.flat())];
  const fused = rrfFuse(candidateIds, rankings, params.rrfK, weights);

  const vecRankById = new Map(vecRanking.map((id, i) => [id, i] as const));
  const kwRankById = new Map(kwRanking.map((id, i) => [id, i] as const));
  const byId = new Map(rows.map((row) => [row.id, rowToMemory(row)] as const));

  const items: RecallResultItem[] = candidateIds
    .map((id) => ({ id, rrf: fused.get(id) ?? 0 }))
    .sort((a, b) => b.rrf - a.rrf)
    .slice(0, params.topK)
    .map(({ id, rrf }) => ({
      memory: byId.get(id) as LongTermMemory,
      rrf,
      vecRank: vecRankById.get(id) ?? null,
      kwRank: kwRankById.get(id) ?? null,
    }));

  return { items, vecRanking, kwRanking };
}

export const longTermMemoryStore: LongTermMemoryStore = {
  async list(key: string): Promise<LongTermMemory[]> {
    const rows = listStmt.all(key) as Array<{
      id: number;
      author_openid: string;
      author_name: string;
      content: string;
      memory_index: string;
      created_at: number;
      updated_at: number;
    }>;
    return rows.map(rowToMemory);
  },

  async add(
    key: string,
    author: MessageAuthor,
    content: string,
    memoryIndex: string,
  ): Promise<void> {
    // 写入时把检索要用的两样重活一次做掉：embedding（对原文 content，不是摘要）
    // 和分词结果。检索时直接读现成的，不再逐条现场分词。
    const embedding = await embedText(content);
    const tokens = tokenize(content);
    const existing = await this.list(key);
    if (existing.length >= MAX_MEMORIES) {
      // existing 按 updated_at 升序，第一条就是最旧的。
      deleteStmt.run(existing[0].id);
    }
    const now = Date.now();
    insertStmt.run(
      key,
      author.openid,
      author.name,
      content,
      memoryIndex,
      JSON.stringify(embedding),
      JSON.stringify(tokens),
      now,
      now,
    );
  },

  async remove(id: number): Promise<void> {
    deleteStmt.run(id);
  },

  // 生产行为：参数全部来自环境变量配置（config.ts），双通道 1:1 等权。
  async search(key: string, queryText: string, topK: number): Promise<LongTermMemory[]> {
    const result = await hybridRecall(key, queryText, {
      topK,
      minSimilarity: config.minSimilarity,
      rrfK: config.rrfK,
      bm25K1: config.bm25K1,
      bm25B: config.bm25B,
      vecWeight: 1,
      kwWeight: 1,
    });

    // 召回日志：两通道各自的完整排名（行 id 降序）+ 融合分数与摘要，
    // 方便跑真实对话观察调参。摘要取 memory_index（写入时生成的 10-20 字检索摘要），
    // 超长截断保住单行可读。
    const describe = (ids: number[], channel: string) =>
      ids.length === 0 ? `${channel}:无` : `${channel}:${ids.map((id) => `#${id}`).join(">")}`;
    logger.info(
      "memory",
      `${describe(result.vecRanking, "向量")} ${describe(result.kwRanking, "关键词")} → ${result.items
        .map((i) => `#${i.memory.id}(${i.rrf.toFixed(4)} ${i.memory.memoryIndex.slice(0, 20)})`)
        .join(" | ")}`,
    );

    return result.items.map((i) => i.memory);
  },
};
