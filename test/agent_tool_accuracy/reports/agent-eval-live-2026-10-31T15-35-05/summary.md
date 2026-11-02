# Agent 工具调用准确率评测报告

- 模式：live（模型：见 .env）
- 时间：2026-10-31T15-35-05
- semantic 判官：模型 judge
- 运行总数：270，有效：270，基础设施失败：0

## 指标总览

| 指标 | 分子/分母 | 值 |
| --- | --- | --- |
| 工具选择准确率 | 268/270 | 99.3% |
| 调用 precision（诊断口径） | 259/304 | 85.2% |
| 调用 recall（诊断口径） | 259/261 | 99.2% |
| 原始 JSON 合法率 | 304/304 | 100.0% |
| schema 合规率 | 304/304 | 100.0% |
| 参数字段准确率 | 288/294 | 98.0% |
| 整调用参数准确率 | 190/196 | 96.9% |
| 联合成功率 | 189/196 | 96.4% |
| 误调用率（不应调用的运行中生成了调用） | 0/57 | 0.0% |

未定（semantic 待判/无配对调用）：字段 96 项，整调用 74 次，联合 74 次。

## 分类统计

| 类别 | 运行 | 选择通过 | 联合通过 | 联合未定 |
| --- | --- | --- | --- | --- |
| no_tool | 45 | 45 | 45 | 0 |
| get_time | 24 | 24 | 24 | 0 |
| search | 36 | 36 | 9 | 26 |
| open_page | 24 | 24 | 18 | 5 |
| set_reminder | 36 | 35 | 9 | 24 |
| recall_memory | 18 | 18 | 18 | 0 |
| multi_tool | 18 | 18 | 13 | 5 |
| two_turn | 24 | 23 | 19 | 3 |
| context | 18 | 18 | 14 | 4 |
| hidden_param | 12 | 12 | 10 | 2 |
| deep_search | 15 | 15 | 10 | 5 |

## 失败与未定样例（8 条）

### search-011 (repeat 3)
- 参数不符 [search.search_depth optional_omitted_or_enum]：可选字段取值 "advanced" 不在 ["basic"] 内（生成值 "advanced"）

### open-page-007 (repeat 2)
- 参数不符 [search.max_results optional_omitted_or_enum]：可选字段取值 8 不在 [3,5,10] 内（生成值 8）

### set-reminder-006 (repeat 3)
- 工具选择不符：命中 path=null，生成 0 个调用（期望 1，诊断匹配 0）

### set-reminder-008 (repeat 1)
- 参数不符 [set_reminder.seconds exact]：期望 10800，实际 9000（生成值 9000）

### set-reminder-008 (repeat 2)
- 参数不符 [set_reminder.seconds exact]：期望 10800，实际 9000（生成值 9000）

### set-reminder-008 (repeat 3)
- 参数不符 [set_reminder.seconds exact]：期望 10800，实际 7200（生成值 7200）

### two-turn-005 (repeat 2)
- 参数不符 [open_page.link exact]：期望 1，实际 undefined（生成值 null）

### two-turn-008 (repeat 2)
- 工具选择不符：命中 path=null，生成 2 个调用（期望 2，诊断匹配 1）
