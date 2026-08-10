# 长期记忆 RAG 召回方案

## 1. 目标与范围

- 现状：`buildLongTermContextText`（[context.ts:44](../../../src/agent/context.ts:44)）无条件读出该 key 下*全部*长期记忆（硬上限 5 条，[long-term.ts:14](../../../src/agent/memory/long-term.ts:14) `MAX_MEMORIES`）拼进上下文，等于"全量召回"。
- 目标：把召回方式**直接改成**"按相关度召回"（RAG）——把当前用户消息 embedding 化，和该 key 下每条记忆的 embedding 做余弦相似度，取 top-K 且相似度达标的记忆注入上下文。**不保留按时间召回的旧策略，不做配置切换**，RAG 是唯一路径，改动更直接。
- 依赖选型已定：不引入向量数据库，继续用现有 `node:sqlite`，相似度计算放应用层（TS 里暴力算，几十条量级开销可忽略）。embedding 服务已实现：[services/embedding.ts](../../../src/services/embedding.ts) 的 `embedText(text: string): Promise<number[]>`。
- 表结构上直接在现有 `long_term_memories` 表里加一列，不新建表——只有一条召回路径，不需要为"区分两套逻辑"付出分表的复杂度。

## 2. 表结构改动

`long_term_memories` 表新增一列：

```sql
ALTER TABLE long_term_memories ADD COLUMN embedding TEXT;
```

- 存 `JSON.stringify(number[])`，和 `sqlite.ts` 里 `tool_calls` 列的存法一致。
- 现有数据库文件已经建过表，`CREATE TABLE IF NOT EXISTS` 不会给已存在的表补列，所以启动时要单独处理迁移：用 `PRAGMA table_info(long_term_memories)` 查一下 `embedding` 列是否已存在，不存在就执行上面这条 `ALTER TABLE`。
- 迁移后旧记录的 `embedding` 是 `NULL`。这些旧记录在 `search()` 里会被 `WHERE embedding IS NOT NULL` 过滤掉，但仍会出现在 `list()` 里（`delete_memory` 走的是 `list()`，见第 6 节，不受影响）。数据量小，旧记录很快会被新增/删除自然替换，不写回填脚本。

## 3. embedding 的对象是 `content`（原文），不是 `memory_index`（摘要）

`memory_index` 是 `add_memory` 工具为 `delete_memory` 语义匹配专门生成的短摘要（[add-memory.ts:11](../../../src/agent/tools/add-memory.ts:11)），这条链路本次不改，`memory_index` 继续只服务于它。

RAG 召回直接对 `content`（记忆正文）做 embedding：原文信息更完整，不依赖一次额外的、有损的摘要转写。

## 4. 存储层改动（`agent/memory/long-term.ts`）

`LongTermMemory` 接口和 `remove()` 签名不变。新增一个 `search` 方法，`buildLongTermContextText` 改调它而不是 `list()`：

```ts
export interface LongTermMemoryStore {
  add(key: string, author: MessageAuthor, content: string, memoryIndex: string): Promise<void>;
  list(key: string): Promise<LongTermMemory[]>; // 继续保留，delete_memory 候选列表用
  remove(id: number): Promise<void>;
  search(key: string, queryText: string, topK: number): Promise<LongTermMemory[]>; // 新增，召回专用
}
```

`search()` 内部流程：
1. `embedText(queryText)` 拿到当前用户消息的向量。
2. 取出该 key 下所有 `embedding IS NOT NULL` 的记忆行（含各自 embedding）。
3. 对每条算余弦相似度，按相似度降序排列。
4. 过滤掉相似度低于 `MIN_SIMILARITY` 阈值的（避免硬凑几条不相关的记忆进去）。
5. 取前 `topK` 条，转换成 `LongTermMemory[]`（不含 embedding 字段）返回。

```ts
const MIN_SIMILARITY = 0.35; // 阈值先给个保守估计，实际效果要跑几轮真实对话再调

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

const searchCandidatesStmt = db.prepare(`
  SELECT id, author_openid, author_name, content, memory_index, embedding, created_at, updated_at
  FROM long_term_memories
  WHERE key = ? AND embedding IS NOT NULL
`);

async search(key, queryText, topK) {
  const queryEmbedding = await embedText(queryText);
  const rows = searchCandidatesStmt.all(key) as Array<LongTermMemoryRow & { embedding: string }>;

  return rows
    .map((row) => ({ row, similarity: cosineSimilarity(queryEmbedding, JSON.parse(row.embedding)) }))
    .filter(({ similarity }) => similarity >= MIN_SIMILARITY)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, topK)
    .map(({ row }) => toLongTermMemory(row)); // 现有的行转换辅助函数，去掉 embedding 字段
}
```
`add()` 的改动：多算一次 `content` 的 embedding 存进新列，签名不变（调用方 `add-memory.ts` 不用改）：

```ts
async add(key, author, content, memoryIndex) {
  const embedding = await embedText(content); // 对 content 调用，不是 memoryIndex
  const existing = await this.list(key);
  if (existing.length >= MAX_MEMORIES) {
    await this.remove(existing[0].id);
  }
  const now = Date.now();
  insertStmt.run(key, author.openid, author.name, content, memoryIndex, JSON.stringify(embedding), now, now);
}
```

对应地，`insertStmt` 的 SQL 要在 `memory_index` 和 `created_at` 之间插入 `embedding` 列：

```ts
const insertStmt = db.prepare(`
  INSERT INTO long_term_memories (key, author_openid, author_name, content, memory_index, embedding, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
```

## 5. 召回入口改动（`agent/context.ts`）

`buildLongTermContextText` 新增一个参数：当前用户消息文本，作为 embedding 查询的 query，内部改调 `search()` 而不是 `list()`：

```ts
const TOP_K = 3;

export async function buildLongTermContextText(event: BotEvent, queryText: string): Promise<string> {
  const memories = await longTermMemoryStore.search(memoryKey(event), queryText, TOP_K);
  if (memories.length === 0) {
    return "";
  }
  const lines = memories.map((m) => `- （由${m.authorName}记录）${m.content}`);
  return `以下是关于当前对话的长期记忆（可能有助于理解上下文）：\n${lines.join("\n")}`;
}
```

调用方 [loop.ts:76](../../../src/agent/loop.ts:76) 的 `prepareContext` 节点需要同步改成传入当前用户消息：

```ts
const longTermContext = await buildLongTermContextText(event, state.userText);
```

`state.userText` 是这一轮用户原始输入（`prepareContext` 里已经在用它算 `formattedUserText`，[loop.ts:75](../../../src/agent/loop.ts:75)），拿它做 query 而不是拼了昵称前缀的 `formattedUserText`——昵称前缀是给短期记忆用的展示格式，不该混进语义检索的 query 里。

## 6. `delete_memory` 不受影响

[delete-memory.ts](../../../src/agent/tools/delete-memory.ts) 走的是 `list(key)` 读全部候选、交给模型按 `memory_index` 做匹配（[delete-memory.ts:25](../../../src/agent/tools/delete-memory.ts:25) `matchMemoryId`），这条链路和 `embedding` 列无关，`list()` 签名不变，本次零改动。

## 7. 常量

`MIN_SIMILARITY`（0.35）和 `TOP_K`（3）先写成代码里的常量，不做环境变量/配置项——和 `MAX_MEMORIES` 现有的处理方式一致（[long-term.ts:14](../../../src/agent/memory/long-term.ts:14)），这套值需要跑真实数据调参，等调出稳定值再考虑是否要开放配置。

## 8. 文件改动清单

| 文件 | 改动 |
|---|---|
| `src/agent/memory/long-term.ts` | 建表 SQL 加 `embedding` 列 + 启动迁移逻辑；`insertStmt` 加一列；`add()` 内部对 `content` 调 `embedText`；新增 `search()` 方法及配套 SQL/余弦相似度函数 |
| `src/agent/context.ts` | `buildLongTermContextText` 签名加 `queryText` 参数，内部改调 `search()` 而非 `list()` |
| `src/agent/loop.ts` | `prepareContext` 节点调用 `buildLongTermContextText` 时多传 `state.userText` |

不涉及改动：`services/embedding.ts`（已实现，直接复用）、`config.ts`（`embeddingApiKey`/`embeddingModel` 已配好）、`add-memory.ts`/`delete-memory.ts`（接口签名不变，`memory_index` 生成逻辑不变）、`LongTermMemory`/`LongTermMemoryStore` 对外类型形状不变（只加了一个方法）。

## 9. 明确排除范围

- 向量数据库或 SQLite 向量扩展（如 sqlite-vec）：数据量级用不上。
- 按时间召回的旧策略：不保留，不做配置切换，RAG 是唯一召回路径。
- 旧记忆（`embedding IS NULL`）的批量回填：不做，让它们自然被 FIFO 淘汰替换。
- `delete_memory` 工具改用向量匹配：不改，候选量小（≤5条），RAG 解决的是"塞进 prompt 的记忆太多/不相关"，不是"删除时找不到"。
- `MIN_SIMILARITY`/`TOP_K` 阈值调优：本方案给的是初始估计值，实际效果需要接入后用真实对话数据观察调整。

