// services/embedding.ts —— 调用智谱 BigModel 的文本嵌入接口，给长期记忆 RAG 召回用。
// 职责单一：给一段文本，返回它的 embedding 向量。角色和 search.ts 的 webSearch 一样，
// 是个纯函数服务，不实现 CommandService。

import { config } from "../config.js";

const API_URL = "https://open.bigmodel.cn/api/paas/v4/embeddings";

// 智谱 embedding-3 支持可变维度，1024 是官方示例常用值，够表达语义又不占太多存储。
const DIMENSIONS = 1024;

interface EmbeddingResponse {
  data?: Array<{ embedding?: number[] }>;
}

export async function embedText(text: string): Promise<number[]> {
  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.embeddingApiKey}`,
    },
    body: JSON.stringify({
      model: config.embeddingModel,
      input: text,
      dimensions: DIMENSIONS,
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Embedding 接口返回 ${response.status}: ${detail}`);
  }

  const data = (await response.json()) as EmbeddingResponse;
  const embedding = data.data?.[0]?.embedding;
  if (embedding === undefined) {
    throw new Error("Embedding 接口返回里没有 embedding 字段");
  }
  return embedding;
}
