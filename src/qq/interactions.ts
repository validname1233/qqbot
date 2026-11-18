// qq/interactions.ts —— 回调按钮的平台回应接口（方案 2026-11-10 §3.1）。
// 契约（keyboard 详解文档 §4.2）：收到 INTERACTION_CREATE 后必须 3 秒内调
// PUT /interactions/{id} 回应，否则客户端按钮一直 loading；同一 id 只能回一次。

import { apiRequest } from "./api.js";

// 回应码语义（详解文档）：0 成功 / 1 失败 / 2 频繁 / 3 重复 / 4 无权限 / 5 仅管理员。
export type InteractionCode = 0 | 1 | 2 | 3 | 4 | 5;

// 回应一次交互。fire-and-forget 语义的落点：调用方不 await（3 秒窗口是硬
// 约束，回应排在业务前面发出去）。同 id 二次回应会被平台拒——QQ 重推场景
// 调用方已用内存 Map 去重，这里的失败兜底只记 warn 静默（不影响业务）。
export async function respondInteraction(
  interactionId: string,
  code: InteractionCode,
): Promise<void> {
  try {
    await apiRequest(`/interactions/${interactionId}`, {
      method: "PUT",
      body: JSON.stringify({ code }),
    });
  } catch (err) {
    // 回应失败不影响业务（按钮状态异常可容忍，业务丢事件不可容忍）。
    // 只在非 400 类错误时记日志——"重复回应"是去重兜底的预期路径。
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[interactions] 回应 ${interactionId.slice(0, 8)}… 失败：${msg}`);
  }
}
