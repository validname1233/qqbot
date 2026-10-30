// services/model.ts —— 调用大模型的统一入口。原来 agent/client.ts（要 tools/tool_calls）
// 和 services/ai.ts（单轮问答、走默认人设）功能重叠——都是拼 messages 发到同一家
// 接口——合并成一份，其余代码统一改用这里的 callModel。

import { config } from "../config.js";
import type { ChatMessage, ToolSchema } from "../agent/types.js";
import { logger } from "./logger.js";

// DeepSeek 官方 OpenAI 兼容接口。注意路径不带 /v1（那是给 OpenAI SDK 用的兼容别名）。
const API_URL = "https://api.deepseek.com/chat/completions";

interface ChatCompletionResponse {
  choices?: Array<{ message?: ChatMessage }>;
  // DeepSeek 特有字段：缓存命中/未命中的输入 token 数（hit+miss=prompt_tokens）。
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
  };
}

// 默认系统提示词已迁移到 services/prompts/functional.ts 的 DEFAULT_PERSONALITY，
// 这里保留导出只是为了向后兼容，实际调用应该走 getSystemPrompt(event, scene)。
export { DEFAULT_PERSONALITY as DEFAULT_SYSTEM_PROMPT } from "./prompts/functional.js";

// content 常常很长（人设回复、finalize 阶段拼的大段提示词回复），日志里全打出来会刷屏，
// 只截前 150 字，够看出这次回复大致是什么内容即可。
function truncateContent(content: string | null): string {
  if (content === null) {
    return "null";
  }
  return content.length > 150 ? `${content.slice(0, 150)}...` : content;
}

// tools 传 undefined（或省略）时，请求体里就不带 tools 字段——
// 这是 agent/loop.ts 实现"第二轮强制不再调用工具"的手段：不传 tools，模型就没有工具可选，
// 只能老实吐文本，天然达成"循环一次就出最终成果"，不需要 while 循环或轮次上限。
// model 选填：不传就用普通对话模型（config.aiModel）；传了就换成指定模型——
// 目前只在 agent/loop.ts 的 synthesizeFinalReply 收尾时传 config.agentModel，换一个更强的模型。
// enableThinking 选填：默认 false（工具调用判断/单轮问答不需要，思考只会拖慢速度）；
// synthesizeFinalReply 收尾时传 true，让模型多想一步再给最终回复。
// label：调用方传入的标识（通常是发起调用的节点名，如 "llmCall"/"plainReply"），
// 纯粹用来在日志里区分"这次调用是谁发起的"，不影响请求内容，不传就打印 "unknown"。
// signal（选填）：AbortSignal，/stop 中断链路用——拉闸时正在等的 fetch 立刻抛
// AbortError。AbortError 不是接口故障，调用方 catch 到后应静默收尾而不是当错误处理。
export async function callModel(
  messages: ChatMessage[],
  tools?: ToolSchema[],
  model: string = config.aiModel,
  enableThinking: boolean = false,
  label = "unknown",
  signal?: AbortSignal,
): Promise<ChatMessage> {
  const t0 = Date.now();
  // 找最后一条 role:"user" 的消息（即这一轮真正的用户输入），日志里打出来方便排查
  // "这次调用到底是在回应哪句话"——system/history 太长，只看这一条最有用。
  const lastUserMessage = [...messages].reverse().find((m) => m.role === "user");
  // 阶段二分流：请求/返回的控制台行改为轨迹化 node（一行结论：谁发起、参数规模、
  // 耗时），带 content 预览的旧明细沉到 detail（文件可见，控制台清爽——
  // 2026-09-20-日志体系重构方案.md §2.2）。
  logger.node(
    "model",
    `[${label}] 调用 model=${model} tools=${tools?.length ?? 0} messages=${messages.length}`,
  );
  // 全量请求输入（2026-10-30 决议）：直连控制台打印，不进文件日志——多轮 Agent
  // 的输入高度重复（system+历史每轮都发），持久化太冗余；控制台看现场用。
  console.log(
    `[${consoleStamp()}] [model] [${label}] 请求输入全量（${messages.length} 条）：\n${renderMessagesPlain(messages)}`,
  );

  const response = await fetch(API_URL, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.aiApiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
      // DeepSeek 的思考模式开关：必须显式传 disabled——它的默认值是 enabled，
      // 不传的话工具判断/日常回复这类调用会静默带上思维链，多耗 token 且变慢。
      thinking: { type: enableThinking ? "enabled" : "disabled" },
    }),
  });

  const elapsed = Date.now() - t0;

  if (!response.ok) {
    const detail = await response.text();
    // 失败路径升 warn（阶段二分流遗漏的修正）：故障必须上控制台，debug 下静默
    // 会让"模型调用失败"这一最重要的降级信号反而看不见。全文仍在 detail。
    logger.warn("model", `[${label}] 大模型调用失败 (+${elapsed}ms) status=${response.status} detail=${detail.slice(0, 150)}`);
    logger.detail("model", `[${label}] 调用失败响应体全文：${detail}`);
    throw new Error(`AI 接口返回 ${response.status}: ${detail}`);
  }

  const data = (await response.json()) as ChatCompletionResponse;
  const message = data.choices?.[0]?.message;
  if (message === undefined) {
    logger.warn("model", `[${label}] 大模型调用失败 (+${elapsed}ms) 返回里没有 message 字段`);
    throw new Error("AI 接口返回里没有 message 字段");
  }

  // usage（2026-10-30 决议）：DeepSeek 返回的 token 用量四元组，trace 级落
  // 日志（控制台+文件）——缓存命中率观测与二期估算校准的数据源。
  const usage = data.usage;
  if (usage !== undefined) {
    const hit = usage.prompt_cache_hit_tokens ?? 0;
    const miss = usage.prompt_cache_miss_tokens ?? 0;
    logger.node(
      "model",
      `[${label}] usage: prompt=${usage.prompt_tokens ?? hit + miss} (hit=${hit} miss=${miss}) completion=${usage.completion_tokens ?? 0}`,
    );
  }

  // 轨迹行（控制台）：谁发起、耗时、产出了什么（工具名或字数）——不带正文。
  const outcome =
    message.tool_calls !== undefined && message.tool_calls.length > 0
      ? `tool_calls: ${message.tool_calls.map((c) => c.function.name).join("、")}`
      : `content ${(message.content ?? "").length} 字`;
  logger.node("model", `[${label}] 返回 (+${elapsed}ms) → ${outcome}`);

  // 返回全文（2026-10-30 决议）：文件日志保留的唯二模型内容之一——解析出
  // 什么打什么（content 全文 + tool_calls 完整 JSON，含 id），不截断不去重。
  const detailParts = [`[${label}] 返回输出 (+${elapsed}ms) content 全文：`];
  detailParts.push(message.content ?? "（null）");
  if (message.tool_calls !== undefined) {
    detailParts.push(`tool_calls 全文：${JSON.stringify(message.tool_calls)}`);
  }
  logger.detail("model", detailParts.join("\n"));

  return message;
}

// ---------- 消息渲染（2026-10-30 决议：指纹去重置空） ----------
// 旧机制（方案 §2.3 的 sha 指纹去重）已停用：全量输入改控制台直打（不落盘，
// 去重失去意义），文件日志只保留模型返回全文。renderMessagesWithFingerprint
// 保留导出与签名（历史测试兼容），行为改为原样全量输出（无去重、无指纹表）。
// 跨天滚动回调随之空置，注销注册。
export function renderMessagesWithFingerprint(messages: ChatMessage[]): string {
  return renderMessagesPlain(messages);
}

// 全量渲染：逐条 [msg#i role] + content + 协议字段（tool_calls/tool_call_id）。
// 控制台直打用（2026-09-20 方案 §2.3 的去重版被 2026-10-30 决议取代）。
export function renderMessagesPlain(messages: ChatMessage[]): string {
  return messages
    .map((msg, i) => {
      const content = msg.content ?? "（null）";
      const extra =
        msg.tool_calls !== undefined ? ` tool_calls=${JSON.stringify(msg.tool_calls)}` : "";
      const extraTail = msg.tool_call_id !== undefined ? ` tool_call_id=${msg.tool_call_id}` : "";
      return `[msg#${i} ${msg.role}]\n${content}${extra}${extraTail}`;
    })
    .join("\n");
}

// 控制台时间戳（与 logger 控制台格式对齐的本地实现——不走 logger 是因为
// 全量输入是"仅控制台"内容，logger 没有这个通道，走 detail 会落盘）。
function consoleStamp(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// AbortError 识别：/stop 拉闸时 fetch 抛的就是它。调用方的 catch 用这个判断
// "用户主动停"（静默收尾、不打 error 日志）还是"真故障"（正常错误路径）。
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
