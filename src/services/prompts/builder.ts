// services/prompts/builder.ts —— 提示词组装层：运行时把"人格模块"和"功能模块"拼接成完整系统提示词。
// 和长期记忆注入的模式一致——按需组装，人格可自定义、功能不可自定义。

import type { BotEvent } from "../../events/registry.js";
import { memoryKey } from "../../agent/context.js";
import { DEFAULT_PERSONALITY, FUNCTIONAL_PROMPTS, type PromptScene } from "./functional.js";

// 模块内缓存：启动时从数据库加载所有自定义人格，运行时直接从这里读（不再每次查库）
const personalityCache = new Map<string, string>();

// 获取完整系统提示词：人格（自定义或默认）+ 功能规则（按场景）
export function getSystemPrompt(event: BotEvent, scene: PromptScene = "daily"): string {
  const key = memoryKey(event);
  const personality = personalityCache.get(key) ?? DEFAULT_PERSONALITY;
  const functional = FUNCTIONAL_PROMPTS[scene];

  // 功能规则为空（如 daily 场景）时只返回人格；否则拼接 "人格\n\n功能"
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
