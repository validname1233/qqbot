// index.ts —— 程序入口。当前目标：验证认证链路能通。
// 里程碑：换到 token → 脱敏打印 → 用 token 调只读接口 /gateway 拿网关地址。
// 这条链路一通，后面"连 WebSocket 收事件、发消息"都是在它上面加东西。

import { getAccessToken } from "./qq/auth.js";
import { apiRequest } from "./qq/api.js";
import { logger } from "./services/logger.js";

// /gateway 接口返回的形状：一个 WebSocket 网关地址。
interface GatewayResponse {
  url: string;
}

// 把 token 脱敏，只显示头尾几位，避免整串打进终端/日志泄露。
function maskToken(token: string): string {
  if (token.length <= 8) return "****";
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

// 顶层 await：ES 模块里可以直接在文件顶层用 await，不必包一层 main()。
logger.info("boot", "正在换取 Access Token...");
const token = await getAccessToken();
logger.info("boot", `拿到 token：${maskToken(token)}`);

logger.info("boot", "正在获取 WebSocket 网关地址...");
const gateway = await apiRequest<GatewayResponse>("/gateway");
logger.info("boot", `网关地址：${gateway.url}`);

logger.info("boot", "认证链路验证成功 ✅");
