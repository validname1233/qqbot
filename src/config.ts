// config.ts —— 集中读取和校验环境变量。
// 好处：凭据"从哪来、缺了怎么报错"只写一遍，别处直接 import 现成的值。

// process.env 是 Node 提供的环境变量对象，类型是 Record<string, string | undefined>——
// 注意每个值可能是 undefined（变量没设时），所以下面必须检查。
import { readFileSync } from "node:fs";
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

// MCP 服务器配置（mcp.json）：一条服务器 = url + 可选 apiKey + 可选 expose。
// 校验失败直接抛错——配置错误让启动期就报清楚哪一条不对，比静默跳过半台服务器好。
export interface McpServerConfig {
  name: string;
  url: string;
  apiKey: string; // 可为空串（自部署内网服务器不鉴权）
  expose: string[]; // 该服务器放行进模型工具表的工具名，"*" = 全放行；空数组 = 全不放行（仅作远程内核直调）
  progressNotes: Record<string, string>; // 工具名 → 进度推送文案（progress-bus）；未配置的工具用默认文案
}

// 读取并校验 mcp.json。文件不存在 = MCP 层不启用（返回空数组）；存在但解析/校验
// 失败 = 抛错。路径可用 MCP_CONFIG_PATH 覆盖（测试脚本指自己的临时配置）。
function loadMcpConfig(): McpServerConfig[] {
  const path = optionalEnv("MCP_CONFIG_PATH", "mcp.json");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return []; // 文件不存在：合法的"不启用"状态
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`MCP 配置 ${path} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }

  const servers = (parsed as { servers?: unknown }).servers;
  if (servers === undefined || typeof servers !== "object" || servers === null || Array.isArray(servers)) {
    throw new Error(`MCP 配置 ${path} 缺少 "servers" 对象（形如 { "servers": { "名字": { "url": "...", "apiKey": "...", "expose": ["*"] } } }）`);
  }

  const out: McpServerConfig[] = [];
  for (const [name, value] of Object.entries(servers as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) {
      throw new Error(`MCP 配置 ${path}：服务器 "${name}" 的值必须是对象`);
    }
    const { url, apiKey, expose, progressNotes } = value as {
      url?: unknown; apiKey?: unknown; expose?: unknown; progressNotes?: unknown;
    };
    if (typeof url !== "string" || url.trim() === "") {
      throw new Error(`MCP 配置 ${path}：服务器 "${name}" 缺少 url`);
    }
    if (apiKey !== undefined && typeof apiKey !== "string") {
      throw new Error(`MCP 配置 ${path}：服务器 "${name}" 的 apiKey 必须是字符串`);
    }
    if (expose !== undefined && !Array.isArray(expose)) {
      throw new Error(`MCP 配置 ${path}：服务器 "${name}" 的 expose 必须是字符串数组（如 ["kb_search"] 或 ["*"]）`);
    }
    // progressNotes：工具名 → 文案 的扁平对象；key 对应 tools/list 里的工具名
    //（不带 mcp_ 前缀——前缀是 bot 侧包装规则，不进用户配置）
    const notes: Record<string, string> = {};
    if (progressNotes !== undefined) {
      if (typeof progressNotes !== "object" || progressNotes === null || Array.isArray(progressNotes)) {
        throw new Error(`MCP 配置 ${path}：服务器 "${name}" 的 progressNotes 必须是对象（形如 { "工具名": "文案" }）`);
      }
      for (const [tool, note] of Object.entries(progressNotes as Record<string, unknown>)) {
        if (typeof note !== "string" || note.trim() === "") {
          throw new Error(`MCP 配置 ${path}：服务器 "${name}" 的 progressNotes["${tool}"] 必须是非空字符串`);
        }
        notes[tool] = note;
      }
    }
    out.push({
      name,
      url: url.trim(),
      apiKey: (apiKey ?? "").trim(),
      expose: (expose as unknown[] | undefined ?? []).filter((e): e is string => typeof e === "string"),
      progressNotes: notes,
    });
  }
  return out;
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
  // 文件日志的 detail 通道开关（选填）：file（默认，LLM 输入输出/工具结果全文
  // 落盘）/ off（回退到"只有控制台"）。见 2026-09-20-日志体系重构方案.md。
  logDetail: optionalEnv("LOG_DETAIL", "file") === "file",
  // 文件日志保留天数（选填）：超过的 bot-YYYY-MM-DD.log 启动时清理；0 = 永久。默认 14。
  logRetentionDays: optionalEnvNumber("LOG_RETENTION_DAYS", 14),
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
  // 记忆与上下文重构（docs/features/2026-10-28-记忆与上下文重构总方案.md
  // 模块二 §1.4 v10 终版——压缩是纯投影行为，两条规则）：
  //   contextMaxMessages   —— L1 条数截断上限：候选 chat 行超过则只保留最近
  //                           N 行（规则①；未来可换 token 驱动判定）。
  //   sessionWindowHours   —— L1 时间窗：chat 行 created_at 距装配时刻超过
  //                           该小时数的行离开投影（规则②；设 0 关闭）。
  //   recallDepthN          —— recall_memory 回看的 chat 行深度（兼 images prune 锚点）。
  //   recallSummaryMinChars —— recall 文本包小于该字符数时原文直返、不过摘要 LLM。
  contextMaxMessages: optionalEnvNumber("CONTEXT_MAX_MESSAGES", 200),
  sessionWindowHours: optionalEnvNumber("SESSION_WINDOW_HOURS", 2),
  recallDepthN: optionalEnvNumber("RECALL_DEPTH_N", 300),
  recallSummaryMinChars: optionalEnvNumber("RECALL_SUMMARY_MIN_CHARS", 800),
  // MCP 服务器接入（mcp.json，可选，文件不存在则 MCP 层整体不启用）：
  //   mcpServerConfigs —— 逐服务器 { name, url, apiKey, expose }。apiKey 非空时以
  //                       Authorization: Bearer 头随每个请求发送（公网服务器的鉴权）；
  //                       expose 是闸门（哪些工具进模型工具表，"*" 全放行），空 = 只作
  //                       远程内核被代码直调。路径可用 MCP_CONFIG_PATH 覆盖。
  //   mcpCallTimeoutMs —— 单次 tools/call 超时，防远程服务器卡死拖垮深检预算。
  mcpServerConfigs: loadMcpConfig(),
  mcpCallTimeoutMs: optionalEnvNumber("MCP_CALL_TIMEOUT_MS", 30000),
  // 租户 Python 工作台（/代码 与 workspace_task 委派，方案见
  // docs/features/2026-10-10-租户Python工作台设计方案.md）。全部可选：
  //   workspaceEnabled     —— 总开关，默认 false；关闭时 /代码 提示未开启、
  //                           workspace_task 不注册进主 Agent 工具表。
  //   workspaceRoot        —— workspace 根目录（每租户一个 sha256(tenantKey) 子目录）。
  //                           生产默认 /var/lib/qqbot-workspaces；本地测试可指
  //                           ./data/test-workspaces 之类。
  //   workspaceImage       —— 执行镜像（GHCR 的 qqbot-python，白名单库由镜像内容决定）。
  //   workspaceMemory/Cpus/PidsLimit —— 容器 cgroup 限额（内存池/CPU 上限/fork 兜底）。
  //   workspaceCmdTimeoutMs —— 单条命令墙钟（容器内 timeout 自杀，docker exec 无单独 kill）。
  //   workspaceBudgetMs    —— 单任务总预算：图轮次边界检查 + 容器 sleep 自毁定时器。
  //   workspaceMaxTurns    —— 子 Agent 图的工具轮次上限。
  //   workspaceOutputLimit —— 单条命令 stdout/stderr 各自的截断上限（字节）。
  //   workspaceReadMaxLines/ReadMaxBytes —— read_file 单次输出上限（双上限先到为准）。
  //   workspaceGrepMaxMatches/GlobMaxResults —— 检索类工具的结果条数上限。
  //   workspaceMaxFileBytes/DiskQuotaBytes/MaxFiles —— 写入前置配额（单文件/总量/文件数）。
  workspaceEnabled: optionalEnv("WORKSPACE_ENABLED", "false") === "true",
  workspaceRoot: optionalEnv("WORKSPACE_ROOT", "/var/lib/qqbot-workspaces"),
  workspaceImage: optionalEnv("WORKSPACE_IMAGE", "ghcr.io/OWNER/qqbot-python:latest"),
  workspaceMemory: optionalEnv("WORKSPACE_MEMORY", "256m"),
  workspaceCpus: optionalEnv("WORKSPACE_CPUS", "1"),
  workspacePidsLimit: optionalEnvNumber("WORKSPACE_PIDS_LIMIT", 64),
  workspaceCmdTimeoutMs: optionalEnvNumber("WORKSPACE_CMD_TIMEOUT_MS", 60000),
  workspaceBudgetMs: optionalEnvNumber("WORKSPACE_BUDGET_MS", 300000),
  workspaceMaxTurns: optionalEnvNumber("WORKSPACE_MAX_TURNS", 12),
  workspaceOutputLimit: optionalEnvNumber("WORKSPACE_OUTPUT_LIMIT", 65536),
  workspaceReadMaxLines: optionalEnvNumber("WORKSPACE_READ_MAX_LINES", 500),
  workspaceReadMaxBytes: optionalEnvNumber("WORKSPACE_READ_MAX_BYTES", 32768),
  workspaceGrepMaxMatches: optionalEnvNumber("WORKSPACE_GREP_MAX_MATCHES", 50),
  workspaceGlobMaxResults: optionalEnvNumber("WORKSPACE_GLOB_MAX_RESULTS", 200),
  workspaceMaxFileBytes: optionalEnvNumber("WORKSPACE_MAX_FILE_BYTES", 1048576),
  workspaceDiskQuotaBytes: optionalEnvNumber("WORKSPACE_DISK_QUOTA_BYTES", 104857600),
  workspaceMaxFiles: optionalEnvNumber("WORKSPACE_MAX_FILES", 200),
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
