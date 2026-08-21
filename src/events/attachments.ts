// events/attachments.ts —— 消息附件（MessageAttachment）的解析知识，三个消息事件共用。
// 官方文档（群消息/群@消息/单聊事件）里 MessageAttachment 的结构完全一致：
//   url            附件下载 URL（带 rkey 签名，有时效）
//   filename       文件名
//   width/height   图片宽高像素（仅图片附件有）
//   size           文件字节数
//   content_type   附件类型。注意不是纯 MIME：语音是字面量 "voice"、群文件是字面量
//                  "file"，其余才是标准 MIME（image/jpeg、video/mp4 等）
//   voice_wav_url  语音 SILK 转换后的 WAV URL（仅语音）
//   asr_refer_text 语音的官方 ASR 转写结果（仅语音——白送的转写，做语音理解时能直接用）
// 这个文件存在的意义和事件定义一样：附件怎么解析只写这一份，
// 三个事件定义 import 同一个 parseAttachments，不各抄各的。

// ---------- 对外提供的「干净附件」 ----------
export interface MessageAttachment {
  url: string; // 附件下载 URL
  filename: string; // 文件名（QQ 可能给空串）
  contentType: string; // content_type 原样（"voice"/"file"/"image/jpeg"/...）
  width?: number; // 图片宽度像素，非图片附件无
  height?: number; // 图片高度像素，非图片附件无
  size?: number; // 文件大小字节
  voiceWavUrl?: string; // 语音转 WAV 的 URL，非语音附件无
  asrReferText?: string; // 语音的官方 ASR 转写结果，非语音附件无
}

// 图片附件判定：content_type 是 image/* 即视为图片（QQ 文档只列了 jpeg/png/gif，
// 用前缀匹配而不是白名单，将来出现 image/webp 之类也天然兼容）。
export function isImageAttachment(attachment: MessageAttachment): boolean {
  return attachment.contentType.startsWith("image/");
}

// ---------- 宽松解析 ----------
// 设计取向和事件守卫相反：核心字段（id/content/author）严格——错了说明事件结构
// 变了，宁可解析失败也不拿残缺数据往下走；附件字段宽松——纯文本消息根本不带
// attachments，不同类型附件字段差异也大，严了会把正常事件打成 null。
//
// 宽松的具体规则：
//   - attachments 缺失 / 不是数组 / 是 null → 当没有附件（返回 []）
//   - 数组里的元素不是对象、或 url / content_type 不是 string → 丢弃该元素
//     （一条消息里混多个附件时，一个坏的不能拖垮整条消息）
//   - 其余字段类型不对就当作没有，不报错
export function parseAttachments(d: unknown): MessageAttachment[] {
  if (typeof d !== "object" || d === null) return [];
  const rawList = (d as Record<string, unknown>).attachments;
  if (!Array.isArray(rawList)) return [];

  const result: MessageAttachment[] = [];
  for (const item of rawList) {
    if (typeof item !== "object" || item === null) continue;
    const obj = item as Record<string, unknown>;
    if (typeof obj.url !== "string" || typeof obj.content_type !== "string") continue;

    const attachment: MessageAttachment = {
      url: obj.url,
      filename: typeof obj.filename === "string" ? obj.filename : "",
      contentType: obj.content_type,
    };
    // 数值字段：官方给的是 integer，但容错成「是 number 才收」。
    if (typeof obj.width === "number") attachment.width = obj.width;
    if (typeof obj.height === "number") attachment.height = obj.height;
    if (typeof obj.size === "number") attachment.size = obj.size;
    if (typeof obj.voice_wav_url === "string") attachment.voiceWavUrl = obj.voice_wav_url;
    if (typeof obj.asr_refer_text === "string") attachment.asrReferText = obj.asr_refer_text;
    result.push(attachment);
  }
  return result;
}
