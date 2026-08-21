# 多模态理解方案：Gemini 图片理解接入

日期：2026-08-18
状态：设计方案（未实现）
范围：接收侧图片理解。发送侧图片、视频/语音理解仅留接口，不做。

## 1. 背景与目标

用户给机器人发图片时，机器人目前只能看到 `content` 文本（图片消息的 content 常为空或仅有附带的文字），`attachments` 里的图片 URL 在事件解析层就被丢弃——机器人在"看图"这件事上是全盲的。

目标：用户发图（单聊或群里@机器人）时，机器人能理解图片内容并正常对话。选型 Gemini（用户已有 AI Studio API key）做视觉理解。

## 2. 核心决策：眼睛 + 大脑架构（图片描述化）

**Gemini 只当"眼睛"，不当"脑"**：

```
QQ事件(attachments[].url) → 下载图片 → Gemini 生成中文描述（vision.ts）
                                        ↓
agent 链路拿到的输入 = 用户文字 + "[用户发了一张图片：描述……]"
                                        ↓
                    DeepSeek 主链路（人设/记忆/工具）完全不动
```

理由：

1. **主模型不能换**：DeepSeek API 不支持图像输入（deepseek-vl 未开放 API），若让 Gemini 直接接管对话，等于重写整个 agent 链路；
2. **描述化让现有能力全部白拿**：图片描述作为普通文本进入链路后，短期记忆（群里聊过的图有上下文）、长期记忆（"记住我头像"类信息可入库）、工具调用（"搜一下图里这个角色"）、人设回复全部自动工作，零改动；
3. **故障隔离**：Gemini 挂了/网络不通时只是"描述生成失败"，可降级为"图片我暂时看不了"，主对话链路不受影响。

代价：描述是有损压缩，模型看不到原图细节（如让模型数图里的字、识别小字截图时精度受限于描述质量）。缓解：描述 prompt 要求详尽（OCR 文字逐字转写、画面元素、颜色、风格、可能的语境），并保留原 URL 供后续升级为原生多模态。

## 3. Gemini API 调研结论

### 3.1 接口格式（REST 直调，零新依赖）

符合项目"内置优先、手写 fetch"的口味（同 embedding.ts 的做法），**不需要装 @google/genai SDK**：

```
POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
Header: x-goog-api-key: <GEMINI_API_KEY>
Content-Type: application/json

{
  "systemInstruction": { "parts": [{ "text": "你是图像描述助手……" }] },
  "contents": [{
    "role": "user",
    "parts": [
      { "text": "请详细描述这张图片" },
      { "inline_data": { "mime_type": "image/jpeg", "data": "<base64>" } }
    ]
  }]
}
```

响应取 `candidates[0].content.parts[].text` 拼接。图片走 `inline_data`（base64 内联），单请求总载荷上限 20MB，聊天图片（通常 <1MB）远在限内，无需 Files API。

### 3.2 模型（2026-08-18 经代理实测官方文档确认）

- 默认 **`gemini-3.6-flash`**（官方描述：为速度打造的最智能模型，前沿智能 + 搜索/grounding；有 Free Tier）。更新已有 `gemini-3.7-flash`（多模态 agentic 工作流最强 flash），以及更省的 `gemini-3.5-flash-lite` / `gemini-3.1-flash-lite`；
- 模型名做成配置项 `GEMINI_MODEL`，默认 3.6-flash；要更省钱切 flash-lite，要更强切 3.7-flash 或 pro 系；
- `generateContent` 请求格式沿用（contents/parts/inline_data/systemInstruction），与模型小版本无关。

### 3.3 图片输入的三种方式（官方文档确认）

| 方式 | 适用 | 说明 |
|---|---|---|
| `inline_data`（base64） | **本项目采用** | 总请求（文本+system+inline 字节）上限 **20MB**，聊天图片远在限内 |
| URL 直接传 | 公网可访问的图 | QQ 附件 URL 理论可用，但 URL 需 Google 服务器可访问，QQ 多媒体服务器未必放行境外抓取——不采用，统一走下载+inline 更可控 |
| Files API | 大文件/复用 | 超限才需要，本项目不做 |

其他要点：单请求最多 3600 张图（无虞）；图片按分辨率折算 token（768px 以上切块计费，258 tokens/块起）；`media_resolution` 参数可调细节识别力（默认即可，小字识别差时再调）。多图 = parts 里多个 inline_data 对象，天然支持。

### 3.5 网络（已定稿：Cloudflare Worker 反代）

- 本机/境内服务器直连 `generativelanguage.googleapis.com`：**被阻断**（DNS 通、TCP 443 不通），不可用；
- `*.workers.dev` 域名：境内 DNS 污染（解析到 Facebook IP 段），不可用；
- **✅ 采用方案：Cloudflare Worker 反代 `https://gemini.zyhbest.site`**（已部署并实测全链路通）：Worker 名 `gemini-proxy`，透传请求到 Google API；自定义域名绑定后橙云代理生效，境内裸连可达（解析到 CF Anycast IP，实测 ~0.9s 响应，错误响应体由 Google 返回证明转发正确）；
- 配置就一个变量：`VISION_BASE_URL=https://gemini.zyhbest.site`（服务器与本机通用）。`VISION_PROXY_URL` 仅本机调试时备用（配 undici ProxyAgent 走本地代理，服务器不需要）；
- 部署要点备忘：Worker 代码见本方案 §3.1 的转发逻辑（15 行透传）；Custom Domain 的 AAAA `100::` 记录是 CF 正常配置（IPv6-only 客户端用），IPv4 客户端靠橙云代理的 Anycast IP 进门；排查时曾遇到的 error 1034 = zone 未激活代理状态，在 Dashboard 确认 zone Active + 记录 Proxied 即恢复。

**解决路径（已定稿）**：Cloudflare Worker 反代。`VISION_BASE_URL=https://gemini.zyhbest.site`（已部署实测通）。备选：本机调试可配 `VISION_PROXY_URL` 走本地代理。

### 3.6 订阅与 API 额度的关系（重要澄清）

「Gemini Pro 会员」（Google AI Pro，~$19.99/月）和 API key 是**两套体系**：

- 订阅权益在 Gemini App/网页端：Pro 系列模型更高用量、Deep Research、Gems、Veo、NotebookLM 加成等——**不包含 API 额度**；
- API key 走 AI Studio 开发者体系：flash 级模型自带免费层（每天数百次请求级别），超出走 API billing（按 token 计费），与订阅月费互不相干。

对本项目的影响：看图机器人量级（每天几十张）大概率落在 flash 免费层内，零成本；要 Pro 级看图质量时改 `GEMINI_MODEL` 走按量计费。附赠便利：订阅账号登录 AI Studio 网页时限额更高，适合调试描述 prompt。

## 4. QQ 侧：事件里图片的承载（现状与改造）

官方文档（事件结构）+ 现有代码对照：

- `C2C_MESSAGE_CREATE` 和 `GROUP_MESSAGE_CREATE` 的 `d.attachments[]` 携带：`url`（图片下载地址，**有时效，需尽快取**）、`content_type`（MIME，如 `image/jpeg`）、`filename`、`size`、`width/height`（仅图片）；
- 现有 `events/*/index.ts` 的守卫只验 `id/content/author` 等，`attachments` 整个被丢弃——**改造点 1**；
- 语音附件官方白送 `asr_refer_text`（ASR 识别文本）和 `voice_wav_url`——将来接语音时**优先用 asr_refer_text，连模型都不用调**（本次不做，方案里记录）。

### 事件层改造

`NormalizedAttachment`（放 `src/types.ts`，供两类事件共用）：

```ts
export interface NormalizedAttachment {
  contentType: string; // "image/jpeg" | "video/mp4" | "voice" | "file" …
  url: string;
  filename: string;
}

export function imageAttachmentsOf(event: BotEvent): NormalizedAttachment[]; // 过滤 image/* 
```

三个事件定义（C2C / GROUP_AT / GROUP_MESSAGE）的守卫增加**宽容解析** `attachments`：字段缺失/为空数组都合法（不是每条消息都有图），逐项验 `url/content_type/filename` 为 string 才收，不合法的项跳过而不是整个事件拒绝。干净事件 interface 加 `attachments: NormalizedAttachment[]`（无图时空数组，避免可选字段的判空噪音）。

## 5. 新模块 `src/services/vision.ts`

定位与 `embedding.ts` 一致：纯函数服务，不发 QQ 消息、不进 agent 图。

```ts
// 统一入口：按 content_type 前缀分发。视频/语音预留，当前抛"暂不支持"
export async function understandMedia(att: NormalizedAttachment): Promise<string>;

// 图片实现：下载 → base64 → Gemini → 中文描述
export async function describeImage(att: NormalizedAttachment): Promise<string>;
```

- `describeImage` 流程：`fetch(att.url)`（QQ 多媒体服务器，国内直连，不走代理）拿字节 → `Buffer.toString("base64")` → 上面 §3.1 的请求体 → 拼回描述文本。图片格式 QQ 主要是 jpeg/png，`content_type` 直接透传给 `mime_type`；
- 描述 prompt（systemInstruction）：要求输出一段紧凑中文描述，包含——画面主体与布局、显著文字逐字转写（OCR）、风格/色调、值得注意的细节；结尾单行 50 字内摘要。描述长度控制在 300 字内（要拼进对话上下文，太长污染记忆窗口）；
- **下载和生成各设超时**（如 10s/30s），任一失败抛错由上层降级；
- `understandMedia` 按 `contentType` 前缀分发：`image/*` → describeImage；`video/`、`voice`、`file` → 抛 `UnsupportedMediaError`（带类型名）——这就是给视频/语音留的接口，将来加实现只改这个分发函数。

## 6. Agent 链路接入（改造点最少的路径）

接入点：`src/services/agent.ts` 的 `handle()`（`/Agent` 命令入口）：

```
const imgs = imageAttachmentsOf(ctx.event);
if (imgs.length > 0) {
  const descriptions = await Promise.all(imgs.map(understandMedia)); // 多图并发
  question = `[用户发了一张图片：${descriptions[0]}]\n${question}`;   // 拼进问题文本
}
```

- **多图**：每张一行 `[图片1：…] [图片2：…]` 拼接；
- **纯图片无文字**：`question` 为空但有图时不再报"用法"提示，照常进链路（描述本身就是输入）；
- 群聊非 @ 消息（GROUP_MESSAGE_CREATE handler）目前不触发 agent，行为不变——只有显式 `/Agent` 或后续放开兜底时才看图；
- 降级：`GEMINI_API_KEY` 未配置或调用失败 → 回复"图片我暂时看不了哦～"，不让整个消息失败（`runCommand` 的统一兜错之外再包一层，因为"看图失败但文字还能聊"是合理降级）。

## 7. 配置与文件清单

`.env` 新增（全部可选——不配则多模态功能自动关闭，不影响现有部署启动）：

```
GEMINI_API_KEY=          # AI Studio 的 key
GEMINI_MODEL=            # 默认 gemini-2.5-flash
VISION_BASE_URL=         # 可选，Cloudflare Worker 中转地址
VISION_PROXY_URL=        # 可选，http://127.0.0.1:7890，undici ProxyAgent 专用
```

| 文件 | 改动 |
|---|---|
| `src/config.ts` | 4 个 optionalEnv（geminiApiKey 判空字符串表示未启用） |
| `src/types.ts` | `NormalizedAttachment` + `imageAttachmentsOf` |
| `src/events/*/index.ts` ×3 | 守卫与干净事件补 attachments（宽容解析） |
| `src/services/vision.ts` | 新建：understandMedia / describeImage / 超时与降级 |
| `src/services/agent.ts` | handle() 接入图片描述拼接 |
| `.env.example` | 4 个新变量模板 |
| `package.json` | +undici（仅在使用 VISION_PROXY_URL 时 import，境内直连场景可不装） |

## 8. 边界与风险

- **图片 URL 时效**：QQ 的附件 URL 是临时的，收到事件应尽快下载（本方案是即时下载即用，不缓存 URL）；
- **20MB inline 上限**：聊天图片远小于此，超限时描述失败走降级，不做 Files API 分片；
- **免费档限流**：2.5-flash 免费档有 RPM/RPD 限制，被 429 时降级话术同样生效；日志打 status 方便排查；
- **描述质量**：截图小字、长图细节可能转写不全——prompt 已要求 OCR 逐字转写，实际效果需上线观察，必要时换 gemini-3 系列；
- **多模态进记忆**：描述文本会随对话写进短期记忆（符合预期）；长期记忆是否值得为图片单独开工具（如"记住这张图"），超出本次范围。

## 9. 明确排除

- 发送图片（回复图片需走 QQ 文件上传接口 + msg_type=7，另立方案）；
- 视频/语音理解（接口已留：understandMedia 的分发点 + asr_refer_text 白送文本的路径记录在案）；
- Gemini 参与主对话/工具调用（眼睛+大脑架构下无必要）；
- 频道场景（项目未接频道事件）。
