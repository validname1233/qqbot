// sqlite.ts —— B 组（分词入库）的存储层：node:sqlite（Node 24 内置，和生产同款）。
// 模拟生产 long_term_memories 表的关键部分：content 原文 + tokens 列（JSON 词项数组）。
// 独立数据库文件，实验跑完整个删除，不碰生产 data/memory.sqlite。

import { DatabaseSync } from "node:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tokenize } from "./tokenizer.js";

export interface StoredDoc {
  id: number;
  content: string;
  tokens: string[]; // 已解析的词项数组
}

export class TokenStore {
  private db: DatabaseSync;
  private readonly dbPath: string;

  constructor(dbPath: string) {
    mkdirSync(join(dbPath, ".."), { recursive: true });
    this.dbPath = dbPath;
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS docs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        tokens TEXT NOT NULL
      )
    `);
  }

  // 写入：模拟生产的 add() —— 写入时一次性分词落库（B 组的"预付成本"）。
  insertAll(contents: string[]): void {
    const stmt = this.db.prepare(
      "INSERT INTO docs (content, tokens) VALUES (?, ?)",
    );
    const tx = this.db.prepare("BEGIN");
    tx.run();
    for (const content of contents) {
      stmt.run(content, JSON.stringify(tokenize(content)));
    }
    this.db.prepare("COMMIT").run();
  }

  // 检索候选读取：content 原文 + tokens 现场反序列化（B 组检索时的全部读取成本）。
  loadAll(): StoredDoc[] {
    const rows = this.db
      .prepare("SELECT id, content, tokens FROM docs")
      .all() as Array<{ id: number; content: string; tokens: string }>;
    return rows.map((row) => ({
      id: row.id,
      content: row.content,
      tokens: JSON.parse(row.tokens) as string[],
    }));
  }

  // 实验结束删除数据库文件，保持文件夹干净。
  dispose(): void {
    this.db.close();
    rmSync(this.dbPath, { force: true });
  }
}
