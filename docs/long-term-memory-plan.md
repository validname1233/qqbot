# 单聊长期记忆方案

## 1. 目标与范围

- 只覆盖**单聊场景**。群聊的长期记忆（人格画像等）不在本方案内，留给以后单独设计。
- 目标：让 agent 能跨会话记住关于某个用户的事实性信息，并支持用户主动"添加记忆"和"删除记忆"。
- 定位类似 Claude Code 的记忆机制：一条记忆一行，配一个由大模型提取的"记忆索引"，检索/删除时靠索引做语义匹配，而不是死板的关键词全文匹配。
- 和短期记忆（[sqlite.ts](../src/agent/memory/sqlite.ts)）是两套独立表、独立接口，不混用同一个 `MemoryStore`。

## 2. 表设计

```sql
CREATE TABLE IF NOT EXISTS long_term_memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_openid TEXT NOT NULL,        -- 单聊用户 openid，长期记忆按用户区分（不含群聊）
  content TEXT NOT NULL,            -- 记忆正文：用户要求记住的原始内容
  memory_index TEXT NOT NULL,       -- 记忆索引：大模型对 content 提取的摘要/关键词，用于删除/修改时的语义匹配
  created_at INTEGER NOT NULL,      -- 创建时间戳（Date.now()）
  updated_at INTEGER NOT NULL       -- 最近一次更新时间戳，创建时等于 created_at；被修改时刷新
);

CREATE INDEX IF NOT EXISTS idx_long_term_user ON long_term_memories(user_openid);
```

字段设计要点：

- `user_openid` 而非 `key`：长期记忆的隔离粒度天然是"人"，不需要复用短期记忆那套 `c2c:`/`group:` 前缀 key，直接存 openid 更直接。
- `memory_index` 是本方案的核心：不是简单摘要，而是专门为"后续匹配"服务的检索用文本。写入时机是 `add_memory` 工具内部，见第 3 节。
- 不设外键约束、不做级联删除——单张表，删除都是按 `id` 精确打。

## 3. 工具设计

新建 `src/agent/memory/long-term.ts`（存储层）和两个工具文件：`src/agent/tools/add-memory.ts`、`src/agent/tools/delete-memory.ts`。工具通过 [tool.ts](../src/agent/tool.ts) 的 `Tool` 接口注册，模型自主判断何时调用——不是关键词硬匹配，而是把"用户说了类似记住/删除记忆的话"写进 `description`，让模型自己识别触发时机。

### 3.1 存储层接口

```ts
// agent/memory/long-term.ts
export interface LongTermMemory {
  id: number;
  content: string;
  memoryIndex: string;
  createdAt: number;
  updatedAt: number;
}

export interface LongTermMemoryStore {
  add(userOpenid: string, content: string, memoryIndex: string): Promise<number>; // 返回新记忆的 id
  list(userOpenid: string): Promise<LongTermMemory[]>; // 供 delete/modify 工具读出索引做匹配
  remove(id: number): Promise<void>;
  update(id: number, content: string, memoryIndex: string): Promise<void>; // "修改记忆"复用
}
```

和短期记忆的 `MemoryStore` 是两个独立接口，不合并——读写模式完全不同（短期记忆是"整段窗口读写"，长期记忆是"按条目增删改"）。

### 3.2 add_memory 工具

- 触发时机（写进 `description` 让模型判断）：用户说"记住这件事""添加记忆：xxx"之类的话。
- 参数：`content`（string，必填）——工具描述里要求模型把"用户想记住的内容"原样抽出来传进来，不夹带"记住"这几个字本身。
- `memory_index` **不是模型直接传的参数**，而是工具 `run()` 内部另起一次模型调用生成，理由：
  - 索引的质量要求和 `content` 的抽取要求不一样（索引要偏向未来检索/匹配用的关键词和场景描述），交给同一次工具调用里的模型输出容易和 `content` 参数本身混在一起，不如拆成两步各自专注。
  - 拆开后 prompt 更可控：`add_memory` 工具内部固定一段"请从下面这句话中提炼简短的记忆索引，用于以后检索/匹配"这样的系统提示词，单独调 `callModelWithTools`（不带 tools，走轻量模型即可）。
- 流程：`run(args, ctx)` → 取 `args.content` → 调模型生成 `memoryIndex` → `longTermMemoryStore.add(ctx.event.authorOpenid, content, memoryIndex)` → 返回一句确认话术给模型拼进最终回复。

### 3.3 delete_memory 工具

- 触发时机：用户说"删除记忆""忘掉xxx"之类的话。
- 参数：`query`（string，必填）——用户想删除的记忆的自然语言描述（不是 id，用户不知道 id）。
- 流程：
  1. `longTermMemoryStore.list(ctx.event.authorOpenid)` 读出该用户全部记忆的 `id` + `memoryIndex`。
  2. 把 `query` 和这份 `(id, memoryIndex)` 列表一起丢给模型，让模型判断"最匹配 query 的是哪个 id"（一次单独的模型调用，返回结构化的 `{ id: number | null }`，匹配不到就返回 null）。
  3. 匹配到 id 就 `longTermMemoryStore.remove(id)`，工具返回确认话术；匹配不到就返回"没找到匹配的记忆"。
  4. "修改记忆"是同一条路径的变体：先用同样的方式匹配出 id，再 `update(id, ...)` 而不是 `remove(id)`。本方案先只实现 delete，update 留一个同样结构的工具位置，暂不接（等实际用到再补 `modify_memory` 工具）。

## 4. 长期记忆如何进入对话

新增一步：`runAgentTurn()`（[loop.ts](../src/agent/loop.ts)）在拼 `initialMessages` 之前，先用 `longTermMemoryStore.list(ctx.event.authorOpenid)` 读出该用户的全部长期记忆，格式化成一段文本，作为单独一条 `system` 消息插在短期记忆历史之前：

```
以下是关于这位用户的长期记忆（可能有助于理解上下文）：
- xxx
- xxx
（无长期记忆则跳过这一条 system 消息，不插入空文本）
```

只在**单聊**场景插入——`ctx.event.type !== "GROUP_AT_MESSAGE_CREATE"` 时才读取和拼接，群聊分支不动。这一步不引入新的路由判断复杂度，直接在 `runAgentTurn` 里加一个 if。

`add_memory` / `delete_memory` 两个工具同样只在单聊场景下有意义，但暂时不做"仅单聊可见"的工具级限制——工具的 `run()` 内部本来就是用 `ctx.event.authorOpenid`，群聊场景下这个字段依然存在（member_openid），如果群里有人误触发，效果是"以这个人的 openid 建了一条长期记忆，且只会在他单聊时被读到"，不会串给别人，行为上无害，先不做额外拦截，观察实际使用情况再决定是否要显式禁用。

## 5. 需要新增/修改的文件清单

| 文件 | 改动 |
|---|---|
| `src/agent/memory/long-term.ts` | 新建。`LongTermMemoryStore` 接口 + `node:sqlite` 实现，表结构见第 2 节 |
| `src/agent/tools/add-memory.ts` | 新建。`add_memory` 工具 |
| `src/agent/tools/delete-memory.ts` | 新建。`delete_memory` 工具 |
| `src/services/agent.ts` | 补两行 `registerTool(addMemoryTool)` / `registerTool(deleteMemoryTool)` |
| `src/agent/loop.ts` | `runAgentTurn()` 单聊分支插入长期记忆 system 消息 |

## 6. 暂不做的事（明确排除范围）

- 群聊长期记忆 / 人格画像——用户已表示"暂不考虑"，等短期记忆的群聊部分稳定后再单独设计。
- 记忆的向量化检索（embedding + 相似度搜索）——`memory_index` 目前是纯文本，交给模型在 `delete_memory` 里做"文本列表里选一个最匹配的"，条目数量小的时候够用；条目多了以后再考虑换向量检索。
- 记忆的过期/容量上限——不设 `MAX_MEMORIES` 之类的截断，长期记忆定义上就是要一直留着，除非用户主动删除。
- `modify_memory` 独立工具——第 3.3 节已说明，先不接，等真正用到再补。

