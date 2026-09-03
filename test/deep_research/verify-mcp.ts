// test/deep_research/verify-mcp.ts —— MCP 层端到端验证。
// 用 SDK 服务端在本机起一个模拟 MCP 服务器（测试工具 echo），然后走真实的
// initializeMcpTools 吸收 + runTool 调用 + 适配器加工全链路。
// 用法：npx tsx --env-file=.env test/deep_research/verify-mcp.ts
// 注意：env 覆盖必须在任何 src import 之前执行（ESM 静态 import 会提升），
// 所以这里用"先设 env → 再动态 import"的两段式，覆盖 MCP_SERVERS/MCP_EXPOSE。

process.env.MCP_SERVERS = "mock=http://127.0.0.1:3789/mcp";
process.env.MCP_EXPOSE = "mock:*";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name} ${detail}`);
  }
}

// ---- 1. 模拟 MCP 服务器（SDK 服务端 + Streamable HTTP）----
const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { createServer } = await import("node:http");
const { z } = await import("zod");

const mcp = new McpServer({ name: "mock", version: "1.0" });
mcp.tool("echo", "回显输入的文本", { text: z.string() }, async ({ text }) => ({
  content: [{ type: "text", text: `echo: ${text}` }],
}));

const httpServer = createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/mcp") {
    // 无状态模式：每个请求独立 transport（不设 sessionIdGenerator），
    // enableJsonResponse 单次 JSON 往返——SDK 服务端的最简合法形态
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    res.on("close", () => transport.close());
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
    return;
  }
  res.writeHead(404).end();
});

await new Promise<void>((resolve) => httpServer.listen(3789, "127.0.0.1", resolve));
console.log("[verify-mcp] 模拟服务器已监听 127.0.0.1:3789");

// ---- 2. 吸收：env 已就位，安全 import 业务模块 ----
console.log("[verify-mcp] 2. 启动吸收");
await import("../../src/services/agent.js");          // 先触发原生工具注册
const { initializeMcpTools } = await import("../../src/agent/mcp/initialize.js");
const { toolSchemas, runTool } = await import("../../src/agent/registry.js");
const { registerMcpAdapter } = await import("../../src/agent/mcp/adapters.js");
const { disconnectAll } = await import("../../src/agent/mcp/client.js");
const { sessionKey } = await import("../../src/session/key.js");
const crypto2 = await import("node:crypto");
void crypto2;

await initializeMcpTools();

const names = toolSchemas().map((t) => t.function.name);
console.log(`  工具表: ${names.join(", ")}`);
check("echo 被吸收（mcp_mock_echo）", names.includes("mcp_mock_echo"));
check("原生工具未受影响", names.includes("open_page") && names.includes("search"));

// ---- 3. 真实调用：runTool 分发 → tools/call → 拍扁 ----
console.log("[verify-mcp] 3. 真实调用");
const mockEvent = {
  type: "C2C_MESSAGE_CREATE",
  authorOpenid: "mcp-test",
  authorName: "测试",
} as never;
const ctx = { command: null, text: "", args: "", event: mockEvent } as Parameters<typeof runTool>[2];
void sessionKey;

const echoed = await runTool("mcp_mock_echo", { text: "hello mcp" }, ctx);
check("echo 调用返回回显", echoed === "echo: hello mcp", `got: ${echoed}`);

// ---- 4. 适配器：注册加工器，验证 identity 被覆盖 ----
console.log("[verify-mcp] 4. 适配器加工");
registerMcpAdapter("mock:echo", async (raw) => `[加工过的] ${raw.toUpperCase()}`);
const adapted = await runTool("mcp_mock_echo", { text: "adapter test" }, ctx);
check("适配器生效", adapted === "[加工过的] ECHO: ADAPTER TEST", `got: ${adapted}`);

// ---- 5. 深检注册表未被污染 ----
const { toolSchemas: deepSchemas } = await import("../../src/agent/deep-search/registry.js");
const deepNames = deepSchemas().map((t) => t.function.name);
check("深检工具表未混入 MCP 工具", !deepNames.some((n) => n.startsWith("mcp_")));

await disconnectAll();
httpServer.close();
console.log(failures === 0 ? "\n[verify-mcp] 全部通过 ✓" : `\n[verify-mcp] ${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);
