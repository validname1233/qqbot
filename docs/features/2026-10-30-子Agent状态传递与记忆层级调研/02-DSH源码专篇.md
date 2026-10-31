# DSH（DeepSeek Harness）源码专篇：子 Agent 与会话记忆的实现

> 2026-10-30。源码：github.com/deepseek-ai/deepseek-harness（26.7 万 star，
> 本地浅克隆通读）。所有结论带源码路径（相对 packages/）与代码摘录。
> DSH 是我们 v9 直通架构与"log-as-truth"原则的参考项目——本篇看它把这两条
> 原则之下的**子 Agent 状态传递**和**记忆持久化**做到了什么深度。

## 0. 总体架构：event-sourcing，主/子各持独立日志

DSH 是 **event-sourcing 架构**：每个 Agent（主/子）各持有**一个独立的
append-only `SessionEvent` 日志**（即 Session）；messages 不是存储，而是由
`Session.deriveMessages()` 从日志"表面"（surface）派生的冻结投影——这就是
log-as-truth（与我们 conversation_events 单表 + L1 投影同构，但 DSH 把投影
做成了带缓存和遮蔽语义的正式机制，见 §4）。

子 Agent 通过 provider 注册表唤起（`spawn`/`fork`/`acp`/dsh-sdk），由
`SubagentManager` 统一管理生命周期。

## 1. 唤起时传什么（问题 A）

**四类内容，且"是否继承父历史"由 provider 决定**：

1. **任务 prompt**（所有 provider）：工具层构造 `prompt: [{type:'text',
   text: args.prompt}]`（subagent/tool-subagent/src/index.ts:317）——与我们
   的规格书同源；
2. **父历史 seed（仅 fork）**：`subagent/subagent-fork-in-process/src/index.ts:46-78`
   ——取父日志**到最后一个 `turn/end` 为止的前缀**（未完成的 turn 不能重放），
   一次性作为子会话的 seed 事件，之后就是子自己的转录：

   ```ts
   function completedTurnPrefix(parent: Agent): SessionEvent[] {
     const events = parent.session.snapshotEvents()
     const lastEnd = events.findLast(e => e.type === 'turn/end')
     return lastEnd === undefined ? [] : events.slice(0, lastEnd.seq + 1)
   }
   ```

   spawn 后端则显式返回 `{}`（`inheritsParentContext = false`，零父上下文）；
3. **结构化 meta + 策略事件**：子会话 header 持久化
   `parentSession/isSeeded/origin:'subagent'/delegationDepth`（递归委派深度，
   resume 不重置）；父的沙箱/审批策略以 `source:'delegation'` 事件**写进子日志**
   （subagent/subagent/src/manager.ts:437-455、child-agent.ts:135-154）：

   ```ts
   childSession.append('sandbox/mode', { mode, source: 'delegation' })
   childSession.append('approval/policy', { policy: 'never', source: 'delegation' })
   ```

4. **AgentOptions 继承**：provider/model/reasoningEffort/maxTokens 沿父配置。

   另外 fork 的初始 prompt 会附加 send_message 指引，明说边界：*"The parent
   shares your workspace but does not automatically receive your transcript,
   tool output, or reasoning"*（continuation-messages.ts:80-96）。

**对照我们**：workspace_task 只传第 1 类。DSH 的启发是第 3 类——**策略与元数据
走事件而非参数**（父对子的授权/预算声明是子日志的一部分，可审计、可恢复）。

## 2. 结果如何回流（问题 B）

**不是 tool result**——这是 DSH 与我们（以及与 Claude Code 前台模式）最大的
差异：

- `subagent` 工具**立即返回 childId**（`{kind:'activation', subagentId}`，
  fire-and-forget），系统提示要求主 Agent"结束当前 turn 等通知"；
- 子 Agent 结束后，manager 构造一条 `source.kind='subagent-settled'` 的
  **user message** 注入父的 inbox（subagent/subagent/src/continuation-messages.ts:140-172）：
  摘要行 + 最后一条非空 assistant 输出（closing text）+ 可选的
  `Structured result: {JSON}`；
- 投递方式按父状态选：父空闲 → `queue`（排队成新 turn）；父运行中 → `steer`
  （在最近的步边界插进运行中的循环）（manager.ts:1206-1218）；
- **运行中双向通信**：子 Agent 有 `send_message` 工具可主动向父发消息
  （source 标 `agent-message`/`relay`）——长任务的中间汇报通道；
- 父日志里另有 `subagent/catalog` 事件记录子 Agent 清单（listChildren 发现用）。

**对照我们**：workspace_task 是同步等结果（tool result 回流）——适合分钟级
任务；DSH 的异步 settlement 适合"主 Agent 同时干别的"的场景。我们的深检
（30-60s）介于两者之间，同步等待可接受（方案①里已拍板）。

## 3. 子 Agent 的持久记忆（问题 C）

**有，且是第一公民**——每个子 Agent = 一个独立 Session（自己的 SessionId 和
事件日志）：

- **continuable 子 Agent 强制要求持久化后端**（manager.ts:1479-1488：
  "continuable subagents require session persistence"，否则报
  PERSISTENCE_UNAVAILABLE）；
- 持久化三层：内存真相（Session.append）→ 写入句柄（persistence.create 拿
  SessionHandle，增量 handle.append，core/agent-loop/src/index.ts:688-709）→
  物理层（session/session-persistence-jsonl：每会话一目录、不可变 generation
  文件、默认 zstd 压缩，append 尽力写、flush 是持久化屏障）；
- 子 Agent 的 durable 元数据：`subagent/descriptor` 事件（version=3，含
  provider/mode/label/agentModel/persona/toolFilter——**"Log-only：无 surfaceOp、
  永不进模型历史、压缩后仍存活"**，descriptor.ts:29-40）；
- **冷恢复**：不重跑 provider，直接从持久层读 header+events 重建子 Agent 并
  `agents.resume({resumeSessionId})`（manager.ts:1349-1404）——重启后子 Agent
  可继续。

**对照我们**：深检子 Agent 化方案里的"process 行落库"是这个机制的简化版
（归档但不可见）；DSH 的完整版还多两层——descriptor 元数据（我们可用 origin
列近似）与冷恢复（我们的子 Agent 无状态、无恢复需求）。

## 4. SessionEvent 事件流与 messages 投影（问题 D）

**核心 14 种事件 + 插件可扩展**（core/session/src/types.ts:287-436）：

- 边界：`turn/start|end`、`step/start|end`
- 表面消息（产生 LLM 消息的 5 种）：`user/message`、`developer/message`、
  `system/message`、`assistant/message`、`tool/result`
- 日志型（不产生消息）：`assistant/attempt`（失败尝试原文）、`tool/call`
  （name+arguments 原文）、`request/header`、`request/context`、`session/end-seed`
- 插件合并：`compaction/*`、`subagent/descriptor|catalog`、`sandbox/mode`、
  `approval/policy`……

**messages 投影**（core/session/src/index.ts:999-1020）：表面事件携带
`surfaceOp`——`append`（追加）或 `{op:'replace', startSeq, endSeq}`（顶替区
间）；`deriveMessages()` 沿表面节点折叠派生，缓存按 contentGeneration 失效，
返回值 deep-frozen。主循环每次请求都调它取消息（agent.ts:728-743）。

**主/子不同流**：子的 header.parentSession 指父，但事件各自独立；父流只有
catalog + settlement/agent-message 消息，子的完整转录在子流。

**对照我们**：我们的 chat/process 二分 ≈ DSH 的 surface/log-only 二分；DSH 多出
的是 **replace 语义**（压缩的载体，见 §5）与 assistant/attempt（失败尝试的
档案——我们的 process 行只记成功的）。

## 5. overflow/spill：两种互补机制（问题 E）

**spill（单条工具结果溢出）**：`tools/post-execute` hook 估算 token 超过
`maxInlineTokens` → 全文存外部（spillStore.saveText，每会话哈希目录、0600 文件），
inline 替换为 head/tail 各半预算 + `[...]` GAP + notice（内嵌文件定位符和
retrievalHint，模型可用文件工具读回）（spill/spill-policy/src/index.ts:134-156、
notice.ts:21-24）。

**compaction（区间摘要化）**——触发三处（compaction/compaction-basic/src/
index.ts:147-257）：每步前的压力检查（token 超阈值）；`request-error` 收到
context-overflow 时强制压缩（先清旧 tool result 再摘要，有限重试后重发）；
模型切换时按新窗口预检。**提交方式是事件流的精髓**（region.ts:491-509）：

```ts
const summaryEvent = session.append('compaction/summary', { compactionId, summary,
  shadowedRange: { start, end }, ... })
session.append('user/message', checkpointMessage, {
  surfaceOp: { op: 'replace', startSeq: start, endSeq: end } })
```

**日志永不删除，只是表面遮蔽**——被遮蔽节点立即从 deriveMessages() 消失，
但原始事件可审计回放。摘要必须小于被遮蔽内容的 token 价，否则报错。

**对照我们**：这正是我们 v10 决策时**放弃**的摘要路线的"正确实现形态"——
DSH 用 replace 语义做到了"压缩不丢真相"（我们的 L2 全量 + L1 过滤是另一个
方向的同解：库不动，视图裁）。两者等价性值得记录：**DSH=写遮蔽事件+投影全
算；我们=不写任何东西+投影过滤**。我们的方案少了"摘要保留部分信息"的收益，
但零机制成本——v10 已论证 QQ 场景旧对话价值衰减快，接受。spill 机制对我们
有独立价值：**单条工具结果过大**（如 open_page 返回巨页）时 head/tail+引用
是比"全文塞进轮内"好的形态，可列为深检子 Agent 化后的观察项。

## 6. 并发与中断（问题 F）

- **并发容量池**：`maxActiveSubagents: 8`，满则 ACTIVATION_LIMIT_REACHED；
  subagent 工具声明 `isConcurrencySafe: true`——同一条消息可并行启动多个
  子 Agent（activation.ts:24-35）；
- **中断两级授权**：`Agent.cancel({kind:'user'|'parent'})`——user 需精确
  parentSessionId 匹配，parent 需是注册表中的同一 live 实例（祖先）；
  cancel 清 inbox（可 keepInbox）+ abort 下发（manager.ts:184-228）。流式中
  断时已交付前缀固化为 `assistant/message{interrupted:true}` 落日志——
  **中断本身是日志事件**；
- **级联 teardown**：父 dispose → 对每个子 `cancel({kind:'parent'})` → 等
  idle → 递归销毁（child-first）→ 冲刷 → settlement 通知
  （manager.ts:1113-1163）；
- inbox 也是持久化投影（agent/inbox/spliced 事件折叠，恢复后未领取输入仍在）。

**对照我们**：深检方案的"借用父闸 + signal 接线"对应 DSH 的 parent 级中断；
我们没有容量池（单租户互斥闸天然限 1，子 Agent 并发=主 Agent 的轮内并发，
MAX_TOOL_TURNS 兜底）——架构差异而非缺陷。

## 7. 值得抄进我们项目的清单（按优先级）

1. **深检 process 行落库**（已在方案里）：对应 DSH 的子日志归档，形态取
   简化版（共流 + origin 标记）；
2. **工具描述按四字段配方重写**（Anthropic 配方，见 01 篇）：DSH 的 subagent
   工具 schema 也是结构化多字段（description/prompt/cwd/mode）而非单 blob；
3. **结构化结果**（`Structured result: {JSON}`）：深检报告未来若有机器消费
   场景再加；
4. **观察项**：spill（单条工具结果 head/tail+引用）；assistant/attempt
   （失败尝试档案——我们 process 行目前只记成功输出）；
5. **不做**：异步 settlement（我们的同步等待够用）、冷恢复 resume（无状态
   子 Agent 无需求）、独立子日志文件（单表 + origin 列的简化版够用）。
