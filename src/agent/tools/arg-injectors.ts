// agent/tools/arg-injectors.ts —— 工具参数注入表（租户身份透传的统一机制）。
// 背景（docs/problems/2026-09-18-租户参数透传问题复盘.md）：工具需要知道
// "替谁做事"（scope/隔离键），但身份不能信任模型传参——模型会瞎编、会猜。
// 机制：runTool 分发前查这张表，命中则改写 args（注入器的返回值无条件覆盖
// 模型传参）；同时可选地把身份字段从发给模型的 schema 里剔除（模型看不见
// 的字段就不会试着填——借鉴 armani_agent 的"保留字三点联动"：schema 隐藏、
// 分发前过滤、分发时注入）。
//
// 与工具实现解耦：注入器集中注册在本文件（key 用注册表里的工具名，MCP 工具
// 即 mcp_<server>_<tool> 包装名），不混进工具代码；原生与 MCP 工具经各自的
// runTool 分发，共用同一张表。三个切面（progressNote / 参数注入 / run）都在
// 注册表层，工具自身零感知。

import type { MessageContext } from "../../types.js";
import type { ToolSchema } from "../types.js";
import { tenantKey } from "../../session/key.js";

// 注入器注册项：
//   inject       —— 调用前改写参数。返回值整体作为最终 args（模型传参里
//                   的同名字段被无条件覆盖——身份不信任模型的底线）。
//   hideFromModel —— 声明这些字段名要从"发给模型的参数 schema"里剔除。
//                   对原生工具是双保险（schema 本可不声明）；对 MCP 工具是
//                   关键——server 端声明的 inputSchema 我们改不了，只能在这里
//                   渲染时剥掉。
export interface ArgInjectorEntry {
  inject: (args: Record<string, unknown>, ctx: MessageContext) => Record<string, unknown>;
  hideFromModel?: readonly string[];
}

const injectors = new Map<string, ArgInjectorEntry>();

export function registerArgInjector(toolName: string, entry: ArgInjectorEntry): void {
  injectors.set(toolName, entry);
}

// runTool 净化切面用：未注册的工具原样返回（opt-in，既有工具零影响）。
export function applyArgInjector(
  toolName: string,
  args: Record<string, unknown>,
  ctx: MessageContext,
): Record<string, unknown> {
  const entry = injectors.get(toolName);
  if (entry === undefined) return args;
  return entry.inject(args, ctx);
}

// schema 渲染层用：剔除 hideFromModel 声明的字段（properties 里删掉；
// required 里若也声明了同步去掉，否则 schema 自相矛盾）。未注册的工具
// 原样返回。参数 schema 的形状是 JSON Schema 子集，浅拷贝后动手，不改原对象
//（MCP 工具的 inputSchema 来自 server，保持原样有利于比对与调试）。
export function stripHiddenParams(toolName: string, parameters: ToolSchema["function"]["parameters"]): ToolSchema["function"]["parameters"] {
  const entry = injectors.get(toolName);
  if (entry?.hideFromModel === undefined || entry.hideFromModel.length === 0) {
    return parameters;
  }
  const hidden = new Set(entry.hideFromModel);
  const props = parameters.properties as Record<string, unknown> | undefined;
  if (props === undefined) return parameters;
  const newProps: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (!hidden.has(key)) newProps[key] = value;
  }
  const required = Array.isArray(parameters.required)
    ? parameters.required.filter((r) => !hidden.has(r))
    : parameters.required;
  return { ...parameters, properties: newProps, required };
}

// ---- 首批注册：kb_search 的租户隔离（自 bridge.ts 迁入） ----
// key 用 MCP 包装名 mcp_kb_kb_search（bridge 的 name 生成规则），与注册表
// 命名空间一致。scope 无条件覆盖：模型只保留 query/top_k 的发言权。
// scope 值 = kb: + tenantKey——远端 kb 服务器强制 kb: 前缀并有服务端格式校验
// （2026-10-15 实机确认，裸 tenantKey 被拒）。真相源仍是 tenantKey（键统一），
// kb: 只是跨服务边界的命名空间包装，与 knowledge-base.ts 的 kbScope 同款。
registerArgInjector("mcp_kb_kb_search", {
  inject: (args, ctx) => ({ ...args, scope: `kb:${tenantKey(ctx.event)}` }),
  hideFromModel: ["scope"],
});
