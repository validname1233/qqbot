// test/button-callback-check.mts —— 回调按钮管道的本地全链路验证（方案 §6）。
// 模拟 QQ 推 INTERACTION_CREATE 事件：parseEvent 解析 → dispatch 分流（不进
// transcript）→ 管道 handler（先回应后分发）→ 自注册的测试处理器。
// ESM 命名空间只读（不可 monkey-patch），故不用 demo 处理器真推消息——
// 注册一个 testui 命名空间的处理器记录点击，验证路由与去重语义。
// 运行：npx tsx --env-file=.env test/button-callback-check.mts

process.env.MEMORY_DB_PATH = "button-check.sqlite";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra = ""): void => {
  if (cond) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${extra}`); }
};

const { registerButtonHandler, toButtonInteraction } = await import("../src/qq/button-registry.js");
const { parseEvent } = await import("../src/events/registry.js");
const { dispatch } = await import("../src/events/dispatcher.js");
const { callbackButton } = await import("../src/qq/keyboard.js");

// 测试处理器：记录收到的交互现场（不发消息，无外部副作用）
const received: Array<{ ns: string; payload: string; who: string; group: string | null }> = [];
registerButtonHandler("testui", {
  async handle(interaction) {
    received.push({
      ns: interaction.namespace,
      payload: interaction.payload,
      who: interaction.userOpenid,
      group: interaction.groupOpenid,
    });
    return true;
  },
});

// 事件构造（信封形状与真机一致）
const makeRaw = (buttonData: string, id = "itx-1", userOpenid = "Uclicker123") => ({
  op: 0,
  id,
  t: "INTERACTION_CREATE",
  d: {
    type: 11,
    scene: "group",
    chat_type: 1,
    group_openid: "G123",
    user_openid: userOpenid,
    data: { resolved: { button_data: buttonData } },
    button_id: "btn1",
  },
});
const fire = async (buttonData: string, id: string): Promise<void> => {
  const ev = parseEvent(makeRaw(buttonData, id) as never);
  if (ev === null) throw new Error(`事件解析失败：${buttonData}`);
  await dispatch(ev);
  await new Promise((r) => setTimeout(r, 150)); // 等 handler 的异步链落地
};

// ---------- ① 解析 ----------
{
  const ev = parseEvent(makeRaw("testui:hello") as never);
  check("① 合法事件解析成功", ev !== null && ev.type === "INTERACTION_CREATE");
  if (ev?.type === "INTERACTION_CREATE") {
    check("① 字段正确（id/data/user/scene/group）",
      ev.interactionId === "itx-1" && ev.buttonData === "testui:hello" &&
      ev.userOpenid === "Uclicker123" && ev.scene === "group" && ev.groupOpenid === "G123" &&
      ev.chatType === 1 && ev.buttonId === "btn1");
  }
}

// ---------- ② 解析防御 ----------
{
  const base = makeRaw("testui:x");
  const bad1 = { ...base, d: { ...base.d, data: {} } }; // resolved 缺失
  check("② resolved 缺失 → null", parseEvent(bad1 as never) === null);
  const bad2 = { ...base, d: { ...base.d, type: 12 } }; // 非按钮回调
  check("② type≠11 → null", parseEvent(bad2 as never) === null);
  check("② 无外层 id → null", parseEvent(({ ...base, id: undefined }) as never) === null);
}

// ---------- ③ 全链路路由 ----------
{
  await fire("testui:hello", "itx-1");
  check("③ 点击路由到处理器", received.length === 1);
  check("③ 现场正确（ns/payload/who/group）",
    received[0]?.ns === "testui" && received[0]?.payload === "hello" &&
    received[0]?.who === "Uclicker123" && received[0]?.group === "G123");
}

// ---------- ④ 重推去重 ----------
{
  await fire("testui:hello", "itx-1"); // 同 interactionId 重推
  check("④ 同 id 重推被吞", received.length === 1);
  await fire("testui:again", "itx-2"); // 新点击 = 新 id
  check("④ 新 id 正常处理", received.length === 2 && received[1]?.payload === "again");
}

// ---------- ⑤ 坏路由不炸管道 ----------
{
  await fire("nosuch:xyz", "itx-3"); // 未注册命名空间
  await fire("nodivider", "itx-4"); // 无冒号
  await fire("testui:final", "itx-5");
  check("⑤ 坏 data 后管道照常路由", received.length === 3 && received[2]?.payload === "final");
}

// ---------- ⑥ callbackButton 构造校验（源头拦坏格式） ----------
{
  const ok = callbackButton("b1", "允许", "testui:allow:1");
  check("⑥ 合法 data 构造成功（type=1）", ok.action.type === 1 && ok.action.data === "testui:allow:1");
  let threw = false;
  try { callbackButton("b2", "允许", "no-dividend"); } catch { threw = true; }
  check("⑥ 无冒号 data 构造抛错", threw);
  threw = false;
  try { callbackButton("b3", "允许", "BadNs:x"); } catch { threw = true; }
  check("⑥ 大写 ns 构造抛错", threw);
  threw = false;
  try { callbackButton("b4", "这是一个超长标签超过十个字", "testui:x"); } catch { threw = true; }
  check("⑥ 超 10 字 label 构造抛错", threw);
}

// ---------- ⑦ interaction 不进 transcript（dispatcher 分流验证） ----------
{
  const { chatRowsAll } = await import("../src/agent/memory/events.js");
  // 本测试进程内 dispatch 过若干 interaction；transcript 里不应有对应行
  //（chat_user 行只来自消息事件——本测试没发过消息，表应为空或不含按钮数据）
  const rows = chatRowsAll("group:G123");
  check("⑦ 按钮点击不进 transcript", rows.every((r) => !(r.content ?? "").includes("testui")));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
