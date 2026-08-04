# Agent 链路重构方案

日期：2026-08-04
范围：仅重构 Agent 聊天（`src/agent/`），不改动普通聊天记忆打通问题（`chatService` 直接删除，见第 5 节）。

## 1. 背景与问题

当前 `src/agent/loop.ts` 用 LangGraph 三节点图（`llmCall` → `tools` → `finalize`）实现 Agent 对话，单聊/群聊共用同一套图。原始设想是"单聊群聊唯一的差异是记忆（上下文）和提示词"，经过对代码的实际排查，差异点比预想的更集中，也暴露了一个既有 bug：

- **记忆键粒度不同**：`memoryKey()`——群聊共享一份 `group:<groupOpenid>`，单聊按人 `c2c:<authorOpenid>`。
- **说话人标注缺失且不一致**：`sqlite.ts` 的 `get()` 只在**读历史**时给群聊 user 消息拼"昵称："前缀，但当前这一轮刚发生的 `userMessage`（`loop.ts` 里 `runAgentTurn()` 构造的那条）从未走这个格式化。这导致 `llmCall` 第一次工具判断调用完全看不到"当前说话人是谁"，只能靠 `finalize`/`plain` 分支里额外拼的一段"当前说话的人是：xxx"文字硬补——这段文字本质是在给"漏了格式化"的那一条消息打补丁，而不是一种必要的场景差异。
- **长期记忆是下一步**：短期记忆已实现（SQLite 窗口），长期记忆尚未实现，但可预见单聊（本人人格画像+关键事实）和群聊（群公共关键事实+发言者画像）在长期记忆的**内容来源**上会有明显差异，即使未来两者都落在"同一种注入点"上。设计必须为此留接口，避免后续再回来动 `loop.ts` 的节点结构。

## 2. 设计目标

1. 修正说话人标注 bug：格式化在**写入时做一次**，之后读/用都不再二次加工。
2. 把"单聊/群聊有什么不同"收拢成显式、可独立扩展的数据源，而不是散落在各节点的 if 分支里。
3. 用 LangGraph 的图结构本身承载"上下文装配"这一步——新增一个专门的准备节点，而不是在 `runAgentTurn()`（图外）或每个业务节点内部各自拼接。
4. 短期记忆本次不改变行为，只修复格式化的时机；长期记忆本次只留空接口，不实现真实读取。
5. 顺带清理入口：`/Agent` 命令与 `chatService` 一并去掉，Agent 变成兜底默认入口。

## 3. 架构总览

新增一个 LangGraph 节点 `prepareContext`，作为图的新起点：

```
START → prepareContext → llmCall ⇄ tools → finalize → END
                              ↓（无工具调用）
                             END
```

`prepareContext` 唯一职责：读取短期记忆历史、格式化当前这句话、拉取长期记忆文本，把结果写进 `AgentState` 的共享字段。之后所有节点（`llmCall`、`toolsNode`、`finalizeNode`）都只从 `state` 上读这些字段，不再各自判断"是不是群聊"。

这把"记忆和提示词的注入"做成了图里显式的一步，而不是隐藏在 `runAgentTurn()` 的普通函数调用里——更符合 LangGraph 的设计意图，也让"以后要不要在装配阶段多做点什么（比如异步拉取长期记忆）"有了自然的扩展点。

## 4. `AgentState` 字段变化

在 `src/agent/loop.ts` 现有 `AgentState`（`StateSchema`）基础上：

| 字段 | 变化 | 说明 |
|---|---|---|
| `messages` | 不变 | 累加式 `ReducedValue`，`prepareContext` 往里面写入初始的 `[AGENT_SYSTEM_PROMPT, ...history, userMessage]` |
| `ctx` | 不变 | `MessageContext`，`prepareContext` 读它拿 `event` |
| `userText` | 不变 | 原始用户输入（未格式化） |
| `history` | 不变 | 短期记忆历史，`prepareContext` 写入，`finalizeNode` 读它拼 prompt |
| `turnCount` | 不变 | 工具轮次计数 |
| `reply` | 不变 | 最终回复 |
| `longTermContext` | **新增** | `z.string().default("")`。`prepareContext` 调用 `buildLongTermContextText(event)` 写入；空字符串表示"没有长期记忆内容"，其他节点据此决定是否插入这段文本。 |

`runAgentTurn()` 的职责收缩为：读取 `sqliteMemoryStore`（这一步本身不算"业务装配"，是基础设施调用，留在图外），构造 `graph.invoke` 的初始输入，调用图，把结果写回短期记忆。真正的"装配"逻辑全部移入 `prepareContext` 节点。

## 5. `agent/context.ts`（新模块）

对外三个函数，纯函数或纯异步取数，不依赖图状态，方便独立测试：

```ts
// agent/context.ts

// 记忆键：群聊整群共享一份窗口，单聊按人隔离。逻辑原样从 loop.ts 挪过来，不变。
export function memoryKey(event: BotEvent): string;

// 短期记忆的说话人格式化：群聊场景在 content 前拼"昵称："，单聊原样返回。
// 只在“写入”这一个时机调用一次（prepareContext 构造 userMessage 时），
// 存进短期记忆的内容已经带前缀，之后读取（sqlite.ts）不再二次处理。
export function formatSpeakerContent(
  content: string,
  authorName: string,
  event: BotEvent,
): string;

// 长期记忆注入文本。单聊：本人人格画像 + 关键事实；群聊：群公共关键事实
//（未来可能还有发言者本人的人格画像）。两种场景的内容来源不同，但对调用方
// 是同一个注入点、同一种字符串形态，因此对外只留一个函数签名，内部将来按
// event.type 分支取数据源。本次仅占位，恒定返回空字符串。
export async function buildLongTermContextText(event: BotEvent): Promise<string> {
  return "";
}
```

`memoryKey` 从 `loop.ts` 移入本模块（原逻辑不变，只是搬家）；`loop.ts` 改为 `import { memoryKey, formatSpeakerContent, buildLongTermContextText } from "./context.js"`。

`buildGroupContextText()`（原来那段"群聊历史消息格式如下…当前说话的人是"提示词）整体删除——不再需要，见第 6 节。

## 6. `sqlite.ts` 改动

`get()` 里的 `isGroup` 判断、`GROUP_KEY_PREFIX` 常量整体删除。存储层不再关心"是不是群聊"这种业务语义，直接返回 `row.content`（格式化已经在写入时做过，读的时候原样返回）。`author_openid`/`author_name` 列保留（长期记忆按人查询、未来 `add_memory`/`delete_memory` 工具都用得上），只是不再参与格式化。

`append()` 不变——它只管落库，不关心 content 是否已格式化。

## 7. 新节点 `prepareContext` 的完整职责

```ts
// 节点零：图的新起点。把"这一轮需要哪些上下文"集中在这一步准备好，
// 后面的节点只管读 state，不用各自判断"是不是群聊"。
async function prepareContext(state: AgentStateT): Promise<AgentUpdateT> {
  const event = state.ctx.event;
  const formattedUserText = formatSpeakerContent(state.userText, event.authorName, event);
  const longTermContext = await buildLongTermContextText(event);

  const userMessage: ChatMessage = { role: "user", content: formattedUserText };
  const initialMessages: ChatMessage[] = [
    { role: "system", content: AGENT_SYSTEM_PROMPT },
    ...state.history,
    userMessage,
  ];

  return { messages: initialMessages, longTermContext };
}
```

注意：`state.history` 和 `state.userText` 需要在 `runAgentTurn()` 调 `graph.invoke` 时作为初始输入传入（沿用现状），`prepareContext` 只是把"构造 `initialMessages`"这个原来在 `runAgentTurn()` 里做的事挪进图内部，`messages` 这个 `ReducedValue` 字段的初始值从"调用前拼好"变成"图的第一步产出"。`runAgentTurn()` 传给 `graph.invoke` 的 `messages` 初始值改为空数组 `[]`。

`sqliteMemoryStore.append()` 存历史时，存入的是 `formattedUserText`（已带昵称前缀），下一轮 `get()` 读出来天然正确，不需要额外处理。

## 8. `llmCall` 改动

工具判断那次调用：不变，直接用 `state.messages`（已经包含格式化后的 `userMessage`），自动获得说话人标注。

plain 分支（无工具调用）：删除 `groupContextText` 拼接，`system` 消息内容恢复为纯 `DEFAULT_SYSTEM_PROMPT`。若 `state.longTermContext` 非空，拼接到 `DEFAULT_SYSTEM_PROMPT` 之后（人设 + 长期记忆，同一条 system 消息）：

```ts
const systemContent = state.longTermContext
  ? `${DEFAULT_SYSTEM_PROMPT}\n${state.longTermContext}`
  : DEFAULT_SYSTEM_PROMPT;
const plain = await callModelWithTools(
  [{ role: "system", content: systemContent }, ...state.messages.slice(1)],
  undefined,
  config.agentModel,
  true,
);
```

`toolsNode` 不变。

## 9. `finalizeNode` / `synthesizeFinalReply` 改动

`synthesizeFinalReply` 的参数列表从 `(userText, history, toolResults, event)` 改为 `(userText, history, toolResults, longTermContext)`——去掉 `event`（不再需要拼群聊说明），换成 `longTermContext: string`。函数内部原来 `groupContextText` 的位置，改为：

```ts
const prompt = `${FINAL_REPLY_SYSTEM_PROMPT}
${longTermContext}
以下是最近的对话记录（供参考上下文）：
${historyText}
...`;
```

`longTermContext` 为空字符串时相当于不插入任何内容，行为等价于当前"单聊场景无群聊说明"的效果，不需要额外的空值判断分支。

`finalizeNode` 调用改为：`synthesizeFinalReply(state.userText, state.history, toolResults, state.longTermContext)`。

## 10. 入口改动

- 删除 `src/services/chat.ts`。`src/services/ai.ts` 的 `askAI`/`DEFAULT_SYSTEM_PROMPT` 保留（`reminder.ts` 仍在用 `askAI`）。
- `src/registry.ts`：删除 `chatService` 的 import 与 `registerCommand(chatService)`；`defaultCommand` 改为 `agentService`；**不**对 `agentService` 调用 `registerCommand`，因此 `/Agent` 关键词彻底失效（落入"未知命令"分支），只有不带 `/` 的消息才路由到 Agent。
- `src/services/agent.ts` 的 `handle()`：取值方式从固定读 `ctx.args` 改为 `ctx.command === null ? ctx.text : ctx.args`（对齐原 `chatService` 的取值方式，兼容"以后加 `/闲聊` 之类新命令走同一个 handler"的可能性）；空输入提示文案去掉对 `/Agent` 的引用，改为通用措辞（例如"跟本鲸鱼说点什么吧～"）。

## 11. 与 `docs/long-term-memory-plan.md` 的冲突说明

该文档写于本次讨论之前，假设"长期记忆只在单聊场景插入"。本次讨论已确认群聊未来也会有长期记忆（群公共关键事实 + 可能的发言者人格画像），只是内容来源与单聊不同。该文档的这一条假设已过期，本方案不在这次顺手修正它（超出本次重构范围），留待实际实现长期记忆时一并更新，并对齐本方案第 5 节 `buildLongTermContextText` 的接口形状（`(event) => Promise<string>`，内部按 `event.type` 分支取数据源，而不是"仅单聊调用、群聊整体跳过"）。

## 12. 改动文件清单

| 文件 | 改动 |
|---|---|
| `src/agent/context.ts` | 新建。`memoryKey`、`formatSpeakerContent`、`buildLongTermContextText`（占位） |
| `src/agent/loop.ts` | 新增 `prepareContext` 节点并接入图起点；`AgentState` 新增 `longTermContext` 字段；删除 `buildGroupContextText`、`memoryKey`（移入 `context.ts`）；`llmCall` plain 分支、`finalizeNode`/`synthesizeFinalReply` 按第 8/9 节调整；`runAgentTurn()` 精简（`messages` 初始值改为 `[]`，构造 `initialMessages` 的逻辑移入 `prepareContext`） |
| `src/agent/memory/sqlite.ts` | 删除 `isGroup` 判断与 `GROUP_KEY_PREFIX` 常量，`get()` 直接返回 `row.content` |
| `src/services/chat.ts` | 删除 |
| `src/registry.ts` | 删除 `chatService` 相关注册；`defaultCommand` 改为 `agentService`；不注册 `/Agent` 关键词 |
| `src/services/agent.ts` | `handle()` 取值方式改为兼容"无命令兜底"；空输入提示文案改通用措辞 |

## 13. 本次不做的事（明确排除范围）

- 不实现真实的长期记忆读取/写入——`buildLongTermContextText` 本次恒定返回空字符串，真实实现见 `docs/long-term-memory-plan.md`（且该文档需要在实现时按第 11 节更新单聊/群聊假设）。
- 不打通 `chatService`/`askAI` 与 Agent 的记忆——`chatService` 直接删除，以后要恢复轻量聊天，按用户确认的方式在 LangGraph 图里加新节点和条件边接入，不是本次范围。
- 不引入策略模式/接口抽象（`SingleChatScope`/`GroupChatScope` 之类）——当前差异集中在两三个纯函数上，用接口是过度设计（YAGNI），除非未来出现第三种场景（如频道消息）。
- 不加"发言人格式化"的额外说明文字（原 `buildGroupContextText` 那类"群聊历史消息格式如下"提示）——依赖模型从"昵称：内容"的重复格式模式中自行推断说话人，如后续观察到模型误把昵称当正文，再考虑补一句极简说明。
