# Agent 工具调用与参数准确率评测

目录内容（配套 [方案.md](./方案.md)）：

| 文件 | 作用 |
| --- | --- |
| `cases.json` | 104 条人工审核的测试用例（金标），字段说明见方案 §4.2 |
| `e2e.ts` | 端到端评测脚本：复用生产 `runAgentTurn` 原始链路 |
| `score.ts` | 评分器（纯函数）：路径匹配、参数规则、指标汇总 |
| `reports/` | 每次评测输出的轨迹（JSONL）与汇总报告（Markdown） |

## 运行

在项目根目录执行：

```bash
# 1. 类型检查（脚本本身也被 tsconfig 覆盖）
npm run typecheck

# 2. mock 自检：固定模型响应跑生产 Runtime，验证捕获/路由/评分器，无网络、无费用
npx tsx test/agent_tool_accuracy/e2e.ts --mode mock

# 3. live 冒烟：真实模型，先跑 5 条检查轨迹与费用
npx tsx --env-file=.env test/agent_tool_accuracy/e2e.ts --mode live --limit 5

# 4. 完整评测：全部用例每条重复 3 次
npx tsx --env-file=.env test/agent_tool_accuracy/e2e.ts --mode live --repeat 3
```

常用参数：

| 参数 | 说明 |
| --- | --- |
| `--mode mock\|live` | mock = 固定响应自检（默认）；live = 真实模型评测 |
| `--case <id>` | 只跑指定用例（可重复传，如 `--case search-001 --case get-time-003`） |
| `--category <name>` | 只跑指定类别（如 `two_turn`、`hidden_param`） |
| `--limit <n>` | 只跑前 n 条（冒烟用） |
| `--repeat <n>` | 每条用例重复次数（默认 1，完整评测建议 3） |
| `--judge off` | 关闭 semantic 判官（相关断言记为「未定」） |

## 工作原理

脚本**不改任何生产代码**，通过三个无侵入切面复用原始链路：

1. **fetch 拦截**（生产模块加载前安装）：`callModel` 的 DeepSeek 请求在 HTTP 边界被旁路记录——请求（带了哪些工具 schema、消息规模）与响应（原始 `tool_calls`，`arguments` 保持字符串原样）。live 模式原样透传，不修改模型输入输出；mock 模式按队列返回脚本化响应。
2. **工具替身**：8 个原生工具以**同名、同描述、同参数 schema** 重新注册（`registerTool` 覆盖），仅替换 `run`——记录注入器处理后的最终执行参数，返回 `cases.json` 配置的固定 `toolResults`。模型看到的工具表与生产完全一致。
3. **轮次归属**：每收到一个带 `tools` 的模型请求即一轮 llmCall（对齐 `MAX_TOOL_TURNS=2`），替身执行时读取当前轮次，从而把「模型原始参数」与「第几轮执行」对上。

## 隔离与安全

- **长期记忆**：`MEMORY_DB_PATH=agent-eval-test.sqlite` 独立文件，与生产库完全隔离，可随时删除。
- **短期记忆**：`sqlite.ts` 库路径写死为生产 `data/memory.sqlite`，无法用环境变量覆盖——脚本采用**键级隔离**：每次运行用唯一假身份（`eval-<caseId>-<repeat>-<随机串>`），与真实用户键永不碰撞，运行结束 `clear(key)` 清掉本次写入（含 historySeed）。评测不会读写任何真实用户的记忆。
- **无外部副作用**：不启动 webhook；`set_reminder` 不排期、不推送 QQ；`add_memory`/`delete_memory` 不落长期库；`search`/`open_page` 不发起真实网络请求；MCP 层整体不启用（`MCP_CONFIG_PATH` 指向不存在的文件）。mock 模式下任何非 DeepSeek 外呼直接抛错，自检会立刻暴露。
- **凭据**：mock 模式自动注入 dummy 值，不需要 `.env`；live 模式必须 `--env-file=.env` 提供真实 `AI_API_KEY`。报告只记录消息预览与工具名，不落 API key。

## 指标口径（与方案 §7 一致）

| 指标 | 分子 / 分母 |
| --- | --- |
| 工具选择准确率 | 调用路径符合金标的有效运行 / 有效运行总数（含正确不调用） |
| 调用 precision / recall（诊断口径） | 与金标配对成功的调用 / 生成调用总数（期望调用总数） |
| 误调用率 | 不应调用却生成了调用的运行 / 不应调用的运行 |
| 原始 JSON 合法率 | arguments 可解析的生成调用 / 生成调用总数 |
| schema 合规率 | 满足生产 schema 的生成调用 / 生成调用总数（未知工具、多余字段均不合规） |
| 参数字段准确率 | 通过的断言 / 已判定断言（semantic 未判的不进分母） |
| 整调用参数准确率 | 全部断言通过的配对调用 / 可判定的配对调用 |
| 联合成功率 | 选择与参数全对的运行 / 可判定运行 |

关键口径：参数规则只作用于**与金标配对成功**的调用（选错工具时参数记「未定」而非硬凑分母）；`forbidden`/`empty_params` 作用于该工具的**全部生成调用**；JSON 解析失败即使 Runtime 回退 `{}` 后执行成功也判错。semantic 断言（如 query 措辞、description 转述）由判官模型批量裁决（`--judge off` 可关），单条判官失败只影响该断言记「未定」。

## 已知边界

- **短期记忆写入生产库文件**：键级隔离 + 运行后清理已消除数据交叉，但评测期间 `data/memory.sqlite` 文件里会短暂存在测试行（假身份键）。介意可用备份恢复，或等生产侧把短期库路径也接到 `MEMORY_DB_PATH`（一行改动，属生产代码调整，不在本评测范围内）。
- **语义判官自身是模型**：judge 结论有噪声；争议样本看 `trajectory.jsonl` 里的原始生成值人工复核。
- **费用**：live 模式每次运行含 2~4 次模型调用（llmCall 1~2 次 + plainReply/finalize 1 次），开 judge 再加 1 次/用例。104 条 × 3 次约 600~1200 次调用，建议先 `--limit 5` 估算。
