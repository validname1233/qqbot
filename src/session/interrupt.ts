// session/interrupt.ts —— 会话级流程中断的注册表（/stop 功能的核心）。
// 语义：拒绝并发——一个会话（sessionKey，人粒度）同时只允许一个可控长流程
// （Agent 任务 / 深度检索）在跑。新流程想进来时若已有条目，begin 返回 null，
// 由调用方拒绝并提示"先 /stop"。跨用户隔离天然成立：Map 按精确 key 查取，
// 群里 B 的 /stop 碰不到 A 的条目。
//
// endControlledFlow 带 controller 参数做身份校验：/stop 的 abortFlow 删掉条目后，
// 被中断流程的 finally 还会再调一次 end——没有校验的话，若将来改成"顶掉"语义，
// 旧流程的 finally 会误删新流程的条目。校验后第二次 end 是安全 no-op。

const running = new Map<string, AbortController>();

// 尝试登记一个流程。该会话已有在跑的 → 返回 null（调用方拒绝新任务）。
export function beginControlledFlow(key: string): AbortController | null {
  if (running.has(key)) return null;
  const controller = new AbortController();
  running.set(key, controller);
  return controller;
}

// 流程结束（完成/失败/被中断，任何路径）注销自己。身份校验防误删（见文件头）。
export function endControlledFlow(key: string, controller: AbortController): void {
  if (running.get(key) === controller) {
    running.delete(key);
  }
}

// /stop 的动作：有在跑的就拉闸并摘除，返回 true；没有返回 false（提示"没有在跑的"）。
// abort() 是异步生效的——正在 await 的 fetch 立刻抛 AbortError，流程沿 catch/finally
// 走自己的收尾（识别 AbortError 后静默，不发"任务失败"的误导消息）。
export function abortFlow(key: string): boolean {
  const controller = running.get(key);
  if (controller === undefined) return false;
  controller.abort();
  running.delete(key);
  return true;
}
