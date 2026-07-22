// crypto.ts —— QQ Webhook 回调验签的核心：Ed25519 签名。
// 对照官方 Go 示例实现，但密钥生成方式按 Node 的 API 调整（见下）。

import { createPrivateKey, sign } from "node:crypto";
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
