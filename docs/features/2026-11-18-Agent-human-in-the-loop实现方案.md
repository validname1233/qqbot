# Agent Human-in-the-Loop 实现方案（审批闭环）

> 2026-11-18。目标：Agent 工作流遇到风险操作时，经 QQ 回调按钮向用户征求
> 许可——**询问期间工作流挂起**，用户点"允许/拒绝"后从挂起点继续。这是
> 通用按钮接口（2026-11-10-回调按钮实现方案.md，已交付）之上的第一个业务
> 消费方。
>
> 前置讨论定案（2026-11-18 对话）：
> - 拒绝语义 = **工具文本回流**：deny 不杀死循环，而是作为工具结果返回给
>   模型（"操作被用户拒绝，不要重试同样的操作"），由模型自行换方向或收尾；
> - 阻塞机制 = **Promise 闸**（await 挂起），不引入 LangGraph interrupt()/
>   checkpointer（我们的图是无状态内存调用，长命异步链天然支持挂起）；
> - 审批只走按钮回调一条交互线（无文本命令兜底——2026-11-10 决议），
>   按钮消息发送失败 = 本次审批失败（工具返回错误文本）；
> - 未来扩展："用户输入提示词改路线" = 返回类型加 variant，接口形状预留。

## 1. 背景：两个独立事件流的会合

审批的"问"与"答"是**两个互不相识的事件**：

```
事件 A（聊天链）                         事件 B（按钮链，已交付）
  @bot "清理临时文件"                      用户点"允许"
  → Agent 循环 → 风险点                     → INTERACTION_CREATE
  → await requestApproval(...)             → 管道 → ButtonHandler("approval")
  → Promise 挂起（链停着，事件循环空闲）          │
        │存钥匙                                      │查钥匙
        ▼                                           ▼
      pending Map（approvalId → resolve 回调）◄──────┘
        ▲ resolve("allow")
        └──────► await 醒来 → 执行/中止 → 循环继续
```

关键事实（源码核实）：

- **挂起不阻塞进程**：`await` 只是 async 链停在等 resolve，Node 事件循环
  空闲，事件 B 正常进入（深检挂 1~3 分钟期间群消息照常回复是既有证明）；
- **每会话单流程闸**（session/interrupt.ts）保证同一租户只有一个 Agent 流程
  在跑——审批挂起期间该会话发起新任务会被闸拒绝，不存在"两个任务等同一个
  审批"的歧义；
- **工具文本回流路径现成**：loop.ts toolsNode（src/agent/loop.ts:114-142）
  把工具 return 的字符串包成 `{role:"tool", tool_call_id, content}` 追加进
  messages——**不是序列化，是原字符串**；deny 文本与执行输出走完全同一条
  路径，loop 零改动。

## 2. 分层：新增什么、复用什么

| 层 | 状态 | 内容 |
| --- | --- | --- |
| 按钮管道（解析/分流/回应/路由） | ✅ 已交付 | 2026-11-10 方案全部落地，真机链路已验证 |
| **审批机制层（本方案主体）** | 🆕 新增 | `services/buttons/approval.ts`：pending Map + requestApproval + 点击处理器 + TTL/stop 联动 |
| **风险点接入层** | 🆕 新增 | workspace exec 工具加审批前置（首个）；后续逐点接入 |
| Agent loop / 图 | ✅ 零改动 | 挂起=await，回流=既有 tool 消息路径 |
| 记忆 | ✅ 零改动 | 询问消息与回执走 push（record:false 或正常落库均可——询问消息是 bot 出站，落 chat_bot 行合理） |

## 3. 核心实现：approval.ts（预计 ~190 行）

### 3.1 pending Map（两个事件流的 rendezvous）

```ts
interface PendingApproval {
  resolve: (d: ApprovalDecision) => void;
  timer: NodeJS.Timeout;
  flowKey: string;          // /stop 联动锚点
  createdAt: number;
  deniedCount?: number;     // 熔断计数（§3.5），同 flowKey 共享
}
const pending = new Map<string, PendingApproval>();
```

### 3.2 requestApproval（风险点唯一入口）

```ts
type ApprovalDecision = "allow" | "deny";

async function requestApproval(
  ctx: MessageContext,
  opts: { kind: string; title: string; detail: string; ttlMs?: number },
): Promise<ApprovalDecision> {
  // ⓪ 任务级授权短路（§3.6）：本流程本类别已授权 → 直接放行，零交互
  if (isFlowGranted(flowKey, opts.kind)) return "allow";
  // ① 生成钥匙 + 发询问消息（现有设施组合：pushGroup/C2CMarkdownWithKeyboard
  //    + 三按钮：允许一次 / 本任务内均允许 / 拒绝——见 §3.6）
  //    发送失败 → 直接 throw（工具层 catch → 回流"审批消息发送失败"文本，
  //    模型自行收尾——2026-11-10 决议：无文本兜底路线）
  // ② 存钥匙 + 挂 Promise：
  return new Promise((resolve) => {
    const timer = setTimeout(() => conclude(id, "deny", "超时"), opts.ttlMs ?? DEFAULT_TTL);
    pending.set(id, { resolve, timer, flowKey: tenantKey(ctx.event), createdAt: Date.now() });
    // ③ /stop 联动：abortSignal 监听（currentFlowSignal(flowKey)），拉闸时
    //    未决审批全部 conclude(deny)——流程已死，审批无意义；顺手清授权表（§3.6）
  });
}
```

### 3.3 点击处理器（注册 "approval" 命名空间）

```ts
async function handleApprovalClick(interaction: ButtonInteraction): Promise<boolean> {
  // payload 形如 "allow-once:a3f2c1b0" / "allow-task:a3f2c1b0" / "deny:a3f2c1b0"
  // ① 验权（§5.1：比对 userOpenid 与发起人/管理员快照名单）
  // ② action 分发：allow-once → conclude(id,"allow")；
  //    allow-task → conclude(id,"allow") + 授权表写入（§3.6）；deny → 熔断计数 + conclude
  // ③ 幂等：pending 查不到 = 已决/过期/已作废 → 推一条"该审批已处理"提示
}
```

### 3.4 conclude（幂等结案——竞态唯一出口）

```ts
function conclude(id: string, decision: ApprovalDecision, reason?: string): void {
  const entry = pending.get(id);
  if (entry === undefined) return;   // 点击 vs TTL vs /stop 竞态：先到先得，后到吞掉
  pending.delete(id);                // 先删再 resolve——二次点击自然落"已处理"
  clearTimeout(entry.timer);
  entry.resolve(decision);
  // 顺手推结果通知（"已允许/已拒绝/超时自动拒绝"）——用户反馈闭环
}
```

### 3.5 熔断（拒绝风暴防线）

同 flowKey 的风险点被拒累计 ≥2 次（Map 外挂一个 per-flow 计数），工具直接
返回"该类操作已被多次拒绝，请与用户确认方案后重新发起任务"，不再发新审批
——防模型反复换写法重试被拒操作。任务结束（flow 注销）时计数清零。

**拒绝不做任务级**（刻意不对称）：授权是用户给的信任，可复用；拒绝针对
具体操作，不该连坐后续合理变体——连续拒绝由熔断兜住即可。

### 3.6 任务级授权（授权缓存，2026-11-18 补充定案）

机制核心：**用户首次 allow-task 的结论本身就是授权凭证**，后续 exec 只需
查"本任务本类别授过权没有"——零新通信部件，一张内存表 + 一个入口短路。

```ts
// 任务级授权缓存：flowKey+kind → 授权时刻
const grantedFlows = new Map<string, number>();

// requestApproval 入口短路（§3.2 的 ⓪）：
//   grantedFlows.has(`${flowKey}|${kind}`) → 直接 return "allow"，零交互
// 点击处理器的 allow-task 分支：
//   conclude(id,"allow") + grantedFlows.set(`${flowKey}|${kind}`, Date.now())
```

**生命周期管理（清理落点 = 方案 b，2026-11-18 拍板；实现期升级为信号
身份锁，见下）**——授权是状态，状态要回答"何时过期"；正确性锚点是
"flowKey 的生灭 = 任务的生灭"：

★ **实现期修正（2026-11-18 实现时发现）**：flowKey 字符串在同一会话的先后
两个任务间**相同**（group:xxx），仅靠方案 b 原文的"拉闸清空 + 时效兜底"
锚定，存在泄漏窗口——任务**正常结束**（非拉闸）不触发 abort 清理，时效
兜底（任务预算+5min）又晚于新任务开始：上个任务的授权会泄漏进同会话的
下一个任务。修正：改用 **AbortSignal 对象身份**做任务实例锁——
beginControlledFlow 每次任务新建 controller，`currentFlowSignal(flowKey)`
返回的 signal 对象即任务实例的唯一令牌；授权/熔断条目存储发起时的 signal，
查询时比对**对象身份**（`===`）：不是同一对象 ⇒ 已是新任务 ⇒ 缓存作废。
拉闸清空与时效兜底保留为防御性双保险，正确性主锚是信号身份比对。
（实现见 approval.ts 的 isFlowGranted/denyCountOf 的 signal 字段比对。）

| 时机 | 动作 | 落点 |
| --- | --- | --- |
| 任务开始 | 无动作（表里没有 = 未授权，惰性） | 不动 interrupt.ts |
| 用户点"本任务内均允许" | grantedFlows.set（存 signal 引用） | 点击处理器 allow-task 分支 |
| 任务被 /stop | 清该 flowKey 全部条目 + denyCount | approval 自监听 abortSignal（requestApproval 已拿 currentFlowSignal，/stop 联动的同一段代码顺手清） |
| 任务正常结束（无 abort 信号） | **信号身份失配自动作废**（下个任务的 currentFlowSignal 是新对象） | isFlowGranted/denyCountOf 查询时惰性判定 |
| 兜底 | 条目超任务预算+5min 视为过期 | 防御性双保险（非正确性主锚） |

正确性论证：流程闸保证同 flowKey 同时只有一个任务（begin 拒绝并发），所以
"flowKey+kind 已授权"精确等价于"**当前这个任务**曾获授权"——上个任务的授权
不会泄漏到下个任务（拉闸时已清），并发任务不存在（被闸拒了）。双重保险
（abort 清理 + 时效兜底）之下零泄漏，且不动任何公共模块（不选方案 a 的
interrupt.ts 回调广播——为一个消费方扩公共接口不划算）。

**交互**：首次询问的按钮从两个变三个——`[允许一次] [本任务内均允许] [拒绝]`，
button_data 相应加 action 变体（allow-once / allow-task / deny）。

**粒度边界（诚实记录）**：授权粒度是 kind（如 workspace-exec）——用户授权的
是"本任务内的命令执行"这个类别，不是某条具体命令；任务后半段模型自作主张
的危险命令同样被放行。询问文案必须说透（"本任务内的命令执行将不再逐条
询问"），detail 展示当前命令作为信任样本。将来若嫌粒度粗，升级路径是命令
前缀白名单（Claude Code 做法：`git *` 授权、`rm *` 仍问）——Map 的 value
从时间戳变前缀列表，结构兼容，一期不做。

### 3.7 拒绝/超时的回流文本（与既有工具错误同构）

```ts
// 风险点（exec 工具内）：
const decision = await requestApproval(ctx, { kind: "workspace-exec", title: "...", detail: cmd });
if (decision === "deny") {
  return `操作被用户拒绝：${cmd}\n不要重试同样的操作；可以询问用户希望如何调整，或改用更安全的方式。`;
}
// allow → 照常执行；超时的 deny 文本额外带"（审批超时）"
```

回流后循环继续，模型自行换方向或收尾——**审批结果从此刻起消失，剩余全是
既有循环的正常运转**（人在回路上注入的意图被压缩成一次普通工具返回值）。

## 4. 大体工作流（时序）

```
T0  用户 @bot → 事件 A → Agent 循环 → workspace_task 子图 → exec 工具
T1    exec 判定风险（§6 策略）→ await requestApproval
      ├─ 授权缓存命中（§3.6：本任务本类别已 allow-task）→ 直接 allow，跳到 T5
      └─ 未授权 ↓
T2      发询问消息（三按钮：允许一次/本任务内均允许/拒绝）→ pending 存钥匙
       ★ Agent 链挂起；流程闸仍持有（/stop 可用）；事件循环空闲
T3  用户点按钮 → 事件 B → 管道（回应/去重/切ns）→ handleApprovalClick
T4    验权 → action 分发（allow-once / allow-task+写缓存 / deny+熔断计数）
        → conclude → resolve → 通知
T5  T1 的 await 醒来 → 执行命令 → 结果/拒绝文本回流 → 循环继续 → 收尾
--
超时支线：TTL（10min）到 → conclude(deny,"超时") → 通知 → 同 T5 拒绝路径
/stop 支线：拉闸 → abortSignal 触发 → 全部 pending conclude(deny) +
           授权缓存清空 → Agent 链被 AbortError 终止（既有机制），审批不留残骸
后续支线（授权缓存生效）：本任务下一次 exec → T1 短路 → 直接 T5，用户零感知
```

## 5. 已定决策（2026-11-18 拍板）

1. **审批权限模型：仅群主/管理员可点**。已有可复用的判据——工作台/知识库
   入口按钮的闸①（workspace-console.ts:40 / knowledge-base.ts:66 同款）：
   `event.authorRole !== "admin" && event.authorRole !== "owner"` 拒绝。
   **但注意挂接点不同**：那两处验的是**发命令的人**（聊天事件，authorRole
   现成）；审批按钮点击是 INTERACTION_CREATE 事件，**没有 authorRole 字段**
   （只有点按人 openid）。所以实现是"快照式验权"：
   - requestApproval 时（事件 A 上下文，authorRole 可得）把**本会话管理员
     openid 名单**快照进 pending 条目——发起人 openid + 发起人是不是管理员
     （是则加入名单）；
   - 点击时（事件 B）比对 `interaction.userOpenid` 与名单，不在名单 → 回
     "仅群主/管理员可操作"提示，不 resolve；
   - 局限（记录在案）：无法枚举全部管理员（QQ 不给群成员表），名单只含
     发起人这一位管理员；**其余管理员点击会被误拒**。缓解：管理员通常
     就是发起人（发起 @bot 的人）；真机观察误拒频率，必要时加"管理员
     点不了就让发起人点"的提示文案。这是平台数据边界内的最优解。
   - 单聊天然免验（消息只到本人，点按钮的必是本人）。
2. **TTL = 10 分钟**（默认值定案，config 项可调）。
3. **"本任务内均允许"第三按钮：定案加入**（2026-11-18 更新，原"一期不加"
   经任务级授权设计讨论后推翻）。机制见 §3.6：授权缓存 + 入口短路 + 清理
   落点 = approval 自监听 abortSignal（方案 b）+ 时效兜底。拒绝刻意不做
   任务级（§3.5 不对称原则）。
4. **总开关**：`APPROVAL_MODE=off|risky|all`（config），默认 off 上线观察。
   风险策略（什么算风险）不进机制层——各风险点调用侧自定（Codex 三档
   模式的解耦启发）：workspace exec 首版建议任务级授权或全问，真机再定。

## 6. 风险点清单（首批接入计划）

| 风险点 | kind | detail 内容 | 档位建议 |
| --- | --- | --- | --- |
| workspace exec（docker 命令执行） | workspace-exec | 命令全文 | 任务级授权一次 / 每条全问（真机定） |
| UI 文件删除（workspace-ui DELETE） | file-delete | 路径 + 递归提示 | 每次全问（低频高破坏） |
| UI 覆盖保存的"强制覆盖"分支 | file-overwrite | 路径 | 二期（UI 自有确认框，暂不重复） |
| 深检扫码登录等新场景 | qr-login 等 | 场景描述 | 出现时接入 |

注：Agent 侧的 write_file/edit_file（工作台六件套）**不列首版**——配额与
路径校验已兜底，且无可执行性；全部要问会把任务问瘫。真机观察后按需加档。

## 7. 预计改动清单（文件级）

| 文件 | 动作 | 规模 |
| --- | --- | --- |
| `src/services/buttons/approval.ts` | 新建：pending Map + requestApproval + handler + conclude + TTL/stop 联动 + 熔断 + **任务级授权缓存（§3.6：grantedFlows + 入口短路 + abort 清理 + 时效兜底 + allow-task 分支）** | ~190 行 |
| `src/config.ts` | approvalMode（APPROVAL_MODE，默认 off）+ approvalTtlMs | ~6 行 |
| `src/webhook.ts` | initializeApproval() 一行 | 1 行 |
| workspace exec 工具（`src/agent/code-workspace/registry.ts` 或 executor 层） | 风险点前置 ~5 行 | ~5 行 |
| `test/approval-check.mts` | 新建：本地验证（模拟点击/超时/竞态/熔断/**授权缓存短路·拉闸清空·时效过期**，参照 button-callback-check 手法） | ~150 行 |
| `docs/features/2026-08-31-命令速查表.md` | 不动（审批非用户命令，是被动交互） | - |

Agent loop、三个图、记忆、按钮管道、interrupt.ts 全部零改动。总增量 ~350 行。

## 8. 我认为缺少/需注意的部分（诚实清单）

1. **管理员枚举的平台边界**（§5.1 的展开）：QQ 不提供"群成员→role"的查询
   接口，点击事件也不带 authorRole——快照名单只含发起人（若其为管理员）。
   其余管理员点击会收到"仅群主/管理员可操作"的误拒提示。这是数据边界内
   的最优解，不是实现遗漏；真机观察误拒频率再决定是否补文案引导。
2. **询问消息的落库语义**：push 出去的询问消息会走 traceOut 记 chat_bot 行
   （合理——bot 确实说过这句话）；回执通知建议 `record:false`（瞬时状态，
   与 progress-bus 同语义）。需要在这两处显式选择，避免无意中污染 L1。
3. **多审批并发**：一个任务理论上可能同时挂多个风险点审批（并行工具调用）。
   机制上 Map 支持，但交互上用户会收到多条询问——首版建议 exec 类风险点
   串行化（子图内天然串行，主图 Promise.all 并行的场景首版没有），文档记录。
4. **拒绝后的模型行为不可控**：文本回流是"建议"不是"强制"——模型仍可能
   重试。熔断（§3.5）是硬防线，文本指示是软防线，两者都要。
5. **观察项**：拒绝/超时在真实使用里的频率、TTL 是否合适、任务级授权的
   疲劳度、管理员误拒频率（§5.1）——上线后按日志调（审批日志带 runId，
   与既有链路追踪对齐）。
6. **未覆盖的场景**：深检子图内的风险点（browse 的页面操作目前无破坏性，
   暂不需要）；MCP 工具的审批接入（kb 写操作）——将来同接口，本方案不展开。

## 9. 实施顺序

```
① approval.ts 核心（Map/requestApproval/conclude/handler）+ 本地验证脚本
    —— requestApproval 可先用测试按钮手动触发验证闭环
② 任务级授权（grantedFlows + 三按钮 + 清理联动）+ 验证脚本补授权用例
③ config 开关 + webhook 注册
④ workspace exec 风险点接入（APPROVAL_MODE=risky 真机试跑）
⑤ 权限模型落地（§5.1 快照验权）+ 通知文案打磨（含"本任务内不再询问"的授权告知）
⑥ 真机观察（频率/TTL/疲劳度/管理员误拒）→ 调档
```
