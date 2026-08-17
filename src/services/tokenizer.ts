// services/tokenizer.ts —— 中文分词：给长期记忆的关键词检索通道用。
// 用 Node 内置的 Intl.Segmenter（ICU 分词），零依赖、无需编译——和本项目
// node:http / node:sqlite / node:crypto 一路的内置优先口味一致。
// 分词器选择被隔离在 tokenize() 这一个函数里：日后若 ICU 对真实 query 切得不好
// （人名、游戏黑话被切碎），换成 @node-rs/jieba 只改本文件，召回链路其余不动。

// 中文停用词表：高频虚词对检索没有区分度，反而稀释 BM25 的有效词权重。
// 不求完备——语料就几十条记忆，目标是把最常见的语气词/助词挡掉。
const STOPWORDS = new Set([
  "的", "了", "是", "我", "你", "他", "她", "它", "我们", "你们", "他们",
  "就", "都", "也", "很", "在", "有", "不", "没", "吗", "呢", "吧", "啊",
  "和", "与", "或", "但", "而", "及", "对", "从", "到", "被", "把", "让",
  "这", "那", "这个", "那个", "这些", "那些", "什么", "怎么", "为什么",
  "会", "能", "可以", "要", "想", "去", "来", "说", "看", "做", "吃",
  "一", "二", "三", "个", "些", "点", "下", "上", "里", "中", "还", "又",
  "再", "只", "才", "更", "最", "太", "真", "好", "多", "少",
]);

// Segmenter 是重量级对象（持有 ICU 资源），模块级建一个复用。
const segmenter = new Intl.Segmenter("zh-Hans", { granularity: "word" });

export function tokenize(text: string): string[] {
  return [...segmenter.segment(text)]
    .filter((s) => s.isWordLike) // 剔除标点、空白、表情
    .map((s) => s.segment.toLowerCase()) // 英文统一小写，避免大小写分裂词项
    .filter((w) => !STOPWORDS.has(w));
}
