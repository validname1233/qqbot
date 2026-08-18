// agent/memory/long-term.ts —— 长期记忆的 node:sqlite 实现。
// 单聊/群聊共用一张表，隔离键直接复用 memoryKey()（c2c:<openid> / group:<groupOpenid>），
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
import { config } from "../../config.js";

const MAX_MEMORIES = 30;

// RAG 召回相似度阈值与 BM25/RRF 参数：调参旋钮，走环境变量（config.ts），
// 默认值见 .env.example 的说明，改 .env 即可热调（重启进程生效）。
const MIN_SIMILARITY = config.minSimilarity;
const BM25_K1 = config.bm25K1;
const BM25_B = config.bm25B;
const RRF_K = config.rrfK;

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_DIR = join(__dirname, "../../../data");
const DB_PATH = join(DB_DIR, "memory.sqlite");

mkdirSync(DB_DIR, { recursive: true });

// 长期记忆和短期记忆共用同一个数据库文件，各自开一份连接——node:sqlite 允许
// 同进程内多个 DatabaseSync 打开同一个文件，SQLite 本身处理并发访问。
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
// 会被 search() 的 WHERE embedding IS NOT NULL 过滤掉，靠 FIFO 淘汰自然替换，不写回填脚本。
const columns = db.prepare(`PRAGMA table_info(long_term_memories)`).all() as Array<{ name: string }>;
if (!columns.some((c) => c.name === "embedding")) {
  db.exec(`ALTER TABLE long_term_memories ADD COLUMN embedding TEXT`);
}
// tokens 列：写入时落库的分词结果（JSON 数组），检索时免逐条现场分词。
// 注意：以后改停用词表或换分词器，库里已存的 tokens 还是旧口径，需要回填脚本
// 重新分词——这是"分词入库"方案固有的一致性代价。
// 旧记录该列为 NULL，search() 对 NULL 行现场分词兜底，不做批量回填。
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
  search(key: string, queryText: string, topK: number): Promise<LongTermMemory[]>; // RAG 召回专用
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
function bm25Scores(docs: string[][], query: string[]): number[] {
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
      const norm = 1 - BM25_B + BM25_B * (docLengths[i] / (avgDocLength || 1));
      score += idf * ((tf * (BM25_K1 + 1)) / (tf + BM25_K1 * norm));
    }
    return score;
  });
}

// ---------- RRF 融合 ----------
// 输入：每条候选在各通道的排名（rank 从 0 开始；不在某通道则不出现在其排名表里）。
// score(d) = Σ 1/(K + rank_i(d))。某条记忆同时被两个通道召回时分数自然叠加——
// 这正是混合检索的核心收益：字面命中和语义命中互相印证。
function rrfFuse(candidateIds: number[], rankings: number[][]): Map<number, number> {
  const scores = new Map<number, number>();
  for (const id of candidateIds) scores.set(id, 0);
  for (const ranking of rankings) {
    ranking.forEach((id, rank) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + rank));
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

  // 混合召回：向量（语义）+ 关键词（BM25）双通道，各自过相关性门槛后按排名做 RRF 融合。
  // 通道各自的意义：向量抓"意思相近但用词不同"，关键词抓"字面明确命中"（专名、日期、
  // 数字等 embedding 容易对不上的场景）。query 全是停用词时关键词通道为空，退化为纯向量。
  // embedding 和 tokens 都在写入时落库，这里一次查询读全量候选，两通道在应用层各自筛：
  // 向量通道跳过 embedding 为 NULL 的行；关键词通道对 tokens 为 NULL 的行（迁移前的
  // 旧记录）现场分词兜底，保证旧记忆仍可被字面召回，不做批量回填。
  async search(key: string, queryText: string, topK: number): Promise<LongTermMemory[]> {
    const queryEmbedding = await embedText(queryText);
    const queryTokens = tokenize(queryText);

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
    const rows = searchCandidatesStmt.all(key) as CandidateRow[];

    // ---- 向量通道：余弦 ≥ MIN_SIMILARITY，降序得排名 ----
    const vecRanking = rows
      .filter((row) => row.embedding !== null)
      .map((row) => ({ id: row.id, similarity: cosineSimilarity(queryEmbedding, JSON.parse(row.embedding as string) as number[]) }))
      .filter(({ similarity }) => similarity >= MIN_SIMILARITY)
      .sort((a, b) => b.similarity - a.similarity)
      .map(({ id }) => id);

    // ---- 关键词通道：BM25 > 0（至少命中一个查询词），降序得排名 ----
    const docTokens = rows.map((row) =>
      row.tokens !== null ? (JSON.parse(row.tokens) as string[]) : tokenize(row.content),
    );
    const kwScores =
      queryTokens.length === 0 ? [] : bm25Scores(docTokens, queryTokens);
    const kwRanking = rows
      .map((row, i) => ({ id: row.id, score: kwScores[i] }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .map(({ id }) => id);

    // ---- RRF 融合：两通道排名并列，分数求和，降序取 topK ----
    const candidateIds = [...new Set([...vecRanking, ...kwRanking])];
    const fused = rrfFuse(candidateIds, [vecRanking, kwRanking]);
    const rankedIds = candidateIds
      .map((id) => ({ id, rrf: fused.get(id) ?? 0 }))
      .sort((a, b) => b.rrf - a.rrf)
      .slice(0, topK);

    // 召回日志：两通道各自的排名（id 降序排列）+ 融合分数与摘要，方便跑真实对话观察调参。
    // 摘要取 memory_index（写入时 LLM 生成的 10-20 字检索摘要），超长截断保住单行可读。
    const describe = (ids: number[], channel: string) =>
      ids.length === 0 ? `${channel}:无` : `${channel}:${ids.map((id) => `#${id}`).join(">")}`;
    const indexById = new Map(rows.map((row) => [row.id, row.memory_index] as const));
    console.log(
      `[长期记忆] ${describe(vecRanking, "向量")} ${describe(kwRanking, "关键词")} → ${rankedIds
        .map(
          ({ id, rrf }) =>
            `#${id}(${rrf.toFixed(4)} ${(indexById.get(id) ?? "").slice(0, 20)})`,
        )
        .join(" | ")}`,
    );

    const byId = new Map(rows.map((row) => [row.id, rowToMemory(row)] as const));
    return rankedIds.map(({ id }) => byId.get(id) as LongTermMemory);
  },
};
