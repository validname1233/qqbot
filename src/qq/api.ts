// api.ts —— 调用 QQ 业务接口的统一封装。
// 所有请求都走这里：自动拿 token、拼鉴权头、拼 base 地址、统一错误处理。
// 这就是我们从 openclaw 学到的"统一入口"思路——横切逻辑只写一遍。

import { getAccessToken } from "./auth.js";

// 业务接口的基础地址（和换 token 的 bots.qq.com 不同）。
const API_BASE = "https://api.sgroup.qq.com";

// 一个通用的请求函数。
// path：接口路径，如 "/gateway"。
// init：可选的 fetch 配置（method、body 等），默认 GET。
// 返回解析后的 JSON，类型参数 T 让调用方声明期望的返回形状。
export async function apiRequest<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const token = await getAccessToken();

  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      // QQ v2 的鉴权头格式：注意是 "QQBot {token}"，不是常见的 "Bearer"。
      Authorization: `QQBot ${token}`,
      "Content-Type": "application/json",
      // 展开调用方自定义的头，允许覆盖上面的默认值。
      ...init.headers,
    },
  });

  if (!res.ok) {
    // 把响应体也读出来，QQ 出错时会在 body 里给 code/message，方便排查。
    const body = await res.text();
    throw new Error(`API ${path} 失败：HTTP ${res.status} —— ${body}`);
  }

  return (await res.json()) as T;
}
