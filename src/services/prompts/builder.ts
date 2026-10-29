// services/prompts/builder.ts —— 提示词组装层：运行时把"人格模块"和"功能模块"拼接成完整系统提示词。
// 和长期记忆注入的模式一致——按需组装，人格可自定义、功能不可自定义。

import type { BotEvent } from "../../events/registry.js";
import { tenantKey } from "../../session/key.js";
import { DEFAULT_PERSONALITY, FUNCTIONAL_PROMPTS, AGENT_UNIFIED_HEAD, AGENT_UNIFIED_TAIL, type PromptScene } from "./functional.js";

// 模块内缓存：启动时从数据库加载所有自定义人格，运行时直接从这里读（不再每次查库）
const personalityCache = new Map<string, string>();

// 纯功能场景：这些场景只返回功能规则，不拼接人格。
// deep_plan / deep_browse / deep_research（深检三环节）——输出只进思维链/
// tool_calls，不直接展示给用户，人设是噪声。
// agent_unified（v9 直通架构）【不在此名单】——它要直接产出给用户看的
// 最终回复，人格必须在场（旧 agent_judge 在名单里是三场景分工的产物，
// 随 plainReply 一起退役）。
// 以后若新增"只做结构化判断"的场景，往这个集合里加一项即可。
const PURE_FUNCTIONAL_SCENES: ReadonlySet<PromptScene> = new Set<PromptScene>([
  "deep_plan",
  "deep_browse",
  "deep_research",
]);

// 获取完整系统提示词：人格（自定义或默认）+ 功能规则（按场景）。
// 纯功能场景例外：只返回功能规则，不拼人格。
export function getSystemPrompt(event: BotEvent, scene: PromptScene = "daily"): string {
  const functional = FUNCTIONAL_PROMPTS[scene];

  if (PURE_FUNCTIONAL_SCENES.has(scene)) {
    return functional;
  }

  const key = tenantKey(event);
  const personality = personalityCache.get(key) ?? DEFAULT_PERSONALITY;

  // agent_unified（提示词 v2 模块化，2026-10-29 方案）：人格中段注入——
  // [M1 核心身份与输入格式 + M2 工具判断] + 人格 + [M3 输出格式]。
  // M1+M2 在人格之前，成为全部租户请求的公共前缀字节（跨租户缓存共享）；
  // FUNCTIONAL_PROMPTS.agent_unified 只是 HEAD，不能单独当完整 system 用。
  if (scene === "agent_unified") {
    return `${AGENT_UNIFIED_HEAD}\n\n${personality}\n\n${AGENT_UNIFIED_TAIL}`;
  }

  // 其余带人格场景：功能规则为空时只返回人格；否则拼接 "人格\n\n功能"
  //（daily 现在也带输出格式限制，暂时没有功能规则为空的场景，分支留作通用逻辑）
  return functional ? `${personality}\n\n${functional}` : personality;
}

// 缓存写入：store.ts 在更新数据库后调用此函数同步刷新缓存
export function setPersonalityCache(key: string, personality: string): void {
  personalityCache.set(key, personality);
}

// 缓存清除：暂时用不上，预留接口（如果以后要支持"恢复默认人格"可以调这个）
export function clearPersonalityCache(key: string): void {
  personalityCache.delete(key);
}

// 启动时批量加载：store.ts 的 initializePersonalities() 会遍历数据库全部记录，
// 逐条调 setPersonalityCache 把自定义人格加载进内存
export function getAllCachedKeys(): string[] {
  return Array.from(personalityCache.keys());
}
