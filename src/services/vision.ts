// services/vision.ts —— 千问（Qwen）视觉模型图像理解：输入图片字节，输出中文文字描述。
// 定位与 embedding.ts 一致：纯函数服务，不认识 QQ 事件、不进 Agent 图、不发消息——
// 上层（agentService 等）负责下载图片、拼接描述、处理降级，本文件只做"图→文字"这一件事。
//
// 走 DashScope 的 OpenAI 兼容接口（阿里云国内端点，直连可用，无需代理），
// 与 model.ts 的 DeepSeek 调用同款手写 fetch：REST + JSON，不引 SDK。

import { config } from "../config.js";
import { logger } from "./logger.js";

// DashScope OpenAI 兼容模式的 chat completions 端点。和 model.ts 一样写死成常量：
// 境内直连可用，没有代理/私有化部署的配置需求。
const API_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";

// describeImage 的可调项。目前只有 maxDescriptionChars（描述长度上限，要拼进对话
// 上下文，太长会污染记忆窗口）；以后要调 temperature 之类就在这加。
export interface DescribeImageOptions {
  maxDescriptionChars?: number;
}

// chat completions 响应里我们关心的形状。网络来的 JSON 不可信，取值前逐层判空
//（模型偶发返回空 choices / 空 content）。
interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
  // OpenAI 风格错误体：{"error": {"message": ...}}
  error?: { message?: string };
  // DashScope 原生风格错误体（限流等场景偶发）：{"code": ..., "message": ...}
  code?: string;
  message?: string;
}

// 描述生成的 system 提示词：要求详尽转写（这正是"眼睛"的价值所在——下游
// DeepSeek 看不到原图，只能依赖这段文字），同时控制在可拼接的长度内。
const DESCRIBE_SYSTEM_PROMPT = `你是一个视觉理解模块，负责分析输入图片，并生成详细、准确的图片描述，供另一个大语言模型作为上下文使用。你的任务不是回答用户问题，而是提供高质量的视觉信息。

请分析以下内容：

1. 图片概览
- 描述图片类型、整体场景、主要内容和主题。

2. 人物与角色识别
- 识别图片中的人物、动漫角色、游戏角色、影视角色或其他知名形象。
- 如果能够确定，请提供名称、所属作品/领域以及识别依据。
- 对现实公众人物、动漫角色等可以进行身份识别。
- 如果无法确定，请描述外貌特征，并标注“无法确认”，不要编造身份。

3. 实体与物体分析
- 识别重要物体、品牌、Logo、地点、设备、动物等。
- 描述它们的位置、外观、状态以及相互关系。

4. 文字信息
- 提取图片中的文字（OCR），包括标题、对话、UI、标识等。
- 保留原文，并说明文字所在位置。

5. 场景和细节理解
- 描述人物动作、表情、服饰、环境、关键细节。
- 对图片中的事件、用途或背景进行合理推测。

输出要求：
- 优先提供事实信息，不要遗漏重要细节。
- 区分“明确看到的信息”和“推测信息”。
- 不确定时明确说明，不要产生幻觉。
- 输出内容应让一个没有看到图片的大语言模型也能完整理解图片。

输出格式：

【图片概览】
...

【人物/角色】
...

【实体与物体】
...

【文字信息】
...

【场景与细节】
...

【不确定信息】
...`;

// 图片理解的固定用户指令。maxChars 由代码注入（是行为参数不是提示词内容），
// 所以拼在这里而不是 system 里，方便运行时调整。
function buildUserPrompt(maxChars: number): string {
  return `请按系统指令描述这张图片。描述控制在 ${maxChars} 字以内。`;
}

// describeImage 的输入用"原始字节 + MIME 类型"而不是 URL：下载是上层的事
//（QQ 附件 URL 有时效，且下载策略/超时/重试由上层统一管），本函数专注"已有字节→描述"。
// 图片以 data URL 形式内联进 user message（OpenAI 兼容格式的标准传法，
// 官方建议 Base64 方式原始文件小于 7MB，QQ 图片附件一般远小于这个数）。
export async function describeImage(
  imageBytes: Uint8Array,
  mimeType: string,
  options: DescribeImageOptions = {},
): Promise<string> {
  const maxChars = options.maxDescriptionChars ?? 500;

  // API key 未配置 = 多模态功能整体关闭。调用方（agentService）会先检查这个
  // 状态并跳过看图，但这里再守一道：直接调用本函数（比如测试脚本）时给出明确报错。
  if (config.visionApiKey === "") {
    throw new Error("VISION_API_KEY 未配置，图像理解功能未启用");
  }

  const body = {
    model: config.visionModel,
    // Qwen3.5 之后的系列（含默认的 qwen3.7-flash）思考模式默认开启，思考 token
    // 按输出计费且显著拉高延迟——图片描述是简单任务，显式关掉。这和 DeepSeek
    // "thinking 默认开启、必须显式 disabled"是同一个坑，只是开关的名字不同。
    enable_thinking: false,
    messages: [
      { role: "system", content: DESCRIBE_SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: {
              // Buffer 是 Uint8Array 的子类，base64 序列化用 Buffer 最直接。
              url: `data:${mimeType};base64,${Buffer.from(imageBytes).toString("base64")}`,
            },
          },
          { type: "text", text: buildUserPrompt(maxChars) },
        ],
      },
    ],
  };

  const t0 = Date.now();
  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.visionApiKey}`,
    },
    body: JSON.stringify(body),
  });

  const elapsed = Date.now() - t0;
  const data = (await response.json()) as ChatCompletionResponse;

  if (!response.ok) {
    // 错误信息里带上服务端返回的 message 方便排查（key 无效/限流/图片超限等）；
    // 上层可按需重试或降级。
    const detail = data.error?.message ?? data.message ?? `HTTP ${response.status}`;
    throw new Error(`千问图像理解失败（+${elapsed}ms）: ${detail}`);
  }

  const text = data.choices?.[0]?.message?.content?.trim();
  if (text === undefined || text === "") {
    throw new Error(`千问返回里没有文本内容（+${elapsed}ms）`);
  }

  // 超长截断：模型不一定严格遵守字数限制，硬保证一下（从尾部截会丢结论，
  // 截断标记提示下游"这不是完整描述"）。
  const result =
    text.length > maxChars ? `${text.slice(0, maxChars)}…（描述已截断）` : text;

  logger.info(
    "vision",
    `图像理解完成 (+${elapsed}ms) 图片${imageBytes.length}字节 → 描述${result.length}字`,
  );
  // 描述本体单独一条打出来（150 字截断，对齐 model.ts truncateContent 的口径：
  // 够看出这次"看懂了什么"即可，全量描述可能几百字，刷屏）。
  logger.info(
    "vision",
    `描述预览: ${result.length > 150 ? `${result.slice(0, 150)}...` : result}`,
  );
  return result;
}
