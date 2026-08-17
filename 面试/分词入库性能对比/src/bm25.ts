// bm25.ts —— 生产代码 src/agent/memory/long-term.ts 里 bm25Scores 的快照复制
//（2026-08-17，该函数在生产侧是模块私有、未导出，只能复制）。
// 常量与公式逐字一致，保证实验测出的差异只来自"分词时机"，不来自打分实现。

// BM25 默认参数：k1 调词频饱和度，b 调长度归一化强度。业界默认值。
const BM25_K1 = 1.5;
const BM25_B = 0.75;

// 输入已分好词：docs 是每篇文档的词项数组，query 是查询词项数组。返回每篇的分数。
function bm25Scores(docs: string[][], query: string[]): number[] {
  const docCount = docs.length;
  const termFreqs = docs.map((tokens) => {
    const freq = new Map<string, number>();
    for (const t of tokens) freq.set(t, (freq.get(t) ?? 0) + 1);
    return freq;
  });
  const docLengths = docs.map((tokens) => tokens.length);
  const avgDocLength =
    docCount === 0 ? 0 : docLengths.reduce((sum, len) => sum + len, 0) / docCount;

  const docsContaining = new Map<string, number>();
  for (const term of query) {
    if (docsContaining.has(term)) continue;
    let count = 0;
    for (const freq of termFreqs) if (freq.has(term)) count += 1;
    docsContaining.set(term, count);
  }

  return docs.map((_, i) => {
    let score = 0;
    for (const term of query) {
      const tf = termFreqs[i].get(term) ?? 0;
      if (tf === 0) continue;
      const df = docsContaining.get(term) ?? 0;
      const idf = Math.log(1 + (docCount - df + 0.5) / (df + 0.5));
      const norm = 1 - BM25_B + BM25_B * (docLengths[i] / (avgDocLength || 1));
      score += idf * ((tf * (BM25_K1 + 1)) / (tf + BM25_K1 * norm));
    }
    return score;
  });
}

export { bm25Scores };
