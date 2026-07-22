// auth.ts —— 负责换取并缓存 Access Token。
// QQ 的接口需要一个有时效的 token（约 2 小时）。我们缓存它，
// 快过期时才重新换，避免每个请求都跑一趟认证。

import { config } from "./config.js";

// 换 token 的接口地址（注意和调业务接口的 api.sgroup.qq.com 不是同一个域名）。
const TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";

// 描述接口返回的形状。fetch 拿到的 JSON 是 unknown/any，
// 我们用这个 interface 明确"我期望的字段"，配合下面的校验函数收窄类型。
interface TokenResponse {
  access_token: string;
  // 官方返回的是字符串形式的秒数，稳妥起见按 string 接，用时再转 number。
  expires_in: string;
}

// 模块级缓存：当前 token 和它的过期时间戳（毫秒）。
// 用闭包变量而非导出，外部只能通过 getAccessToken() 拿，改不到缓存本身。
let cachedToken: string | undefined;
let expiresAtMs = 0;

// 运行时校验：确认返回的 JSON 真的长成 TokenResponse 的样子。
// 网络来的数据不可信，不能只靠 as 断言——那只骗编译器，运行时不检查。
function isTokenResponse(data: unknown): data is TokenResponse {
  return (
    typeof data === "object" &&
    data !== null &&
    "access_token" in data &&
    typeof (data as Record<string, unknown>).access_token === "string" &&
    "expires_in" in data
  );
}

// 对外的唯一入口：返回一个当前有效的 access token。
// 有缓存且没快过期就直接用；否则重新换一个。
export async function getAccessToken(): Promise<string> {
  // Date.now() 返回当前毫秒时间戳。留 60 秒安全余量，避免"刚好卡在过期点"。
  const now = Date.now();
  if (cachedToken !== undefined && now < expiresAtMs - 60_000) {
    return cachedToken;
  }

  // fetch 是 Node 18+ 内置的，不用装 axios 之类。它返回 Promise<Response>。
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // body 必须是字符串，所以把对象 JSON.stringify。
    body: JSON.stringify({
      appId: config.appId,
      clientSecret: config.appSecret,
    }),
  });

  // res.ok 表示状态码在 200-299。非 2xx 要主动抛错，否则下面解析会拿到垃圾。
  if (!res.ok) {
    throw new Error(`换取 token 失败：HTTP ${res.status} ${res.statusText}`);
  }

  const data: unknown = await res.json();
  if (!isTokenResponse(data)) {
    throw new Error(`token 接口返回了意外的结构：${JSON.stringify(data)}`);
  }

  cachedToken = data.access_token;
  // 把"有效秒数"换算成"过期的绝对时间戳"，方便下次直接比较。
  expiresAtMs = now + Number(data.expires_in) * 1000;
  return cachedToken;
}
