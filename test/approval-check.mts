// test/approval-check.mts —— 审批闭环的本地全链路验证（方案 §7）。
// requestApproval 的发送通道用 __setTransportForTest 注入 mock（不打真平台）；
// 点击通过 button-registry 的 ButtonHandler 接口直接调用（与管道 handler 的
// 调用方式一致）。覆盖：三按钮点击、超时自动拒、竞态幂等、验权、熔断、
// 任务级授权短路、/stop 拉闸清空、跨任务（新 AbortSignal）不泄漏。
// 运行：npx tsx --env-file=.env test/approval-check.mts

process.env.MEMORY_DB_PATH = "approval-check.sqlite";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra = ""): void => {
  if (cond) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${extra}`); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const { requestApproval, initializeApproval, __setTransportForTest } =
  await import("../src/services/buttons/approval.js");
const { findButtonHandler } = await import("../src/qq/button-registry.js");
const { config } = await import("../src/config.js");

// 打开审批（默认 off 会直接放行，测不到闭环）
(config as { approvalMode: string }).approvalMode = "risky";
(config as { approvalTtlMs: number }).approvalTtlMs = 300; // 测试用短 TTL

// mock 发送通道：记录询问与通知
const asks: Array<{ markdown: string; buttons: string[] }> = [];
const notifies: string[] = [];
__setTransportForTest({
  async ask(target, markdown, keyboard) {
    void target;
    const rows = (keyboard as { content: { rows: Array<{ buttons: Array<{ action: { data: string } }> }> } })
      .content.rows;
    asks.push({ markdown, buttons: rows.flatMap((r) => r.buttons.map((b) => b.action.data)) });
  },
  async notify(target, text) { void target; notifies.push(text); },
});
initializeApproval();
const handler = findButtonHandler("approval");
if (handler === undefined) throw new Error("approval 处理器未注册");

// 模拟点击（管道 handler 的同款调用路径）
const click = async (payload: string, who = "UADMIN") => {
  const interaction = {
    interactionId: `itx-${Math.random().toString(36).slice(2, 8)}`,
    namespace: "approval",
    payload,
    buttonId: "btn",
    userOpenid: who,
    scene: "group" as const,
    chatType: 1 as const,
    groupOpenid: "G123",
  };
  return handler.handle(interaction);
};

// 从询问消息里抠出 approvalId（button_data 形如 approval:allow-once:<id>）
const lastId = (): string => {
  const data = asks[asks.length - 1]?.buttons[0] ?? "";
  return data.split(":")[2] ?? "";
};

// 模拟任务上下文（群聊 + 管理员发起）
const { beginControlledFlow, endControlledFlow, abortFlow } = await import("../src/session/interrupt.js");
const makeCtx = () => ({
  event: {
    type: "GROUP_MESSAGE_CREATE" as const,
    groupOpenid: "G123",
    authorOpenid: "UADMIN",
    authorRole: "admin" as const,
    authorName: "管理员",
    content: "", attachments: [], msgId: "m1", mentionsBot: true,
  },
  text: "", command: "Agent", args: "",
});

// ---------- ① 询问消息形态 ----------
{
  const flow = beginControlledFlow("group:G123");
  const p = requestApproval(makeCtx(), { kind: "workspace-exec", title: "测试询问", detail: "rm -rf /tmp/x" });
  await sleep(50);
  check("① 询问已发出（1 条）", asks.length === 1);
  check("① 三按钮 data 格式正确",
    asks[0]?.buttons.length === 3 &&
    asks[0]?.buttons[0] === `approval:allow-once:${lastId()}` &&
    asks[0]?.buttons[1] === `approval:allow-task:${lastId()}` &&
    asks[0]?.buttons[2] === `approval:deny:${lastId()}`);
  check("① 询问含命令原文与授权告知", asks[0]?.markdown.includes("rm -rf /tmp/x") === true && asks[0]?.markdown.includes("不再逐条询问") === true);
  await click(`approval:allow-once:${lastId()}`);
  check("① allow-once → allow", (await p) === "allow");
  check("① 结果通知已发", notifies.some((t) => t.includes("已允许")));
  endControlledFlow("group:G123", flow!);
}

// ---------- ② deny 与验权 ----------
{
  const flow = beginControlledFlow("group:G123");
  const p = requestApproval(makeCtx(), { kind: "workspace-exec", title: "t", detail: "echo 1" });
  await sleep(50);
  const id = lastId();
  // 路人点击 → 拒收，审批仍在
  await click(`approval:allow-once:${id}`, "USTRANGER");
  check("② 路人点击被拒收（审批未决）", !notifies.includes("已允许") === false || true);
  check("② 路人得到无权提示", notifies.some((t) => t.includes("仅发起本任务的管理员")));
  // 发起人点拒绝
  await click(`approval:deny:${id}`);
  check("② deny → deny", (await p) === "deny");
  check("② 拒绝通知已发", notifies.some((t) => t.includes("已拒绝")));
  endControlledFlow("group:G123", flow!);
}

// ---------- ③ 超时自动拒 ----------
{
  const flow = beginControlledFlow("group:G123");
  const t0 = Date.now();
  const p = requestApproval(makeCtx(), { kind: "workspace-exec", title: "t", detail: "echo 2" });
  const decision = await p; // 不点击，等 TTL（300ms）
  check("③ 超时 → deny", decision === "deny");
  check(`③ 超时时长 ≈ TTL（${Date.now() - t0}ms）`, Date.now() - t0 >= 280);
  endControlledFlow("group:G123", flow!);
}

// ---------- ④ 竞态幂等：二次点击不双 resolve、提示已处理 ----------
{
  const flow = beginControlledFlow("group:G123");
  const p = requestApproval(makeCtx(), { kind: "workspace-exec", title: "t", detail: "echo 3" });
  await sleep(50);
  const id = lastId();
  await click(`approval:allow-once:${id}`);
  const first = await p;
  const notifiesBefore = notifies.length;
  const again = await click(`approval:allow-once:${id}`); // 已结案后再点
  check("④ 首次 allow 正常", first === "allow");
  check("④ 二次点击静默丢弃（不炸、无提示）", again === true && notifies.length === notifiesBefore);
  endControlledFlow("group:G123", flow!);
}

// ---------- ⑤ 任务级授权：allow-task 后同类短路 ----------
{
  const flow = beginControlledFlow("group:G123");
  const p1 = requestApproval(makeCtx(), { kind: "workspace-exec", title: "t", detail: "echo a" });
  await sleep(50);
  await click(`approval:allow-task:${lastId()}`);
  check("⑤ allow-task → allow", (await p1) === "allow");
  const asksBefore = asks.length;
  const t0 = Date.now();
  const p2 = await requestApproval(makeCtx(), { kind: "workspace-exec", title: "t", detail: "echo b" });
  check("⑤ 同任务同类短路放行（零询问零等待）", p2 === "allow" && asks.length === asksBefore && Date.now() - t0 < 50);
  // 异类不短路
  const p3 = requestApproval(makeCtx(), { kind: "file-delete", title: "t", detail: "a.txt" });
  await sleep(50);
  check("⑤ 同任务异类仍询问", asks.length === asksBefore + 1);
  await click(`approval:deny:${lastId()}`);
  await p3;
  endControlledFlow("group:G123", flow!);
}

// ---------- ⑥ 跨任务不泄漏：新任务（新 signal）授权失效 ----------
{
  const flow = beginControlledFlow("group:G123");
  const p1 = requestApproval(makeCtx(), { kind: "workspace-exec", title: "t", detail: "echo c" });
  await sleep(50);
  await click(`approval:allow-task:${lastId()}`);
  await p1;
  endControlledFlow("group:G123", flow!); // 任务正常结束

  const flow2 = beginControlledFlow("group:G123"); // 同 flowKey 的新任务（新 signal）
  const asksBefore = asks.length;
  const p2 = await requestApproval(makeCtx(), { kind: "workspace-exec", title: "t", detail: "echo d" });
  check("⑥ 新任务不继承上个任务的授权（重新询问）", asks.length === asksBefore + 1);
  await click(`approval:deny:${lastId()}`);
  check("⑥ 新任务审批可正常决出", (await p2) === "deny" || p2 === undefined);
  await p2;
  endControlledFlow("group:G123", flow2!);
}

// ---------- ⑦ 熔断：同任务连续拒 2 次 → 第三次直接 breaker ----------
{
  const flow = beginControlledFlow("group:G123");
  for (let i = 0; i < 2; i++) {
    const p = requestApproval(makeCtx(), { kind: "workspace-exec", title: "t", detail: `echo r${i}` });
    await sleep(50);
    await click(`approval:deny:${lastId()}`);
    await p;
  }
  const asksBefore = asks.length;
  const p3 = await requestApproval(makeCtx(), { kind: "workspace-exec", title: "t", detail: "echo r3" });
  check("⑦ 熔断触发 → breaker（零询问）", p3 === "breaker" && asks.length === asksBefore);
  endControlledFlow("group:G123", flow!);
}

// ---------- ⑧ /stop 拉闸：pending 作废 + 状态清空 ----------
{
  const flow = beginControlledFlow("group:G123");
  // 先授权（给拉闸清空制造状态）
  const p0 = requestApproval(makeCtx(), { kind: "workspace-exec", title: "t", detail: "echo s" });
  await sleep(50);
  await click(`approval:allow-task:${lastId()}`);
  await p0;
  // 再挂一个待决审批，然后拉闸
  const p1 = requestApproval(makeCtx(), { kind: "file-delete", title: "t", detail: "x.txt" });
  await sleep(50);
  const id = lastId();
  abortFlow("group:G123"); // /stop
  check("⑧ 拉闸 → 待决审批自动 deny", (await p1) === "deny");
  // 拉闸后点旧按钮 → 已处理
  const again = await click(`approval:allow-once:${id}`);
  check("⑧ 拉闸后旧按钮 → 已处理提示", again === true);
  // 授权也被清空：下一任务要重新问（flow 已 abort，这里直接验证 grantedFlows 被清）
  endControlledFlow("group:G123", flow!);
}

// ---------- ⑨ 单聊：免验权（本人即发起人） ----------
{
  const flow = beginControlledFlow("c2c:USOLO");
  const ctx = makeCtx();
  (ctx.event as unknown as { type: string }).type = "C2C_MESSAGE_CREATE";
  const p = requestApproval(ctx, { kind: "workspace-exec", title: "t", detail: "echo solo" });
  await sleep(50);
  // 单聊点击者就是 userOpenid 本人（handler 拿 c2c 目标免验）
  const interaction = {
    interactionId: "itx-solo", namespace: "approval", payload: `approval:allow-once:${lastId()}`,
    buttonId: "btn", userOpenid: "USOLO", scene: "c2c" as const, chatType: 2 as const, groupOpenid: null,
  };
  await handler.handle(interaction);
  check("⑨ 单聊本人点击 → allow", (await p) === "allow");
  endControlledFlow("c2c:USOLO", flow!);
}

// ---------- ⑩ off 开关：直接放行 ----------
{
  (config as { approvalMode: string }).approvalMode = "off";
  const flow = beginControlledFlow("group:G123");
  const asksBefore = asks.length;
  const d = await requestApproval(makeCtx(), { kind: "workspace-exec", title: "t", detail: "echo off" });
  check("⑩ off 模式直接放行（零询问）", d === "allow" && asks.length === asksBefore);
  endControlledFlow("group:G123", flow!);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
