# Agent 工具调用准确率评测报告

- 模式：live（模型：见 .env）
- 时间：2026-10-13T06:09:06.120Z
- semantic 判官：模型 judge
- 运行总数：312，有效：312，基础设施失败：0

## 指标总览

| 指标 | 分子/分母 | 值 |
| --- | --- | --- |
| 工具选择准确率 | 293/312 | 93.9% |
| 调用 precision（诊断口径） | 286/347 | 82.4% |
| 调用 recall（诊断口径） | 286/303 | 94.4% |
| 原始 JSON 合法率 | 347/347 | 100.0% |
| schema 合规率 | 347/347 | 100.0% |
| 参数字段准确率 | 364/369 | 98.6% |
| 整调用参数准确率 | 223/228 | 97.8% |
| 联合成功率 | 217/228 | 95.2% |
| 误调用率（不应调用的运行中生成了调用） | 4/54 | 7.4% |

未定（semantic 待判/无配对调用）：字段 114 项，整调用 84 次，联合 84 次。

## 分类统计

| 类别 | 运行 | 选择通过 | 联合通过 | 联合未定 |
| --- | --- | --- | --- | --- |
| no_tool | 45 | 44 | 44 | 0 |
| get_time | 24 | 24 | 24 | 0 |
| search | 36 | 35 | 18 | 17 |
| open_page | 24 | 21 | 18 | 6 |
| set_reminder | 36 | 32 | 19 | 11 |
| add_memory | 24 | 24 | 8 | 16 |
| delete_memory | 18 | 17 | 9 | 9 |
| clear_all_memories | 15 | 12 | 10 | 5 |
| recall_memory | 18 | 18 | 12 | 6 |
| multi_tool | 18 | 15 | 11 | 7 |
| two_turn | 24 | 21 | 18 | 3 |
| context | 18 | 18 | 15 | 3 |
| hidden_param | 12 | 12 | 11 | 1 |

## 失败与未定样例（23 条）

### no-tool-003 (repeat 2)
- 工具选择不符：命中 path=null，生成 1 个调用（期望 0，诊断匹配 0）

### search-005 (repeat 2)
- 工具选择不符：命中 path=null，生成 2 个调用（期望 1，诊断匹配 0）

### search-008 (repeat 1)
- 参数不符 [search.max_results optional_omitted_or_enum]：可选字段取值 8 不在 [3,5,10] 内（生成值 8）

### open-page-008 (repeat 1)
- 工具选择不符：命中 path=null，生成 1 个调用（期望 1，诊断匹配 0）

### open-page-008 (repeat 2)
- 工具选择不符：命中 path=null，生成 1 个调用（期望 1，诊断匹配 0）

### open-page-008 (repeat 3)
- 工具选择不符：命中 path=null，生成 1 个调用（期望 1，诊断匹配 0）

### set-reminder-007 (repeat 1)
- 工具选择不符：命中 path=null，生成 1 个调用（期望 2，诊断匹配 0）

### set-reminder-008 (repeat 1)
- 参数不符 [set_reminder.seconds exact]：期望 10800，实际 7200（生成值 7200）

### set-reminder-008 (repeat 2)
- 参数不符 [set_reminder.seconds exact]：期望 10800，实际 7200（生成值 7200）

### set-reminder-008 (repeat 3)
- 参数不符 [set_reminder.seconds exact]：期望 10800，实际 7200（生成值 7200）

### set-reminder-012 (repeat 1)
- 工具选择不符：命中 path=null，生成 1 个调用（期望 0，诊断匹配 0）

### set-reminder-012 (repeat 2)
- 工具选择不符：命中 path=null，生成 1 个调用（期望 0，诊断匹配 0）

### set-reminder-012 (repeat 3)
- 工具选择不符：命中 path=null，生成 1 个调用（期望 0，诊断匹配 0）

### delete-memory-004 (repeat 1)
- 工具选择不符：命中 path=null，生成 1 个调用（期望 1，诊断匹配 0）

### clear-all-005 (repeat 1)
- 工具选择不符：命中 path=null，生成 1 个调用（期望 1，诊断匹配 0）

### clear-all-005 (repeat 2)
- 工具选择不符：命中 path=null，生成 1 个调用（期望 1，诊断匹配 0）

### clear-all-005 (repeat 3)
- 工具选择不符：命中 path=null，生成 1 个调用（期望 1，诊断匹配 0）

### multi-tool-003 (repeat 1)
- 工具选择不符：命中 path=null，生成 2 个调用（期望 2，诊断匹配 0）

### multi-tool-003 (repeat 2)
- 工具选择不符：命中 path=null，生成 2 个调用（期望 2，诊断匹配 0）

### multi-tool-003 (repeat 3)
- 工具选择不符：命中 path=null，生成 2 个调用（期望 2，诊断匹配 0）

### two-turn-008 (repeat 1)
- 工具选择不符：命中 path=null，生成 2 个调用（期望 2，诊断匹配 1）
- 参数不符 [set_reminder.seconds exact]：期望 39600，实际 61200（生成值 61200）

### two-turn-008 (repeat 2)
- 工具选择不符：命中 path=null，生成 3 个调用（期望 2，诊断匹配 2）

### two-turn-008 (repeat 3)
- 工具选择不符：命中 path=null，生成 3 个调用（期望 2，诊断匹配 2）
