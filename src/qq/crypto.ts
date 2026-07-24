// crypto.ts —— QQ Webhook 回调验签的核心：Ed25519 签名。
// 对照官方 Go 示例实现，但密钥生成方式按 Node 的 API 调整（见下）。

import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { Buffer } from "node:buffer";

// Ed25519 的 seed（私钥种子）固定 32 字节。
const SEED_SIZE = 32;

// 把 AppSecret 变成 32 字节的 seed。
// 官方规则：secret 不足 32 字节就不断把自己翻倍（repeat），直到 ≥32，再截前 32 字节。
// 例：secret 长 10 → 20 → 40（≥32）→ 截成 32。
function deriveSeed(botSecret: string): Buffer {
  let seed = botSecret;
  while (seed.length < SEED_SIZE) {
    seed = seed.repeat(2);
  }
  // 按字节截取。ASCII 下字符数=字节数；万一 secret 含多字节字符，
  // 先转成 Buffer 再按字节截，才和 Go 的 []byte 行为一致。
  return Buffer.from(seed, "utf-8").subarray(0, SEED_SIZE);
}

// 关键差异点：Node 的 crypto 没有"用指定 32 字节 seed 直接生成 Ed25519 私钥"的高层 API
// （Go 的 ed25519.GenerateKey(reader) 能吃 seed，Node 的 generateKeyPair 不行）。
// 解决：Ed25519 私钥的 PKCS#8/DER 编码 = 固定 16 字节前缀 + 32 字节 seed。
// 我们手动拼这个 DER，再用 createPrivateKey 导入。这是 Node 里的标准做法。
const PKCS8_ED25519_PREFIX = Buffer.from(
  "302e020100300506032b657004220420",
  "hex",
);

function seedToPrivateKey(seed: Buffer) {
  const der = Buffer.concat([PKCS8_ED25519_PREFIX, seed]);
  return createPrivateKey({ key: der, format: "der", type: "pkcs8" });
}

// 对外主函数：给定 botSecret、event_ts、plain_token，算出 hex 签名。
// 待签名消息 = event_ts + plain_token（顺序不能反，对照 Go 示例先写 EventTs 后 PlainToken）。
export function signValidation(
  botSecret: string,
  eventTs: string,
  plainToken: string,
): string {
  const privateKey = seedToPrivateKey(deriveSeed(botSecret));
  const message = Buffer.from(eventTs + plainToken, "utf-8");
  // Ed25519 用 sign() 时算法参数传 null（它自带哈希，不需要外部指定）。
  const signature = sign(null, message, privateKey);
  return signature.toString("hex");
}

// 验证 QQ 推来的事件签名（op 0 事件推送）。
// 方向和 signValidation 相反：那边是"我们签"，这边是"QQ 签、我们验"。
// 但用的是同一对密钥——从同一个 seed 派生出的私钥再导出公钥，QQ 用私钥签，我们用公钥验。
//
// QQ 在请求头里带：
//   X-Signature-Ed25519    —— 签名（hex 字符串）
//   X-Signature-Timestamp  —— 时间戳
// 待验证消息 = timestamp + 原始 body（顺序不能反，且 body 必须是原始字节）。
//
// 返回 true = 确实来自 QQ；false = 签名不匹配（伪造/被篡改），应拒绝。
export function verifySignature(
  botSecret: string,
  timestamp: string,
  rawBody: string,
  signatureHex: string,
): boolean {
  // 从私钥导出公钥：createPublicKey 接受私钥对象，返回其对应的公钥。
  // 注：@types/node 这个版本的 createPublicKey / verify 重载漏了 KeyObject，
  // 但运行时完全支持（自测已验证）。两处各用一个局部 as 标注该声明缺陷，不影响运行时。
  const privateKey = seedToPrivateKey(deriveSeed(botSecret));
  const publicKey = createPublicKey(privateKey as unknown as Parameters<typeof createPublicKey>[0]);

  const message = Buffer.from(timestamp + rawBody, "utf-8");

  // 签名是 hex 字符串，转回 Buffer。若 hex 非法，Buffer.from 会得到截断/空结果，
  // verify 只会返回 false，不会抛错——所以外面无需额外 try/catch。
  const signature = Buffer.from(signatureHex, "hex");

  // Ed25519 验签：算法参数同样传 null。返回布尔值。
  const pubForVerify = publicKey as unknown as Parameters<typeof verify>[2];
  return verify(null, message, pubForVerify, signature);
}
