// test/workspace-ui-check.mts —— 工作台 UI 路由的端到端验证（方案 §9 清单）。
// 直接把 handleWorkspaceUi 挂在一个临时 HTTP server 上，真发请求验证：
// token 验证矩阵、页面/静态资源、路径穿越拒绝、mtime 乐观锁、CRUD 全链路。
// 运行：npx tsx --env-file=.env test/workspace-ui-check.mts
//（.env 提供 QQ/AI 凭据使 config 可加载；工作台根与库文件在脚本内指到临时目录）

process.env.WORKSPACE_ROOT = process.env.WORKSPACE_ROOT_OVERRIDE ?? "data/test-wsui-root";
process.env.MEMORY_DB_PATH = "wsui-check.sqlite";

const { createServer } = await import("node:http");
const { handleWorkspaceUi } = await import("../src/services/workspace-ui/http.js");
const { issueToken, revokeToken } = await import("../src/services/workspace-ui/tokens.js");
const { rmSync, symlinkSync, mkdirSync, writeFileSync } = await import("node:fs");

const SCOPE = "group:wsui-check";
const TOKEN = issueToken(SCOPE);

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra = ""): void => {
  if (cond) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${extra}`); }
};

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (url.pathname.startsWith("/ws/")) {
    handleWorkspaceUi(req, res, url);
    return;
  }
  res.writeHead(404).end();
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

async function call(path: string, init: RequestInit = {}): Promise<{ status: number; body: any; text: string }> {
  const res = await fetch(`${BASE}${path}`, init);
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { /* html/js 等非 JSON */ }
  return { status: res.status, body, text };
}
const bearer = (path: string, init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: { Authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
});

// ---------- 页面与静态资源 ----------
{
  const page = await call(`/ws/${TOKEN}`);
  check("页面路由 200 且为 index.html", page.status === 200 && page.text.includes("<title>工作台</title>"));

  const appjs = await call("/ws/static/app.js");
  check("静态资源 app.js 200", appjs.status === 200 && appjs.text.includes("monaco"));

  const loader = await call("/ws/static/monaco/vs/loader.js");
  check("Monaco loader.js 200（嵌套静态路径）", loader.status === 200 && loader.text.includes("MIT"));

  const evil = await call("/ws/static/..%2f..%2f..%2ftokens.ts");
  check("静态资源目录穿越被拒", evil.status === 404 || evil.status === 400, `status=${evil.status}`);
}

// ---------- token 验证矩阵 ----------
{
  const noTok = await call("/ws/api/list");
  check("无 token → 401", noTok.status === 401);

  const badTok = await call("/ws/api/list", { headers: { Authorization: "Bearer A".padEnd(39, "x") } });
  check("伪造 token → 401", badTok.status === 401);

  const pathForm = await call(`/ws/${TOKEN}/api/list`);
  check("路径 token 形式 → 200（空目录）", pathForm.status === 200 && Array.isArray(pathForm.body?.entries));

  const ok = await call("/ws/api/list", bearer("/ws/api/list"));
  check("Bearer 形式 → 200", ok.status === 200);
}

// ---------- CRUD + mtime 乐观锁 ----------
{
  const put = await call("/ws/api/file", bearer("/ws/api/file", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "hello.py", content: "print('hi')", baseMtimeMs: null }),
  }));
  check("新建文件 PUT → 200 带 mtimeMs", put.status === 200 && typeof put.body?.mtimeMs === "number");

  const read = await call(`/ws/api/file?path=${encodeURIComponent("hello.py")}`, bearer(""));
  check("读回内容一致", read.status === 200 && read.body?.content === "print('hi')");

  const stale = await call("/ws/api/file", bearer("/ws/api/file", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "hello.py", content: "print('changed')", baseMtimeMs: (put.body.mtimeMs as number) - 5000 }),
  }));
  check("旧 mtime 保存 → 409", stale.status === 409);

  const fresh = await call("/ws/api/file", bearer("/ws/api/file", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "hello.py", content: "print('v2')", baseMtimeMs: put.body.mtimeMs }),
  }));
  check("正确 mtime 保存 → 200", fresh.status === 200);

  const mkdir = await call("/ws/api/dir", bearer("/ws/api/dir", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: "notes" }),
  }));
  check("新建目录 → 200", mkdir.status === 200);

  const list = await call("/ws/api/list", bearer("/ws/api/list"));
  const names = (list.body?.entries ?? []).map((e: any) => e.name);
  check("列表含文件与目录（目录排前）", names.join(",") === "notes,hello.py", `got ${names}`);

  const ren = await call("/ws/api/rename", bearer("/ws/api/rename", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from: "hello.py", to: "notes/hi.py" }),
  }));
  check("重命名/移动 → 200", ren.status === 200);

  const del = await call(`/ws/api/file?path=${encodeURIComponent("notes")}`, bearer("", { method: "DELETE" }));
  check("递归删除目录 → 200", del.status === 200);
}

// ---------- 路径穿越与逃逸 ----------
{
  const up = await call(`/ws/api/file?path=${encodeURIComponent("../secret.txt")}`, bearer(""));
  check("../ 穿越 → 400", up.status === 400);

  const abs = await call(`/ws/api/file?path=${encodeURIComponent("/etc/passwd")}`, bearer(""));
  check("绝对路径 → 400", abs.status === 400);

  // 符号链接逃逸（Windows 无特权建链失败则跳过）
  try {
    const { workspaceDirForKey } = await import("../src/services/workspace/paths.js");
    const root = workspaceDirForKey(SCOPE);
    writeFileSync(`${root}.outside-secret.txt`, "secret");
    symlinkSync(`${root}.outside-secret.txt`, `${root}/leak.txt`);
    const leak = await call(`/ws/api/file?path=${encodeURIComponent("leak.txt")}`, bearer(""));
    check("symlink 指外 → 400（读方向）", leak.status === 400, `status=${leak.status}`);
    const wlink = await call("/ws/api/file", bearer("/ws/api/file", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "leak.txt", content: "x", baseMtimeMs: null }),
    }));
    check("symlink 指外 → 400（写方向）", wlink.status === 400, `status=${wlink.status}`);
  } catch (e) {
    console.log(`⏭️ symlink 测试跳过（本机无法创建符号链接：${e instanceof Error ? e.message : e}）`);
  }
}

// ---------- 吊销 ----------
{
  const t2 = issueToken("group:wsui-check-2");
  const before = await call(`/ws/${t2}/api/list`);
  revokeToken(t2);
  const after = await call(`/ws/${t2}/api/list`);
  check("吊销后 → 401", before.status === 200 && after.status === 401);
}

server.close();

// 清理：临时 workspace 根 + 临时库。sqlite 连接在进程内仍开着，Windows 下
// 文件被锁删不掉——尽力而为（残留的 data/wsui-check.sqlite 可手动删）。
rmSync(process.env.WORKSPACE_ROOT!, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
try {
  rmSync("data/wsui-check.sqlite", { force: true, maxRetries: 10, retryDelay: 150 });
} catch {
  console.log("⏭️ 临时库文件被进程占用未删（data/wsui-check.sqlite，可手动清理）");
}
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
