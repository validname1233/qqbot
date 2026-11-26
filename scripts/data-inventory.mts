// scripts/data-inventory.mts —— conversation_events 微调原料盘点（只读，可放心在生产库跑）。
// 用法（服务器仓库根目录）：
//   node --experimental-strip-types scripts/data-inventory.mts
//   （或 npx tsx scripts/data-inventory.mts；两者都只读 SELECT，不写任何东西）
//
// 盘点维度：
//   ① 总量：各 kind 行数、时间跨度
//   ② 对话对：user→bot 的配对数（同 key 相邻原则 + 时间窗容差），微调体量的核心指标
//   ③ 多轮会话：按 key + 2h 空闲切 session，session 长度分布
//   ④ origin 分布：bot 回复的来源构成（微调时的过滤依据）
//   ⑤ 质量预筛：兜底文案/超短/超长回复占比（坏样本的规模感）
//   ⑥ 语料规模估算：过滤后预计可用 token/字符量
//   ⑦ 长期记忆与人格表顺带盘点

import { DatabaseSync } from "node:sqlite";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DB_PATH = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "../data/memory.sqlite");
const db = new DatabaseSync(DB_PATH);

const fmt = (n: number): string => n.toLocaleString("zh-CN");
const pct = (n: number, total: number): string => (total === 0 ? "-" : `${((n / total) * 100).toFixed(1)}%`);
// 群聊默认 2 小时切会话（与 L1 的 SESSION_WINDOW_HOURS 同语义）
const SESSION_GAP_MS = 2 * 60 * 60 * 1000;
// 问答对配对容差：user 行之后 10 分钟内的首个 bot 行算它的回复
const PAIR_WINDOW_MS = 10 * 60 * 1000;

console.log(`\n=== 微调原料盘点：${DB_PATH} ===\n`);

// ---------- ① 总量 ----------
{
  const kinds = db.prepare(
    `SELECT kind, COUNT(*) AS n FROM conversation_events GROUP BY kind ORDER BY n DESC`,
  ).all() as Array<{ kind: string; n: number }>;
  const span = db.prepare(
    `SELECT MIN(created_at) AS lo, MAX(created_at) AS hi, COUNT(*) AS n FROM conversation_events`,
  ).get() as { lo: number; hi: number; n: number };
  console.log("① 总量");
  for (const k of kinds) console.log(`   ${k.kind.padEnd(10)} ${fmt(k.n)} 行`);
  const days = span.hi > 0 ? ((span.hi - span.lo) / 86400000).toFixed(1) : "0";
  console.log(`   时间跨度：${span.lo > 0 ? new Date(span.lo).toLocaleDateString("zh-CN") : "-"} ~ ${new Date(span.hi).toLocaleDateString("zh-CN")}（${days} 天）\n`);
}

// ---------- 取全部 chat 行（后续各节的公共原料） ----------
interface ChatRow { id: number; key: string; kind: string; author_name: string | null; content: string | null; origin: string | null; created_at: number; }
const chatRows = db.prepare(
  `SELECT id, key, kind, author_name, content, origin, created_at
   FROM conversation_events WHERE kind IN ('chat_user','chat_bot') ORDER BY id ASC`,
).all() as unknown as ChatRow[];

// ---------- ② 对话对配对 ----------
// 规则：bot 行向前找同 key、10 分钟内最近的 user 行配对（一个 user 行只配一次）。
{
  const byKey = new Map<string, ChatRow[]>();
  for (const r of chatRows) {
    const list = byKey.get(r.key) ?? [];
    list.push(r);
    byKey.set(r.key, list);
  }
  let pairs = 0;
  let multiTurnSessions = 0; // ≥3 轮的 session（多轮对话微调更有价值）
  const sessionLens: number[] = [];
  for (const [key, rows] of byKey) {
    // ②-a 配对
    const usedUser = new Set<number>();
    for (const r of rows) {
      if (r.kind !== "chat_bot") continue;
      for (let i = rows.indexOf(r) - 1; i >= 0; i--) {
        const prev = rows[i];
        if (r.created_at - prev.created_at > PAIR_WINDOW_MS) break;
        if (prev.kind === "chat_user" && !usedUser.has(prev.id)) {
          usedUser.add(prev.id);
          pairs++;
          break;
        }
      }
    }
    // ②-b session 切分（2h 空闲）
    let curLen = 0;
    let prevTs = -1;
    for (const r of rows) {
      if (prevTs >= 0 && r.created_at - prevTs > SESSION_GAP_MS) {
        sessionLens.push(curLen);
        if (curLen >= 3) multiTurnSessions++;
        curLen = 0;
      }
      curLen++;
      prevTs = r.created_at;
    }
    if (curLen > 0) {
      sessionLens.push(curLen);
      if (curLen >= 3) multiTurnSessions++;
    }
    void key;
  }
  const botCount = chatRows.filter((r) => r.kind === "chat_bot").length;
  const avgLen = sessionLens.length > 0 ? (chatRows.length / sessionLens.length).toFixed(1) : "0";
  console.log("② 对话对与会话");
  console.log(`   chat 行共 ${fmt(chatRows.length)}（user ${fmt(chatRows.filter(r=>r.kind==='chat_user').length)} / bot ${fmt(botCount)}）`);
  console.log(`   可配对 (user→bot) 问答对：${fmt(pairs)}（占 bot 行 ${pct(pairs, botCount)}——未配上的多为 cron 推送/无人触发的回复）`);
  console.log(`   会话数（2h 切分）：${fmt(sessionLens.length)}，平均 ${avgLen} 行；多轮会话（≥3 行）${fmt(multiTurnSessions)} 个\n`);
}

// ---------- ④ origin 分布 ----------
{
  const origins = db.prepare(
    `SELECT origin, COUNT(*) AS n FROM conversation_events WHERE kind='chat_bot' GROUP BY origin ORDER BY n DESC`,
  ).all() as Array<{ origin: string | null; n: number }>;
  const botTotal = chatRows.filter((r) => r.kind === "chat_bot").length;
  console.log("④ bot 回复来源（origin）");
  for (const o of origins) console.log(`   ${(o.origin ?? "(null)").padEnd(14)} ${fmt(o.n)}  ${pct(o.n, botTotal)}`);
  console.log("");
}

// ---------- ⑤ 质量预筛 ----------
{
  const bots = chatRows.filter((r) => r.kind === "chat_bot" && r.content !== null);
  const BAD_PATTERNS = [
    "功能暂时坏了", "稍后再试", "执行失败", "发送失败", "出错",
    "未知命令", "用法：", "已过期", "没有在跑的任务",
  ];
  const isBad = (c: string): boolean =>
    BAD_PATTERNS.some((p) => c.includes(p)) || c.trim().length < 4;
  const bad = bots.filter((r) => isBad(r.content!));
  const veryLong = bots.filter((r) => r.content!.length > 4000);
  const users = chatRows.filter((r) => r.kind === "chat_user");
  const userEmpty = users.filter((r) => (r.content ?? "").trim() === "");
  console.log("⑤ 质量预筛（bot 回复侧）");
  console.log(`   兜底/用法/超短（<4字）类：${fmt(bad.length)}  ${pct(bad.length, bots.length)} —— 微调应剔除`);
  console.log(`   超长（>4000字）：${fmt(veryLong.length)}  ${pct(veryLong.length, bots.length)} —— 建议人工抽查`);
  console.log(`   空文本 user 行（纯图片/表情）：${fmt(userEmpty.length)}  ${pct(userEmpty.length, users.length)}\n`);
}

// ---------- ⑥ 过滤后规模估算 ----------
{
  const BAD_PATTERNS = ["功能暂时坏了", "稍后再试", "执行失败", "发送失败", "出错", "未知命令", "用法：", "已过期", "没有在跑的任务"];
  const clean = chatRows.filter((r) => {
    if (r.kind === "chat_user") return (r.content ?? "").trim() !== "";
    const c = r.content ?? "";
    return !BAD_PATTERNS.some((p) => c.includes(p)) && c.trim().length >= 4 && c.length <= 4000;
  });
  const chars = clean.reduce((s, r) => s + (r.content ?? "").length, 0);
  const tokens = Math.round(chars * 0.6); // 中文≈0.6 token/字（与 estimateTokens 同档粗估）
  console.log("⑥ 过滤后可用语料（初筛口径）");
  console.log(`   干净 chat 行：${fmt(clean.length)}，合计 ${fmt(chars)} 字符 ≈ ${fmt(tokens)} tokens`);
  console.log(`   参考：LoRA 有效起步 ~1M tokens / 全面 SFT ~10M tokens\n`);
}

// ---------- ⑦ 附属表 ----------
{
  for (const [table, desc] of [
    ["long_term_memories", "长期记忆"],
    ["message_images", "图片伴生"],
  ] as const) {
    try {
      const n = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
      let extra = "";
      if (table === "message_images") {
        const d = db.prepare(`SELECT COUNT(*) AS n FROM message_images WHERE description IS NOT NULL`).get() as { n: number };
        extra = `，已识图 ${fmt(d.n)}`;
      }
      console.log(`⑦ ${desc}（${table}）：${fmt(n.n)} 行${extra}`);
    } catch {
      console.log(`⑦ ${desc}（${table}）：表不存在`);
    }
  }
  try {
    const p = db.prepare(`SELECT COUNT(*) AS n FROM group_personalities`).get() as { n: number };
    console.log(`   自定义人格：${fmt(p.n)} 个（人格→回复映射微调可用，需 join）`);
  } catch {
    console.log(`   自定义人格：表不存在（未启用过 /set_personality）`);
  }
}

console.log("\n（只读盘点，未修改任何数据）\n");
