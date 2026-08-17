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
  // AI 对话用的硅基流动 API key（必填）和模型名（选填，有默认）。
  aiApiKey: requireEnv("AI_API_KEY"),
  aiModel: optionalEnv("AI_MODEL", "Pro/zai-org/GLM-4.7"),
  // Agent 最终收尾话术用的模型（选填）。不填就退回和 aiModel 一样，
  // 想让 Agent 的最终回复质量更高时单独配一个更强的模型。
  agentModel: optionalEnv("AGENT_MODEL", optionalEnv("AI_MODEL", "Pro/zai-org/GLM-4.7")),
  // Tavily 联网搜索 API key（必填，Agent 的搜索工具要用）。
  tavilyApiKey: requireEnv("TAVILY_API_KEY"),
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
} as const;
