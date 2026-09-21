// services/model.ts —— 调用大模型的统一入口。原来 agent/client.ts（要 tools/tool_calls）
// 和 services/ai.ts（单轮问答、走默认人设）功能重叠——都是拼 messages 发到同一家
// 接口——合并成一份，其余代码统一改用这里的 callModel。

import { config } from "../config.js";
import type { ChatMessage, ToolSchema } from "../agent/types.js";
import { logger, setDayRollCallback } from "./logger.js";

// DeepSeek 官方 OpenAI 兼容接口。注意路径不带 /v1（那是给 OpenAI SDK 用的兼容别名）。
const API_URL = "https://api.deepseek.com/chat/completions";

interface ChatCompletionResponse {
  choices?: Array<{ message?: ChatMessage }>;
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
  logger.detail(
    "model",
    `[${label}] 请求明细 model=${model} enableThinking=${enableThinking} userMessage=${truncateContent(lastUserMessage?.content ?? null)}`,
  );
  // detail 流水（只进文件日志）：完整输入 messages，提示词按内容指纹去重——
  // 人设/系统提示词/旧历史在当天文件里只出现一次全文，之后是单行引用
  //（方案 §2.3：全量落盘会使同一段提示词一天写几百遍，没法读也没法存）。
  logger.detail("model", `[${label}] 请求输入（${messages.length} 条，指纹去重）：\n${renderMessagesWithFingerprint(messages)}`);

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

  // 轨迹行（控制台）：谁发起、耗时、产出了什么（工具名或字数）——不带正文。
  const outcome =
    message.tool_calls !== undefined && message.tool_calls.length > 0
      ? `tool_calls: ${message.tool_calls.map((c) => c.function.name).join("、")}`
      : `content ${(message.content ?? "").length} 字`;
  logger.node("model", `[${label}] 返回 (+${elapsed}ms) → ${outcome}`);

  // tool_calls 只打印名字+参数（不打 id，排查时用不上，反而占地方）。
  const toolCallsSummary =
    message.tool_calls === undefined
      ? "无"
      : message.tool_calls.map((call) => `${call.function.name}(${call.function.arguments})`).join(", ");
  logger.detail(
    "model",
    `[${label}] 返回明细 (+${elapsed}ms) content=${truncateContent(message.content)} tool_calls=${toolCallsSummary}`,
  );
  // detail 流水：content 与 tool_calls 全文（不截断）——tool_calls 的 JSON 连 id
  // 一起存（回放/比对时 id 与参数同属协议内容，截断版才有"占地方"的取舍）。
  const detailParts = [`[${label}] 返回输出 (+${elapsed}ms) content 全文：`];
  detailParts.push(message.content ?? "（null）");
  if (message.tool_calls !== undefined) {
    detailParts.push(`tool_calls 全文：${JSON.stringify(message.tool_calls)}`);
  }
  logger.detail("model", detailParts.join("\n"));

  return message;
}

// ---------- 输入指纹去重（方案 §2.3） ----------
// 指纹表：进程内 Map（sha → true）。同指纹的 message 内容在文件日志里只写一次
// 全文，之后单行引用。跨天时由 logger 的按天滚动连带重置（见 resetDetailFingerprints）——
// 新文件从零积累，引用永远指向当天文件里存在的全文。
const seenFingerprints = new Set<string>();

// 跨天滚动时 logger 回调：清空指纹表，让新文件从零积累全文（引用永远指向
// 当天文件里存在的 sha）。注册制避免 logger↔model 循环 import。
setDayRollCallback(() => {
  seenFingerprints.clear();
});

// 重置指纹表（测试用）：logger 检测到跨天滚动时经 setDayRollCallback 间接调用。
export function resetDetailFingerprints(): void {
  seenFingerprints.clear();
}

// 简单 FNV-1a 32 位 hash：指纹用途是"同内容识别"而非密码学安全，冲突率
// 2^32 分之一在日志场景可忽略；比 crypto.sha1 快且零依赖。
function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

// 把一次请求的 messages 渲染成"全文 or 引用"的逐条清单。导出供测试验证
// 去重语义（生产调用点只有 callModel 一处）。
export function renderMessagesWithFingerprint(messages: ChatMessage[]): string {
  return messages
    .map((msg, i) => {
      const content = msg.content ?? "（null）";
      const extra =
        msg.tool_calls !== undefined ? ` tool_calls=${JSON.stringify(msg.tool_calls)}` : "";
      const extraTail = msg.tool_call_id !== undefined ? ` tool_call_id=${msg.tool_call_id}` : "";
      const fp = fingerprint(`${msg.role}:${content}`);
      if (seenFingerprints.has(fp)) {
        return `[msg#${i} ${msg.role} sha=${fp}]（同前，略）${extra}${extraTail}`;
      }
      seenFingerprints.add(fp);
      return `[msg#${i} ${msg.role} sha=${fp}]\n${content}${extra}${extraTail}`;
    })
    .join("\n");
}

// AbortError 识别：/stop 拉闸时 fetch 抛的就是它。调用方的 catch 用这个判断
// "用户主动停"（静默收尾、不打 error 日志）还是"真故障"（正常错误路径）。
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
