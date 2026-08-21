// test/recall/seed.ts —— 把 data/corpus.json 的测试语料灌进测试库。
// 由 run.sh 设置 MEMORY_DB_PATH=recall-test.sqlite，落到独立的 data/recall-test.sqlite，
// 与生产 memory.sqlite 文件级隔离。写入走生产的 longTermMemoryStore.add：真实 embedding
// + 分词落库，和生产写入路径完全一致（约 100 次 embedding 调用，需几十秒）。
// 用法：npx tsx --env-file=.env test/recall/seed.ts [--force]（--force 清空该 key 后重灌）

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { longTermMemoryStore } from "../../src/agent/memory/long-term.js";

interface CorpusEntry {
  id: string;
  content: string;
  memory_index: string;
}

interface TestConfig {
  dbKey: string;
  corpusFile: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const config: TestConfig = JSON.parse(readFileSync(join(__dirname, "config.json"), "utf-8"));
const corpus: CorpusEntry[] = JSON.parse(readFileSync(join(__dirname, config.corpusFile), "utf-8"));

// corpus 的 content 必须唯一：eval 靠 content ↔ corpus id 的映射对回 gold 标注。
const uniqueContents = new Set(corpus.map((c) => c.content));
if (uniqueContents.size !== corpus.length) {
  console.error("[seed] corpus.json 里有重复的 content，无法建立 id 映射");
  process.exit(1);
}

const force = process.argv.includes("--force");
const existing = await longTermMemoryStore.list(config.dbKey);
if (existing.length > 0 && !force) {
  console.log(`[seed] 测试 key ${config.dbKey} 已有 ${existing.length} 条，跳过（加 --force 重灌）`);
} else {
  for (const mem of existing) {
    await longTermMemoryStore.remove(mem.id);
  }
  if (force && existing.length > 0) {
    console.log(`[seed] --force：已清掉旧数据 ${existing.length} 条`);
  }

  console.log(`[seed] 开始灌库：${corpus.length} 条 → key=${config.dbKey}（含真实 embedding 调用）`);
  for (let i = 0; i < corpus.length; i++) {
    const entry = corpus[i];
    await longTermMemoryStore.add(
      config.dbKey,
      { openid: "test-user", name: "测试" },
      entry.content,
      entry.memory_index,
    );
    if ((i + 1) % 10 === 0) {
      console.log(`[seed] 进度 ${i + 1}/${corpus.length}`);
    }
  }
  const final = await longTermMemoryStore.list(config.dbKey);
  console.log(`[seed] 完成，库中现有 ${final.length} 条`);
}
