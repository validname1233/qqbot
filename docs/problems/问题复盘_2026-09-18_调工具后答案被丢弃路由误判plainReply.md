# 问题复盘：调完 recall_memory 后正确答案被丢弃、重答跑题（路由误判 plainReply）

> 日期：2026-09-18
> 涉及文件：`src/agent/loop.ts`（afterLlmCall 路由 / plainReply）
> 状态：已修复（方向 A：历史性判据），已本地验证路由五场景

## 1. 现象（实机日志还原）

用户在群里问："我头呢之前纠结的找不到教程的数据库叫什么来着"。

日志时间线：

```
[llmCall]    返回 tool_calls=recall_memory({"keywords":["数据库","教程",...]})   ← 正确决策
[llmCall]    返回 content="LanceDB。B站上确实没什么教程，你当时吐槽…"
             tool_calls=无                                                      ← 正确答案已生成！
[plainReply] 请求大模型调用 … content="可以拦，但要先搞清楚漏的是什么…"            ← 答案丢失，重答跑题
```

第二轮流次里模型已经基于 recall_memory 返回的旧对话切片组织出了正确答案（LanceDB + 当时的上下文细节），但用户最终收到的是一段关于"拦截 DSML 工具调用标记泄漏"的无关内容——那是 history 里另一个话题（近期 bot 开发讨论）。

## 2. 根因：路由判据无法区分"从未调工具"与"调完工具后主动停"

### 2.1 路由层的误判

`afterLlmCall`（修复前）：

```typescript
if (state.turnCount >= MAX_TOOL_TURNS) return "finalize";
return 无 tool_calls ? "plainReply" : "tools";
```

"无 tool_calls"是一个**瞬时判据**——只说明模型**此刻**不要工具，区分不了两种语义完全不同的路径：

| 路径 | 本轮输出 | messages 里有 tool 消息吗 | 应该去哪 | 修复前去了哪 |
|---|---|---|---|---|
| 第一步就没调工具（纯闲聊） | 纯文本 | 无 | plainReply | plainReply ✓ |
| 调完工具、看完结果、主动给出答案 | 纯文本 | **有** | **finalize** | plainReply ✗ |

### 2.2 plainReply 丢答案的两步

被误路由进 plainReply 后，两处设计叠加把答案毁掉：

1. **`slice(1, -1)` 切掉成品答案**：plainReply 第一行去掉 messages 的最后一条（agent_judge 的判断碎念）。这个切片在纯闲聊场景是无害的（最后一条确实只是碎念），但本案例里最后一条 assistant 的 content 是**基于工具结果组织好的完整答案**——被当碎念切掉。
2. **无引导重答被 history 带偏**：plainReply 换 daily 人设重答时，输入里没有"基于工具结果回答"的引导语，而上下文噪声很大（history 里有 DSML 截图的图片描述、近期开发讨论；长期记忆召回的五条全是"修改bot工具调用""提高短期记忆力"等开发条目）。flash 模型没有指路的情况下，把"之前纠结的数据库"和近期最热话题搅在一起，产出了回答另一个问题的文本。工具结果（LanceDB 切片）其实还在输入里——模型是"看着答案却没认出这是答案"。

### 2.3 为什么这个坑现在才暴露

plainReply 和这条路由诞生于 **MAX_TOOL_TURNS = 1** 时代：单轮预算下"调完工具后主动停"的路径不存在（第一轮 tool_calls 后无论模型想不想继续，turnCount 都已到上限强制 finalize）。把 MAX_TOOL_TURNS 升到 2（为 get_time → search 串行链）之后，"第二轮纯文本停止"第一次成为可达路径，潜伏的歧义立即兑现。

深检图（deep-search.ts）没有这个问题——它的退出路径本来就是 synthesize（浏览记录 + 思维链显式拼进收尾提示词）。当初深检设计时天然避开了这个坑，日常图是"单轮工具时代"的路由语义没有跟着升级。

## 3. 修复：方向 A——plainReply 的唯一合法入口 = "从未调过工具"

（用户拍板的设计原则："只有一种情况路由到 plainReply，就是模型第一步判断就不需要调用工具；其余情况（只要调用了工具）都走 finalize。"）

判据从"瞬时"换成"**历史性**"：

```typescript
function afterLlmCall(state): "plainReply" | "tools" | "finalize" {
  const hasToolCalls = /* 最后一条 assistant 是否带 tool_calls */;
  if (hasToolCalls && state.turnCount < MAX_TOOL_TURNS) return "tools";
  const usedTools = state.messages.some((msg) => msg.role === "tool");
  return usedTools ? "finalize" : "plainReply";
}
```

效果：

- **事故路径**（调完工具主动停）→ finalize：synthesizeFinalReply 显式拼接"以下是为完成这个需求而调用工具得到的结果……"的引导语 + **pro 模型 + thinking**——比 flash 裸读上下文可靠得多，答案保住，顺带升级了"调工具后的回答质量"；
- 纯闲聊路径完全不变；
- 轮次耗尽路径完全不变（现在与"主动停"合流进 finalize，本来就是同一个收尾节点）。

附带处理：plainReply 的 `slice(1, -1)` 保留（新路由下恒切到 user 为止，是防御性 no-op），注释更新说明其防御语义。

## 4. 验证

- 路由为纯函数、行为可枚举，五个场景断言全过：纯闲聊→plainReply；调完工具主动停（本事故案例）→finalize；要工具→tools；轮次耗尽→finalize；无工具历史+预算耗尽（防御）→plainReply；
- typecheck 通过；
- 实机复验方式：问同款问题（"之前纠结的找不到教程的数据库叫什么来着"），预期 debug 日志中 llmCall#2 返回 LanceDB 后出现的是 `[finalizeNode]` 而非 `[plainReply]`，最终回复即 LanceDB 答案。

## 5. 经验教训

1. **"停止信号"有歧义时要看历史，不要看瞬时**。"模型没再要工具"既可能是"从没需要过"也可能是"拿完了主动停"——两者需要的后处理完全不同。凡是把"输出形态"当"路径判据"的路由，都要检查是否存在同类歧义。
2. **升级预算参数（MAX_TOOL_TURNS 1→2）等于解锁新路径，新路径要过一遍所有相关路由**。图结构没变 ≠ 行为空间没变——条件边的输入分布变了，原来不可达的分支会变成常态。
3. **被切掉/忽略的最后一条 assistant 消息，在多轮工具语境下可能承载的是成品输出**。slice 类裁剪的注释要写清楚它对"最后一条"的语义假设。
4. **诊断时的反证思维**：本次定位的关键一步是对照"普通 /Agent 一切正常、只有这条路径出错"，快速排除全局性原因（鉴权/接口/模型），把范围压缩到路径差异上。（同日另一事故——scheduler 的 11300——也是靠"别的功能都正常"这一反证推翻了第一版错误假设。）
