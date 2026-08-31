// config.ts —— 集中读取和校验环境变量。
// 好处：凭据"从哪来、缺了怎么报错"只写一遍，别处直接 import 现成的值。

// process.env 是 Node 提供的环境变量对象，类型是 Record<string, string | undefined>——
// 注意每个值都可能是 undefined（变量没设时），所以下面必须检查。
import { env } from "node:process";

// 一个小工具：读取必填的环境变量，缺失就直接抛错退出。
// 返回类型是 string（不是 string | undefined），因为抛错后代码不会往下走，
// TS 能推断出：能返回的一定是字符串。这叫"通过抛错收窄类型"。
function requireEnv(key: string): string {
  const value = env[key];
  if (value === undefined || value === "") {
    throw new Error(
      `缺少环境变量 ${key}。请复制 .env.example 为 .env 并填写真实凭据。`,
    );
  }
  return value;
}

// 把校验好的凭据导出成一个只读对象。
// as const 让 TS 把它当成字面量类型且不可修改，避免别处不小心改动。
// 一个小工具：读取可选的环境变量，缺失时用默认值。
// 和 requireEnv 的区别：这个不抛错，适合"有更好、没有就用默认"的配置。
function optionalEnv(key: string, fallback: string): string {
  const value = env[key];
  return value === undefined || value === "" ? fallback : value;
}

// 数值型可选配置：没填用默认值；填了但不是合法数字也用默认值（不抛错）——
// 调参类配置宁可静默回退到已知好用的值，也不让 bot 因手滑写错而启动失败。
function optionalEnvNumber(key: string, fallback: number): number {
  const value = Number(env[key]);
  return Number.isFinite(value) ? value : fallback;
}

// 把校验好的凭据导出成一个只读对象。
// as const 让 TS 把它当成字面量类型且不可修改，避免别处不小心改动。
export const config = {
  appId: requireEnv("QQ_BOT_APP_ID"),
  appSecret: requireEnv("QQ_BOT_APP_SECRET"),
  // AI 对话用的 DeepSeek 官方 API key（必填）和模型名（选填，有默认）。
  aiApiKey: requireEnv("AI_API_KEY"),
  aiModel: optionalEnv("AI_MODEL", "deepseek-v4-flash"),
  // Agent 最终收尾话术用的模型（选填）。不填就退回和 aiModel 一样，
  // 想让 Agent 的最终回复质量更高时单独配一个更强的模型。
  agentModel: optionalEnv("AGENT_MODEL", optionalEnv("AI_MODEL", "deepseek-v4-pro")),
  // Tavily 联网搜索 API key（必填，Agent 的搜索工具要用）。
  tavilyApiKey: requireEnv("TAVILY_API_KEY"),
  // 联网搜索 provider（选填）：tavily（默认）| aliyun（OpenSearch 联网搜索）。
  // 只影响 webSearch() 的内部分发，三个调用方（Agent 工具/news cron/深检）无感知。
  // 选 aliyun 时下面三个 ALIYUN_SEARCH_* 必填；选 tavily（或不填）时它们可留空。
  searchProvider: optionalEnv("SEARCH_PROVIDER", "tavily"),
  aliyunSearchApiKey: optionalEnv("ALIYUN_SEARCH_API_KEY", ""),
  aliyunSearchHost: optionalEnv("ALIYUN_SEARCH_HOST", ""),
  aliyunSearchWorkspace: optionalEnv("ALIYUN_SEARCH_WORKSPACE", "default"),
  // 智谱 BigModel 的文本嵌入 API key（长期记忆 RAG 召回用，必填）和模型名（选填，有默认）。
  embeddingApiKey: requireEnv("EMBEDDING_API_KEY"),
  embeddingModel: optionalEnv("EMBEDDING_MODEL", "embedding-3"),
  // 长期记忆混合检索的调参项（选填，均有默认值）：
  //   rrfK            —— RRF 融合常数，60 是论文标准值。调小则头部排名权重更尖锐，
  //                      调大则各排名位次的贡献更平缓。
  //   minSimilarity   —— 向量通道的余弦相似度门槛，低于它的候选不进融合。
  //   bm25K1 / bm25B  —— BM25 的词频饱和度与文档长度归一化参数，业界默认 1.5 / 0.75。
  // 都属于"跑真实对话调参"的旋钮，所以走环境变量而不是写死常量。
  rrfK: optionalEnvNumber("RRF_K", 60),
  minSimilarity: optionalEnvNumber("MIN_SIMILARITY", 0.35),
  bm25K1: optionalEnvNumber("BM25_K1", 1.5),
  bm25B: optionalEnvNumber("BM25_B", 0.75),
  // 长期记忆数据库文件名（选填，落在 data/ 目录下）。默认 memory.sqlite（与短期记忆
  // 共用同一个库文件）；test/recall 的评测脚本用 MEMORY_DB_PATH 指向独立的
  // recall-test.sqlite，实现测试库与生产库的文件级隔离。
  memoryDbFile: optionalEnv("MEMORY_DB_PATH", "memory.sqlite"),
  // 千问（Qwen）视觉模型图像理解（vision.ts）。全部可选：VISION_API_KEY 留空 =
  // 多模态功能整体关闭。走 DashScope 的 OpenAI 兼容接口（阿里云国内端点，直连可用）。
  visionApiKey: optionalEnv("VISION_API_KEY", ""),
  visionModel: optionalEnv("VISION_MODEL", "qwen3.7-flash"),
  // 单次 /Agent 最多识图张数（选填）。取窗口内最近的 N 张，防止一次 /Agent
  // 因历史里堆了十几张图而爆量（既慢又贵）。默认 5。
  visionMaxImages: optionalEnvNumber("VISION_MAX_IMAGES", 5),
  // 日志级别下限（选填）：debug / info / warn / error，默认 info。
  // debug 会打印每次 LLM 调用明细；非法值回退 info。见 services/logger.ts。
  logLevel: optionalEnv("LOG_LEVEL", "info"),
  // 深度检索（/深度检索）的预算与抓取限制（选填，均有默认值）：
  //   browseMaxTurns         —— 深检图 browseLlm⇄browseTools 循环上限（日常 Agent 的
  //                             MAX_TOOL_TURNS 保持 1，互不影响）。
  //   browsePageTimeoutMs    —— 单页抓取/动作超时。
  //   browseTotalBudgetMs    —— 整轮深检墙钟预算，超了强制进收尾（QQ 群被动回复窗口 5 分钟）。
  //   browseMaxContentTokens —— 单页正文截断上限（按字符折算，中文 1 字≈1 token）。
  //   browseMaxLinks         —— 每页返回给模型的链接表上限。
  browseMaxTurns: optionalEnvNumber("BROWSE_MAX_TURNS", 6),
  browsePageTimeoutMs: optionalEnvNumber("BROWSE_PAGE_TIMEOUT_MS", 10000),
  browseTotalBudgetMs: optionalEnvNumber("BROWSE_TOTAL_BUDGET_MS", 60000),
  browseMaxContentTokens: optionalEnvNumber("BROWSE_MAX_CONTENT_TOKENS", 3000),
  browseMaxLinks: optionalEnvNumber("BROWSE_MAX_LINKS", 30),
} as const;

// 延迟校验：SEARCH_PROVIDER=aliyun 时阿里三项必填。放在 config 定义之后立即执行，
// 进程启动就报缺（而不是等第一次搜索请求时才炸）——requireEnv 的语义，按条件手写。
if (config.searchProvider === "aliyun") {
  for (const [key, value] of [
    ["ALIYUN_SEARCH_API_KEY", config.aliyunSearchApiKey],
    ["ALIYUN_SEARCH_HOST", config.aliyunSearchHost],
  ] as const) {
    if (value === "") {
      throw new Error(
        `SEARCH_PROVIDER=aliyun 需要配置 ${key}。请复制 .env.example 为 .env 并填写，或把 SEARCH_PROVIDER 改回 tavily。`,
      );
    }
  }
} else if (config.searchProvider !== "tavily") {
  throw new Error(
    `SEARCH_PROVIDER 只能是 tavily 或 aliyun，收到 "${config.searchProvider}"。`,
  );
}
