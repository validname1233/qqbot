# Agent 工具调用准确率评测报告

- 模式：live（模型：见 .env）
- 时间：2026-10-12T07-36-18
- semantic 判官：模型 judge
- 运行总数：102，有效：102，基础设施失败：0

## 指标总览

| 指标 | 分子/分母 | 值 |
| --- | --- | --- |
| 工具选择准确率 | 83/102 | 81.4% |
| 调用 precision（诊断口径） | 96/121 | 79.3% |
| 调用 recall（诊断口径） | 96/105 | 91.4% |
| 原始 JSON 合法率 | 121/121 | 100.0% |
| schema 合规率 | 121/121 | 100.0% |
| 参数字段准确率 | 154/158 | 97.5% |
| 整调用参数准确率 | 58/62 | 93.5% |
| 联合成功率 | 52/62 | 83.9% |
| 误调用率（不应调用的运行中生成了调用） | 3/3 | 100.0% |

未定（semantic 待判/无配对调用）：字段 52 项，整调用 40 次，联合 40 次。

## 分类统计

| 类别 | 运行 | 选择通过 | 联合通过 | 联合未定 |
| --- | --- | --- | --- | --- |
| search | 21 | 15 | 10 | 7 |
| open_page | 24 | 20 | 18 | 6 |
| set_reminder | 36 | 32 | 19 | 11 |
| add_memory | 21 | 16 | 5 | 16 |

## 失败与未定样例（22 条）

### search-006 (repeat 3)
- 工具选择不符：命中 path=null，生成 2 个调用（期望 1，诊断匹配 1）

### search-008 (repeat 1)
- 工具选择不符：命中 path=null，生成 2 个调用（期望 1，诊断匹配 1）
- 参数不符 [search.max_results optional_omitted_or_enum]：可选字段取值 8 不在 [3,5,10] 内（生成值 8）

### search-008 (repeat 2)
- 工具选择不符：命中 path=null，生成 2 个调用（期望 1，诊断匹配 1）

### search-008 (repeat 3)
- 工具选择不符：命中 path=null，生成 2 个调用（期望 1，诊断匹配 1）

### search-011 (repeat 1)
- 工具选择不符：命中 path=null，生成 2 个调用（期望 1，诊断匹配 0）

### search-011 (repeat 2)
- 工具选择不符：命中 path=null，生成 2 个调用（期望 1，诊断匹配 1）

### open-page-007 (repeat 3)
- 工具选择不符：命中 path=null，生成 2 个调用（期望 1，诊断匹配 0）

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

### add-memory-005 (repeat 1)
- 工具选择不符：命中 path=null，生成 2 个调用（期望 1，诊断匹配 0）

### add-memory-005 (repeat 2)
- 工具选择不符：命中 path=null，生成 2 个调用（期望 1，诊断匹配 1）

### add-memory-005 (repeat 3)
- 工具选择不符：命中 path=null，生成 2 个调用（期望 1，诊断匹配 0）

### add-memory-007 (repeat 2)
- 工具选择不符：命中 path=null，生成 3 个调用（期望 1，诊断匹配 1）

### add-memory-007 (repeat 3)
- 工具选择不符：命中 path=null，生成 3 个调用（期望 1，诊断匹配 1）
