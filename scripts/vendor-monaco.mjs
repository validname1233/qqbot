// scripts/vendor-monaco.mjs —— 一次性下载并裁剪 Monaco Editor（前端方案 §5）。
// 产物提交进库（services/workspace-ui/static/monaco/），服务器 git pull 即部署，
// 全程零 CDN 依赖。重跑可升级版本（Node >=20，全局 fetch）。
//
// 版本钉住 0.44.0（经典 min/vs 布局）：0.5x 起改为哈希平铺 + assets/ 的打包
// 布局，editor.main 硬依赖各 worker 哈希文件，按目录裁剪会做出运行时才 404
// 的残件；经典布局的依赖边界是目录级的，裁剪可预测。
//
// 裁剪规则（经典布局）：
//   - vs/language/typescript 整删（tsWorker ~3.5MB 是大头）。JS/TS 文件的
//     语法高亮由 basic-languages/javascript|typescript 的 Monarch 文法承担
//     （保留），只失去 TS 智能补全——工作台以 Python 为主，Python 本来就
//     无 LSP，一致性可接受；
//   - json/css/html 三个小 LSP 保留（各几百 KB，换来配置/样式文件的真校验）；
//   - basic-languages 只留常用语言（每个几 KB）；
//   - editor.main.nls.<locale>.js 本地化删（保留英文默认）。
//
// 运行：node scripts/vendor-monaco.mjs [版本号，默认 0.44.0]

import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REGISTRY = process.env.MONACO_REGISTRY ?? "https://registry.npmmirror.com";
// Windows 下 file URL 的 pathname 不能直接当路径用（盘符前有斜杠），fileURLToPath 才稳
const OUT_DIR = fileURLToPath(new URL("../src/services/workspace-ui/static/monaco", import.meta.url));

const BASIC_LANGUAGES = new Set([
  "python", "markdown", "javascript", "typescript", "css", "scss", "less",
  "html", "xml", "yaml", "shell", "ini", "sql", "dockerfile", "r", "lua",
]);

const version = process.argv[2] ?? "0.44.0";
const metaUrl = `${REGISTRY}/monaco-editor/${version}`;
console.log(`[1/4] 读取元数据 ${metaUrl}`);
const meta = await (await fetch(metaUrl)).json();
const distTarball = meta.dist?.tarball ?? `${REGISTRY}/monaco-editor/-/monaco-editor-${meta.version}.tgz`;
console.log(`      版本 ${meta.version}`);

const work = mkdtempSync(join(tmpdir(), "monaco-"));
const tgz = join(work, "monaco.tgz");
console.log(`[2/4] 下载 ${distTarball}`);
const body = await (await fetch(distTarball)).arrayBuffer();
if (body.byteLength < 1_000_000) throw new Error(`tarball 过小（${body.byteLength} 字节），可能下载失败`);
writeFileSync(tgz, Buffer.from(body));

console.log("[3/4] 解压");
// 不 shell 外部 tar：Windows Git-Bash 的 tar 对盘符路径有"远程主机"误判和
// 反斜杠转义两重坑——用 npm tar 包（devDependency）。
const tar = await import("tar");
await tar.x({ file: tgz, cwd: work, sync: true });

const minVs = join(work, "package", "min", "vs");
const outVs = join(OUT_DIR, "vs");
// Windows 删大树常撞 EPERM（杀毒/索引器短暂占用），带重试；重试后仍失败才抛
rmSync(OUT_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
mkdirSync(outVs, { recursive: true });

// 整树复制后裁剪（比逐项挑选更能应对上游新增文件）
cpSync(minVs, outVs, { recursive: true });

// TS 智能补全 LSP（tsWorker 3.5MB）——JS/TS 高亮走 basic-languages，不受影响
rmSync(join(outVs, "language", "typescript"), { recursive: true, force: true });

const blDir = join(outVs, "basic-languages");
for (const name of readdirSync(blDir)) {
  if (!BASIC_LANGUAGES.has(name)) rmSync(join(blDir, name), { recursive: true, force: true });
}

const edDir = join(outVs, "editor");
for (const name of readdirSync(edDir)) {
  // editor.main.nls.de.js / .zh-cn.js … 本地化全删；editor.main.nls.js（英文）保留
  if (/^editor\.main\.nls\.[a-z-]+\.js$/.test(name)) rmSync(join(edDir, name));
}

console.log("[4/4] 完成。产物体积：");
let total = 0;
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else total += statSync(full).size;
  }
};
walk(OUT_DIR);
console.log(`      ${(total / 1024 / 1024).toFixed(2)} MB → ${OUT_DIR}`);
rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
