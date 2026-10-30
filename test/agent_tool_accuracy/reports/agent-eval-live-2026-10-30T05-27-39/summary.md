# Agent 工具调用准确率评测报告

- 模式：live（模型：见 .env）
- 时间：2026-10-30T05-27-39
- semantic 判官：模型 judge
- 运行总数：255，有效：255，基础设施失败：0

## 指标总览

| 指标 | 分子/分母 | 值 |
| --- | --- | --- |
| 工具选择准确率 | 225/255 | 88.2% |
| 调用 precision（诊断口径） | 222/285 | 77.9% |
| 调用 recall（诊断口径） | 222/249 | 89.2% |
| 原始 JSON 合法率 | 285/285 | 100.0% |
| schema 合规率 | 285/285 | 100.0% |
| 参数字段准确率 | 236/257 | 91.8% |
| 整调用参数准确率 | 159/179 | 88.8% |
| 联合成功率 | 154/179 | 86.0% |
| 误调用率（不应调用的运行中生成了调用） | 0/51 | 0.0% |

未定（semantic 待判/无配对调用）：字段 142 项，整调用 76 次，联合 76 次。

## 分类统计

| 类别 | 运行 | 选择通过 | 联合通过 | 联合未定 |
| --- | --- | --- | --- | --- |
| no_tool | 45 | 45 | 45 | 0 |
| get_time | 24 | 24 | 24 | 0 |
| search | 36 | 28 | 2 | 20 |
| open_page | 24 | 22 | 18 | 3 |
| set_reminder | 36 | 34 | 8 | 25 |
| recall_memory | 18 | 18 | 18 | 0 |
| multi_tool | 18 | 6 | 2 | 11 |
| two_turn | 24 | 22 | 18 | 6 |
| context | 18 | 17 | 13 | 5 |
| hidden_param | 12 | 9 | 6 | 6 |

## 失败与未定样例（45 条）

### search-002 (repeat 1)
- 工具选择不符：命中 path=null，生成 2 个调用（期望 1，诊断匹配 1）

### search-002 (repeat 2)
- 工具选择不符：命中 path=null，生成 2 个调用（期望 1，诊断匹配 1）
- 参数不符 [search.max_results optional_omitted_or_enum]：可选字段取值 6 不在 [3,5,10] 内（生成值 6）

### search-002 (repeat 3)
- 参数不符 [search.max_results optional_omitted_or_enum]：可选字段取值 6 不在 [3,5,10] 内（生成值 6）

### search-006 (repeat 2)
- 参数不符 [search.max_results optional_omitted_or_enum]：可选字段取值 6 不在 [3,5,10] 内（生成值 6）

### search-006 (repeat 3)
- 参数不符 [search.max_results optional_omitted_or_enum]：可选字段取值 8 不在 [3,5,10] 内（生成值 8）
- 参数不符 [search.search_depth optional_omitted_or_enum]：可选字段取值 "advanced" 不在 ["basic"] 内（生成值 "advanced"）

### search-007 (repeat 1)
- 工具选择不符：命中 path=null，生成 2 个调用（期望 1，诊断匹配 1）
- 参数不符 [search.max_results optional_omitted_or_enum]：可选字段取值 6 不在 [3,5,10] 内（生成值 6）

### search-007 (repeat 2)
- 工具选择不符：命中 path=null，生成 2 个调用（期望 1，诊断匹配 1）

### search-007 (repeat 3)
- 工具选择不符：命中 path=null，生成 2 个调用（期望 1，诊断匹配 1）
- 参数不符 [search.max_results optional_omitted_or_enum]：可选字段取值 6 不在 [3,5,10] 内（生成值 6）

### search-008 (repeat 1)
- 参数不符 [search.max_results optional_omitted_or_enum]：可选字段取值 6 不在 [3,5,10] 内（生成值 6）

### search-008 (repeat 2)
- 参数不符 [search.search_depth optional_omitted_or_enum]：可选字段取值 "advanced" 不在 ["basic"] 内（生成值 "advanced"）

### search-008 (repeat 3)
- 参数不符 [search.max_results optional_omitted_or_enum]：可选字段取值 6 不在 [3,5,10] 内（生成值 6）

### search-010 (repeat 1)
- 参数不符 [search.max_results optional_omitted_or_enum]：可选字段取值 6 不在 [3,5,10] 内（生成值 6）

### search-010 (repeat 2)
- 工具选择不符：命中 path=null，生成 2 个调用（期望 1，诊断匹配 1）
- 参数不符 [search.search_depth optional_omitted_or_enum]：可选字段取值 "advanced" 不在 ["basic"] 内（生成值 "advanced"）

### search-010 (repeat 3)
- 工具选择不符：命中 path=null，生成 2 个调用（期望 1，诊断匹配 1）
- 参数不符 [search.max_results optional_omitted_or_enum]：可选字段取值 6 不在 [3,5,10] 内（生成值 6）

### search-012 (repeat 1)
- 工具选择不符：命中 path=null，生成 2 个调用（期望 1，诊断匹配 1）

### search-012 (repeat 2)
- 参数不符 [search.max_results optional_omitted_or_enum]：可选字段取值 4 不在 [3,5,10] 内（生成值 4）

### search-012 (repeat 3)
- 参数不符 [search.max_results optional_omitted_or_enum]：可选字段取值 4 不在 [3,5,10] 内（生成值 4）

### open-page-007 (repeat 1)
- 参数不符 [search.max_results optional_omitted_or_enum]：可选字段取值 6 不在 [3,5,10] 内（生成值 6）

### open-page-007 (repeat 2)
- 参数不符 [search.max_results optional_omitted_or_enum]：可选字段取值 6 不在 [3,5,10] 内（生成值 6）

### open-page-008 (repeat 1)
- 参数不符 [search.max_results optional_omitted_or_enum]：可选字段取值 6 不在 [3,5,10] 内（生成值 6）

### open-page-008 (repeat 2)
- 工具选择不符：命中 path=null，生成 0 个调用（期望 1，诊断匹配 0）

### open-page-008 (repeat 3)
- 工具选择不符：命中 path=null，生成 0 个调用（期望 1，诊断匹配 0）

### set-reminder-008 (repeat 1)
- 参数不符 [set_reminder.seconds exact]：期望 10800，实际 7200（生成值 7200）

### set-reminder-008 (repeat 2)
- 参数不符 [set_reminder.seconds exact]：期望 10800，实际 7200（生成值 7200）

### set-reminder-008 (repeat 3)
- 参数不符 [set_reminder.seconds exact]：期望 10800，实际 7200（生成值 7200）

### set-reminder-011 (repeat 1)
- 工具选择不符：命中 path=null，生成 2 个调用（期望 1，诊断匹配 1）

### set-reminder-011 (repeat 3)
- 工具选择不符：命中 path=null，生成 3 个调用（期望 1，诊断匹配 0）

### multi-tool-001 (repeat 1)
- 工具选择不符：命中 path=null，生成 1 个调用（期望 2，诊断匹配 1）

### multi-tool-001 (repeat 2)
- 工具选择不符：命中 path=null，生成 1 个调用（期望 2，诊断匹配 1）

### multi-tool-001 (repeat 3)
- 工具选择不符：命中 path=null，生成 1 个调用（期望 2，诊断匹配 1）

### multi-tool-003 (repeat 1)
- 工具选择不符：命中 path=null，生成 3 个调用（期望 2，诊断匹配 0）

### multi-tool-003 (repeat 2)
- 工具选择不符：命中 path=null，生成 3 个调用（期望 2，诊断匹配 0）

### multi-tool-003 (repeat 3)
- 工具选择不符：命中 path=null，生成 3 个调用（期望 2，诊断匹配 0）

### multi-tool-004 (repeat 1)
- 工具选择不符：命中 path=null，生成 1 个调用（期望 2，诊断匹配 1）

### multi-tool-004 (repeat 2)
- 工具选择不符：命中 path=null，生成 1 个调用（期望 2，诊断匹配 1）

### multi-tool-004 (repeat 3)
- 工具选择不符：命中 path=null，生成 1 个调用（期望 2，诊断匹配 1）

### multi-tool-005 (repeat 1)
- 工具选择不符：命中 path=null，生成 2 个调用（期望 2，诊断匹配 0）

### multi-tool-005 (repeat 2)
- 工具选择不符：命中 path=null，生成 2 个调用（期望 2，诊断匹配 1）

### multi-tool-005 (repeat 3)
- 工具选择不符：命中 path=null，生成 2 个调用（期望 2，诊断匹配 1）

### two-turn-007 (repeat 1)
- 工具选择不符：命中 path=null，生成 1 个调用（期望 2，诊断匹配 0）

### two-turn-007 (repeat 2)
- 工具选择不符：命中 path=null，生成 1 个调用（期望 2，诊断匹配 0）

### context-005 (repeat 3)
- 工具选择不符：命中 path=null，生成 2 个调用（期望 1，诊断匹配 0）

### hidden-param-002 (repeat 1)
- 工具选择不符：命中 path=null，生成 0 个调用（期望 1，诊断匹配 0）

### hidden-param-002 (repeat 2)
- 工具选择不符：命中 path=null，生成 0 个调用（期望 1，诊断匹配 0）

### hidden-param-002 (repeat 3)
- 工具选择不符：命中 path=null，生成 0 个调用（期望 1，诊断匹配 0）
