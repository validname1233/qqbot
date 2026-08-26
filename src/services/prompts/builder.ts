// services/prompts/builder.ts —— 提示词组装层：运行时把"人格模块"和"功能模块"拼接成完整系统提示词。
// 和长期记忆注入的模式一致——按需组装，人格可自定义、功能不可自定义。

import type { BotEvent } from "../../events/registry.js";
import { memoryKey } from "../../agent/context.js";
import { DEFAULT_PERSONALITY, FUNCTIONAL_PROMPTS, type PromptScene } from "./functional.js";

// 模块内缓存：启动时从数据库加载所有自定义人格，运行时直接从这里读（不再每次查库）
const personalityCache = new Map<string, string>();

// 纯功能场景：这些场景只返回功能规则，不拼接人格。
// agent_judge（工具判断）是典型——这次调用只关心 tool_calls 的准确输出，
// 它的文字内容不会被用户看到（plainReply/finalize 会换人设重新生成），
// 人设文本对判断是纯噪声，还会让"按群自定义人格"间接改变工具判断行为。
// deep_browse（深检浏览决策）同理——它输出的材料小结只留在浏览记录里供
// synthesize 参考，不直接展示给用户。
// deep_plan（深检计划制定）同理——计划只进思维链，人设是噪声。
// 以后若新增类似"只做结构化判断"的场景，往这个集合里加一项即可。
const PURE_FUNCTIONAL_SCENES: ReadonlySet<PromptScene> = new Set<PromptScene>([
  "agent_judge",
  "deep_plan",
  "deep_browse",
]);

// 获取完整系统提示词：人格（自定义或默认）+ 功能规则（按场景）。
// 纯功能场景例外：只返回功能规则，不拼人格。
export function getSystemPrompt(event: BotEvent, scene: PromptScene = "daily"): string {
  const functional = FUNCTIONAL_PROMPTS[scene];

  if (PURE_FUNCTIONAL_SCENES.has(scene)) {
    return functional;
  }

  const key = memoryKey(event);
  const personality = personalityCache.get(key) ?? DEFAULT_PERSONALITY;

  // 功能规则为空时只返回人格；否则拼接 "人格\n\n功能"
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
