# 单聊/群聊统一长期记忆方案

## 1. 目标与范围

- 覆盖单聊和群聊两种场景，复用同一套表和同一套 `LongTermMemoryStore` 接口，隔离粒度和短期记忆（[sqlite.ts](../../../src/agent/memory/sqlite.ts)）保持一致：单聊按人，群聊按群共享一份。
- 目标：让 agent 能跨会话记住事实性信息（单聊是关于某个用户的，群聊是群里共享的），支持模型自主判断触发"添加记忆"和"删除记忆"。
- 每个 key（单聊用户 / 群）硬上限 5 条，到达上限后自动淘汰最旧一条（FIFO），不做向量检索，检索/删除靠模型在候选列表里做语义匹配。
- 取代旧的 [long-term-memory-plan.md](../../long-term-memory-plan.md)（该文档只覆盖单聊场景，现已被本方案取代，保留作历史记录，不再维护）。

## 2. 表设计

```sql
CREATE TABLE IF NOT EXISTS long_term_memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,                -- memoryKey() 的结果：c2c:<openid> 或 group:<groupOpenid>
  author_openid TEXT NOT NULL,      -- 触发这条记忆的发言人 openid（单聊群聊都存）
  author_name TEXT NOT NULL,        -- 触发这条记忆的发言人昵称
  content TEXT NOT NULL,            -- 记忆正文
  memory_index TEXT NOT NULL,       -- 记忆摘要/检索索引，add_memory 工具内部另调模型生成
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_long_term_key ON long_term_memories(key);
```

- `key` 直接复用 `agent/context.ts` 的 `memoryKey()`，不新增一套隔离逻辑；以后要调整隔离粒度，只改 `memoryKey()` 一处，两套表自动同步。
- `author_openid`/`author_name` 无论单聊群聊都存：单聊场景下天然等于该用户自己（信息冗余但无害），群聊场景下用来在注入文本里标注"这条是谁记的"。
- 硬上限 5 条不用数据库约束强制，在应用层（`add()` 内部）做 FIFO 淘汰。
- `memory_index` 保留：当前规模下检索靠模型做候选列表匹配，但为未来提升上限或换更复杂的检索方式（仍是"模型读索引做判断"，不涉及向量化）保留这个字段，避免以后要重新补一次历史数据的索引。

## 3. 存储层接口

```ts
// agent/memory/long-term.ts
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
  add(key: string, author: MessageAuthor, content: string, memoryIndex: string): Promise<void>;
  list(key: string): Promise<LongTermMemory[]>; // 按 updated_at 升序，最旧的在前
  remove(id: number): Promise<void>;
}
```

`add()` 内部包办容量控制：写入前查 `list(key)`，长度达到 5 就先 `remove()` 掉最旧的一条再插入新的。调用方（`add_memory` 工具）不用关心容量逻辑；以后调整上限只改这个函数内的常量。`update()`（修改已有记忆）不做，需要改内容时先删后加。

## 4. 工具设计

新建 `agent/tools/add-memory.ts` 和 `agent/tools/delete-memory.ts`，通过现有 `registerTool()` 挂进 Agent 链路，和 `set_reminder` 工具的接入方式一致。两个工具的 `run(args, ctx)` 都从 `ctx.event` 算出 `memoryKey(event)` 和发言人信息。

### add_memory

- 参数：`content`（string，必填）——模型从用户话里抽取的"要记住的内容"原文，不夹带"记住"这几个字本身。
- 流程：`run()` 内部单独调一次轻量模型（不带 tools），用固定提示词从 `content` 提炼简短的 `memory_index`，再调 `longTermMemoryStore.add(key, author, content, memoryIndex)`，返回确认话术给模型拼进最终回复。
- description（发给模型的工具描述，决定触发时机判断）：
  > "当用户明确表达希望机器人记住某个信息时调用（例如说'记住……''帮我记一下……''以后要记得……'）。content 参数填用户想让你记住的具体内容，用你转述的简洁语言概括，不要包含'记住'等指令性词语本身。单聊场景下这是关于该用户个人的记忆；群聊场景下这条记忆会被群里所有人共享看到，调用前确认这确实是值得群共享的信息，而非仅对发言人本人有意义的私人琐事。"

### delete_memory

- 参数：`query`（string，必填）——用户对"想删除哪条记忆"的自然语言描述，不是 id。
- 流程：`list(key)` 读出该 key 全部记忆的 `id`+`memoryIndex`+`content`；把 `query` 和这份候选列表一起丢给模型做单独一次匹配调用，让模型返回最匹配的 `id`（或返回未匹配到）；匹配到就 `remove(id)`，工具返回确认话术；匹配不到返回"没找到匹配的记忆"。
- 任何人都可以删除任何一条记忆（群聊场景下不校验 `author_openid` 是否等于当前发言人）。
- description：
  > "当用户明确表达希望删除某条已记住的信息时调用（例如说'忘掉……''删除关于……的记忆''那条记忆不对了删了吧'）。query 参数填用户对想删除内容的描述，会拿去和已有记忆做匹配，不需要用户提供 id。群聊场景下任何人都可以删除群共享的记忆，不限于最初记录它的人。"

## 5. 长期记忆如何进入对话

填实现 `agent/context.ts` 的 `buildLongTermContextText(event)` 占位函数：

```ts
export async function buildLongTermContextText(event: BotEvent): Promise<string> {
  const memories = await longTermMemoryStore.list(memoryKey(event));
  if (memories.length === 0) return "";
  const lines = memories.map((m) => `- （由${m.authorName}记录）${m.content}`);
  return `以下是关于当前对话的长期记忆（可能有助于理解上下文）：\n${lines.join("\n")}`;
}
```

单聊/群聊不分支，都走同一段格式化逻辑（单聊场景下"由XX记录"的 XX 恒等于该用户自己，信息冗余但无害）。这段文本走的是已有的 `longTermContext` state 字段——`prepareContext` 节点、`llmCall` 纯文本分支、`synthesizeFinalReply` 三处已经在读这个字段（[loop.ts](../../../src/agent/loop.ts)），本次改动不涉及图结构调整。

## 6. 文件改动清单

| 文件 | 改动 |
|---|---|
| `src/agent/memory/long-term.ts` | 新建。`LongTermMemoryStore` 接口 + `node:sqlite` 实现 |
| `src/agent/tools/add-memory.ts` | 新建 |
| `src/agent/tools/delete-memory.ts` | 新建 |
| `src/services/agent.ts` | 补两行 `registerTool` |
| `src/agent/context.ts` | 填实现 `buildLongTermContextText` |

## 7. 明确排除范围

- 向量检索/embedding：`memory_index` 仍是纯文本，交给模型在 `delete_memory` 里做候选列表匹配。
- `modify_memory` 独立工具：不做，需要改内容时先删后加。
- 删除权限校验：不校验发言人身份，任何人可删任意一条。
- 上限可配置化：5 条先写成代码里的常量，不做环境变量/配置项。
