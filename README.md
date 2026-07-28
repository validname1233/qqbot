# qq-bot —— QQ 官方机器人框架

一个用 **TypeScript + Node.js** 写的 QQ 官方机器人。收到 QQ 的 Webhook 事件后，按「事件解析 → 分发 → 编排 → 功能」的分层流水线处理，最终把回复发回 QQ。

内置能力：Ed25519 回调验签、AI 聊天（人设「汐汐」）、状态机小游戏（猜数字）、定时提醒（单聊 / 群聊主动推送）。

核心设计目标是**可扩展**：加一种新事件、一个新命令功能、一个新状态机，都只改极少数几个文件，框架代码（handler / dispatcher / registry）几乎不用动。

---

## 一、整体架构（按数据流分层）

一条消息从进来到回出去，走的是一条单向流水线。下面按「请求流经的顺序」列出各层职责：

```
QQ 服务器
  │  HTTPS POST（回调事件）
  ▼
src/index.ts              启动入口：先跑一次鉴权链路自检（拿 token → 调 /gateway），通过再起服务
src/webhook.ts            HTTP 服务层：node:http 起在 127.0.0.1:3000
  │                         · op 13 → 用 AppSecret 签名回 validation（回调地址校验）
  │                         · op 0  → 用「原始请求体」做 Ed25519 验签，先 ACK(op 12) 再分发
  ▼
src/events/               事件层：把不可信的原始 JSON 规整成强类型「干净事件」
  ├─ raw.ts                 RawEvent：QQ 推来的信封（op / t / d …）
  ├─ definition.ts          EventDefinition<E> 契约：一个事件 = 「对应哪个 t」+「怎么 parse」
  ├─ registry.ts            事件注册表：收集所有 def → 自动推出 BotEvent 联合类型 + parseEvent
  ├─ dispatcher.ts          分发中枢：HandlerMap 查表（编译期强制每种事件都有 handler）
  ├─ C2C_MESSAGE_CREATE/     单聊事件：干净事件 interface + 运行时守卫 + def
  └─ GROUP_AT_MESSAGE_CREATE/ 群@事件：同上
  ▼
src/handlers/             编排层：一种事件一个 handler，只负责「跑命令 + 跑观察者 + 把回复发回」
  ├─ C2C_MESSAGE_CREATE.ts   单聊：并发跑 runCommand / runObservers，逐条被动回复
  └─ GROUP_AT_MESSAGE_CREATE.ts 群@：同上，发回群
  ▼
src/registry.ts           功能注册中心：buildContext（解析命令/参数）+ runCommand + runObservers
  │                         handler 只跟这里打交道，不认识任何具体功能
  ▼
src/session/              会话层：让「多轮对话」成为可能（状态机的锁）
  ├─ store.ts               SessionStore<S>：带类型的 Map<key, S> 封装
  ├─ key.ts                 sessionKey：单聊 c2c:openid / 群聊 group:群:人，粒度到「每人每场景」
  └─ runner.ts              runSession 拦截器：会话锁在某状态机里就接管这条消息，短路普通路由
  ▼
src/machines/             状态机层：多轮交互的纯逻辑（reducer，不碰网络）
  ├─ types.ts               StateMachine<S> / Transition<S> 契约
  └─ guess.ts               猜数字：start（开局建初始状态）+ step（每条消息算「新状态+回什么」）
  ▼
src/services/             功能层：一个功能一个文件
  ├─ chat.ts                聊天（兜底命令）：没带 / 命令时走它
  ├─ reminder.ts            定时任务：/定时任务 秒数 描述，setTimeout 排期 + 到点主动推送
  └─ ai.ts                  调大模型（SiliconFlow），askAI(userText, systemPrompt?)
  ▼
src/qq/                   QQ 通信层
  ├─ auth.ts                access_token 获取 + 缓存
  ├─ api.ts                 通用传输层：apiRequest（鉴权头、错误处理、发任意请求）
  ├─ messages.ts            业务发送层：被动回复 reply* / 主动推送 push*
  └─ crypto.ts              Ed25519：seed 由 AppSecret 重复填充到 32 字节，手拼 PKCS#8 DER
  ▼
src/config.ts             配置：requireEnv / optionalEnv，只从环境变量读，绝不硬编码密钥
src/types.ts              service 层公共契约：MessageContext / CommandService / ObserverService
```

### 两种 service 模型（关键概念）

- **命令型 `CommandService`（router 模型）**：用户用 `/命令` 显式点名才触发，一条消息**最多命中一个**。用 `Map.get()` 精确查表，O(1)，不会误触发。`chat` 是兜底——消息没带 `/` 命令时走它。
- **观察型 `ObserverService`（observer 模型）**：不被点名，**每条消息都跑一遍**（广播）。适合计数、成就、日志。目前列表为空，机制已就位。

两者在 handler 里**并发**跑（`Promise.all`），命令回复排在观察者回复之前。

### 会话锁（模式）如何工作

`runCommand` 会**先问会话层** `runSession(ctx)`：若当前会话正锁在某状态机里（或这条正是开局命令），由状态机接管并直接返回，不再走普通命令路由。会话键的粒度是「每人每场景」——**同一个用户在单聊和群聊里是两把独立的锁**，互不干扰。

---

## 二、如何扩展

框架把「加东西」都收敛成了改极少数文件。下面分三类给出步骤。

### 1. 加一个新命令功能（CommandService）—— 最常见

只新建一个文件，再在注册表登记一行。

**① 在 `src/services/` 下新建文件**，实现 `CommandService`：

```typescript
// src/services/echo.ts
import type { CommandService, MessageContext } from "../types.js";

export const echoService: CommandService = {
  name: "复读",              // 命令关键词，也是注册表里的键：/复读 xxx
  aliases: ["echo"],        // 选填别名：/echo xxx 等效
  async handle(ctx: MessageContext): Promise<string | null> {
    if (ctx.args.trim() === "") return "复读点啥？在后面写上内容～";
    return ctx.args;         // 返回要回复的话；返回 null 表示这次不回
  },
};
```

`ctx` 里能拿到什么：`ctx.text`（完整内容）、`ctx.command`（命令词）、`ctx.args`（命令后面的部分）、`ctx.event`（原始强类型事件，要 openid / msgId / 判断单聊还是群聊时从这里取）。

**② 在 `src/registry.ts` 登记**（import 一行 + register 一行）：

```typescript
import { echoService } from "./services/echo.js";
// …
registerCommand(echoService);
```

完成。handler、dispatcher 一行都不用动。

> **场景限制**：若功能只想在单聊或群聊生效，在 `handle` 里用 `ctx.event.type` 判别即可。参考 `reminder.ts` 的写法——**每种已知事件各写一个 `if` 分支，其余显式返回「不支持」**，不要用「不是群聊就默认当单聊」的兜底 `else`（将来多一种事件会被误当单聊，埋隐性 bug）。

### 2. 加一个新状态机（多轮交互 / 小游戏）

**① 在 `src/machines/` 下新建文件**，实现 `StateMachine<S>`：

- `start(ctx)`：开局时调一次，建初始状态，返回 `{ nextState, reply }`。
- `step(state, ctx)`：会话锁定后每条消息调一次，是个**纯 reducer**——只算「新状态 + 回什么话」，不发消息、不碰网络。
- `nextState` 返回 `null` 表示**会话结束**（解锁）；非 null 则更新并保持锁定。

可直接照抄 `machines/guess.ts` 的骨架。

**② 在 `src/session/runner.ts` 的 `machines` 数组加一项**（并 import）：

```typescript
import { yourMachine } from "../machines/your.js";
const machines: StateMachine<unknown>[] = [
  guessMachine as StateMachine<unknown>,
  yourMachine as StateMachine<unknown>,   // ← 加这行
];
```

状态机的 `name` 就是它的**开局命令关键词**（如 `/猜数字`）。其余不用动。

### 3. 加一种新事件（QQ 推来的新事件类型）

比如要支持频道消息、群文件事件等。按约定，一种事件的「全部知识」集中在 `src/events/<事件名>/index.ts` 一个文件里。

**① 新建 `src/events/YOUR_EVENT/index.ts`**，写三样东西（照抄 `C2C_MESSAGE_CREATE/index.ts`）：

- 干净事件 `interface`（必须带 `type: "YOUR_EVENT"` 判别式标签）；
- 运行时守卫函数（网络来的 `d` 是 `unknown`，逐字段验过才可信）；
- `EventDefinition`（`t` + `parse`）。

**② 在 `src/events/registry.ts` 登记**（import 一行 + `eventDefs` 加一项）：

```typescript
import { yourEventDef } from "./YOUR_EVENT/index.js";
export const eventDefs = [c2cMessageDef, groupAtMessageDef, yourEventDef] as const;
```

`BotEvent` 联合会**自动**包含新事件。

**③ 写 handler `src/handlers/YOUR_EVENT.ts`**，签名统一为 `handleXxx(event): Promise<void>`（照抄 `handlers/C2C_MESSAGE_CREATE.ts`：`buildContext` → 并发 `runCommand`/`runObservers` → 发回）。

**④ 在 `src/events/dispatcher.ts` 的 `handlers` 表补一项**：

```typescript
const handlers: HandlerMap = {
  C2C_MESSAGE_CREATE: handleC2CMessage,
  GROUP_AT_MESSAGE_CREATE: handleGroupAtMessage,
  YOUR_EVENT: handleYourEvent,   // ← 漏了这行会「编译期报错」，不是等运行时才发现
};
```

> `HandlerMap` 用类型强制「每种事件都必须配 handler」——这是刻意的**编译期穷尽检查**：登记了事件却忘了配 handler，`tsc` 直接报错。

### 加观察型服务（每条消息都跑）

实现 `ObserverService`（`observe(ctx)`，想说话返回文本、否则 `null`），在 `src/registry.ts` 的 `observers` 数组 `push` 进去即可。每个观察者独立兜错，一个崩了不连累其它。

---

## 三、部署与环境

### 运行环境

- **Node.js**：建议 Node 24（`.nvmrc` 若有以其为准）。
- 直接用 **tsx** 跑 TypeScript 源码，不预编译（`tsconfig.json` 为 `noEmit`，仅做类型检查）。
- 模块系统：ES2022 + NodeNext + `strict`。注意相对 import **必须带 `.js` 后缀**（NodeNext 规则）。

### 环境变量（`.env`）

密钥**只从环境变量读，绝不硬编码或提交**。`.env` 已在 `.gitignore` 中（不被 git 跟踪，`git reset --hard` 只动被跟踪文件，故本地 `.env` 安全）。

复制模板并填写：

```bash
cp .env.example .env
```

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `QQ_BOT_APP_ID` | 是 | QQ 机器人 AppID |
| `QQ_BOT_APP_SECRET` | 是 | AppSecret，用于取 token 和回调验签；**泄露 = 别人能冒充你的机器人** |
| `AI_API_KEY` | 是 | SiliconFlow 大模型 API Key |
| `AI_MODEL` | 否 | 模型名，不填走代码里的默认值 |

### 常用脚本（`package.json`）

```bash
npm install        # 安装依赖
npm run dev        # 本地跑入口（含启动自检）
npm run webhook    # 启动 Webhook 服务
npm run typecheck  # tsc --noEmit 全量类型检查（提交前必跑）
```

### 线上部署（反代 + 进程守护 + 自动部署）

- **nginx** 负责 HTTPS 卸载（QQ 要求回调地址是 HTTPS），反代到本机 `http://127.0.0.1:3000`。服务本身只监听 `127.0.0.1`，不直接对公网暴露。
- **pm2** 做进程守护（崩溃自动重启、开机自启）。
  > 注意：定时提醒用的是**内存里的 `setTimeout`**，进程重启后未到点的提醒会丢失（这是可靠性取舍，不是性能问题）。
- **GitHub Actions**：push 到 `main` 触发 —— 先 `npm ci` + `npm run typecheck`，通过后 SSH 到服务器 `git reset --hard` + `npm install` + `pm2 restart`。改依赖或脚本时记得同步更新 workflow。

### 回调验签（安全要点）

- QQ 的 **op 0 事件必须做 Ed25519 验签**，验签用的是**原始请求体**（不能重新序列化 JSON——字段顺序/空格变了签名就对不上）。
- op 13 是回调地址校验，用 AppSecret 签名回 `validation`。
- 验签细节见 `src/qq/crypto.ts`：seed 由 AppSecret 重复填充到 32 字节，Node 里需手拼 PKCS#8 DER 前缀。
