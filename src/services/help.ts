// services/help.ts —— 命令型 service：/help 返回命令速查表。
// 速查表内容单一来源：docs/features/2026-08-31-命令速查表.md，读文件而不是硬编码，
// 改速查表只改 md 一处。进程启动时读一次缓存进内存（速查表不常变，没必要每条
// /help 都碰磁盘）；文件读取失败（比如部署时没带上 docs 目录）兜底一段精简提示，
// 不让 /help 整个挂掉。

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CommandService, MessageContext } from "../types.js";
import { logger } from "./logger.js";

const CHEATSHEET_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "docs",
  "features",
  "2026-08-31-命令速查表.md",
);

// 文件缺失/读不了时的兜底：保住 /help 可用，提示去仓库看完整版。
const FALLBACK = [
  "命令速查表：",
  "/Agent <请求> —— 模型自主联网搜索/记忆/提醒，综合作答",
  "/深度检索 <问题>（/ds）—— 深度网络调研出报告",
  "/定时任务 <秒> <内容>（/提醒）—— 到点主动提醒",
  "/新闻订阅 开/关/时间/关键词 —— 每日新闻推送（仅群聊）",
  "/set_personality <描述> —— 自定义人设",
  "/猜数字 —— 1~100 猜数字游戏",
].join("\n");

let cachedCheatsheet: string | null = null;

function loadCheatsheet(): string {
  if (cachedCheatsheet !== null) return cachedCheatsheet;
  try {
    cachedCheatsheet = readFileSync(CHEATSHEET_PATH, "utf-8").trim();
  } catch (error) {
    // 启动后第一条 /help 才会走到这里：记录一次，之后走兜底（不再每次重试读盘）
    logger.warn("help", `速查表文件读取失败，使用内置兜底：${error instanceof Error ? error.message : error}`);
    cachedCheatsheet = FALLBACK;
  }
  return cachedCheatsheet;
}

export const helpService: CommandService = {
  name: "help",
  aliases: ["帮助", "菜单"],

  async handle(_ctx: MessageContext): Promise<string | null> {
    return loadCheatsheet();
  },
};
