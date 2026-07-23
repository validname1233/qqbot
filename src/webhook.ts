// webhook.ts —— HTTP server，接收 QQ 推来的回调请求。
// 用 Node 内置 node:http，不装 express。
// nginx 在前面卸载 HTTPS，把明文 HTTP 转发到本地端口，这里只处理业务。

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { config } from "./config.js";
import { signValidation, verifySignature } from "./crypto.js";

// 本地监听端口。只绑 127.0.0.1，不对公网暴露——外面只能经 nginx 进来。
const PORT = 3000;
const HOST = "127.0.0.1";

// QQ 回调的 op 码。op=13 是"回调地址验证"请求。
const OP_VALIDATION = 13;
// op=0 是业务事件推送（收到消息等），后面再细分。
const OP_DISPATCH = 0;

// 收集请求的原始 body。验签必须用未经改动的原始字节，所以手动攒 chunk，
// 不能用任何会重新序列化 body 的解析库。
function readRawBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

// 回调请求 body 的结构。op 决定 d 里是什么。
interface CallbackPayload {
  op: number;
  d?: unknown;
}

// op 13 验证请求里 d 的结构。
interface ValidationData {
  plain_token: string;
  event_ts: string;
}

function isValidationData(d: unknown): d is ValidationData {
  return (
    typeof d === "object" &&
    d !== null &&
    "plain_token" in d &&
    "event_ts" in d &&
    typeof (d as Record<string, unknown>).plain_token === "string" &&
    typeof (d as Record<string, unknown>).event_ts === "string"
  );
}

// 小工具：回一个 JSON 响应。
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(json);
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // QQ 的回调都是 POST。其它方法直接拒。
  if (req.method !== "POST") {
    sendJson(res, 405, { message: "Method Not Allowed" });
    return;
  }

  const raw = await readRawBody(req);

  let payload: CallbackPayload;
  try {
    payload = JSON.parse(raw) as CallbackPayload;
  } catch {
    sendJson(res, 400, { message: "Invalid JSON" });
    return;
  }

  // ---------- op 13：回调地址验证 ----------
  if (payload.op === OP_VALIDATION) {
    if (!isValidationData(payload.d)) {
      sendJson(res, 400, { message: "Invalid validation payload" });
      return;
    }
    const { plain_token, event_ts } = payload.d;
    // 用 AppSecret 对 event_ts + plain_token 签名，原样回 plain_token + signature。
    const signature = signValidation(config.appSecret, event_ts, plain_token);
    sendJson(res, 200, { plain_token, signature });
    console.log("[webhook] 回调验证请求已响应");
    return;
  }

  // ---------- op 0：业务事件推送 ----------
  if (payload.op === OP_DISPATCH) {
    // 门卫：先验签，证明这条确实来自 QQ。
    // 公网地址谁都能发 POST，不验签 = 机器人对全网开放。验不过直接拒，不进业务逻辑。
    // QQ 把签名放在请求头（注意 Node 里 header 名全小写），待验证内容 = timestamp + 原始body。
    // raw 必须是原始字节（readRawBody 拿到的那个），不能用解析再序列化的结果，否则字节不一致。
    const timestamp = req.headers["x-signature-timestamp"];
    const signature = req.headers["x-signature-ed25519"];
    if (
      typeof timestamp !== "string" ||
      typeof signature !== "string" ||
      !verifySignature(config.appSecret, timestamp, raw, signature)
    ) {
      sendJson(res, 401, { message: "签名校验失败" });
      console.warn("[webhook] 事件签名校验失败，已拒绝");
      return;
    }

    // 验签通过，才是真 QQ。先快速回 200 ACK 避免重推，事件分发逻辑后面再加。
    sendJson(res, 200, { op: 12 }); // op 12 = HTTP 回调 ACK
    console.log("[webhook] 收到已验签事件:", raw);
    return;
  }

  // 其它 op 暂时只回 200。
  sendJson(res, 200, {});
}

const server = createServer((req, res) => {
  // handleRequest 是 async，出错要兜住，否则会崩掉整个进程。
  handleRequest(req, res).catch((err: unknown) => {
    console.error("[webhook] 处理请求出错:", err);
    if (!res.headersSent) {
      sendJson(res, 500, { message: "Internal Error" });
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[webhook] 监听 http://${HOST}:${PORT}（经 nginx 反代对外提供 HTTPS）`);
});
