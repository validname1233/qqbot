// services/prompts/builder.ts —— 提示词组装层：把"人格模块"和"功能模块"拼接成完整系统提示词。
// 2026-10-29 提示词 v2 后职责收窄：主 Agent（agent 链路）不走这里——它的
// system 由 functional.ts 的 getAgentSystemPrompt 专用函数直拼；本文件只服务
// 场景表消费者（daily/reminder/deep_* 等）。人格缓存与存取已迁至 functional.ts。

import type { BotEvent } from "../../events/registry.js";
import { FUNCTIONAL_PROMPTS, getPersonality, type PromptScene } from "./functional.js";

// 纯功能场景：这些场景只返回功能规则，不拼接人格。
// deep_plan / deep_browse / deep_research（深检三环节）——输出只进思维链/
// tool_calls，不直接展示给用户，人设是噪声。
// 以后若新增"只做结构化判断"的场景，往这个集合里加一项即可。
const PURE_FUNCTIONAL_SCENES: ReadonlySet<PromptScene> = new Set<PromptScene>([
  "deep_plan",
  "deep_browse",
  "deep_research",
]);

// 获取完整系统提示词：人格（自定义或默认，取用见 functional.getPersonality）
// + 功能规则（按场景）。纯功能场景例外：只返回功能规则，不拼人格。
export function getSystemPrompt(event: BotEvent, scene: PromptScene = "daily"): string {
  const functional = FUNCTIONAL_PROMPTS[scene];

  if (PURE_FUNCTIONAL_SCENES.has(scene)) {
    return functional;
  }

  const personality = getPersonality(event);

  // 功能规则为空时只返回人格；否则拼接 "人格\n\n功能"
  //（daily 现在也带输出格式限制，暂时没有功能规则为空的场景，分支留作通用逻辑）
  return functional ? `${personality}\n\n${functional}` : personality;
}
