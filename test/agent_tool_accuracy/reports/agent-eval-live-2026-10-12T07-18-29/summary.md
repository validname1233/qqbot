# Agent 工具调用准确率评测报告

- 模式：live（模型：见 .env）
- 时间：2026-10-12T07-18-29
- semantic 判官：模型 judge
- 运行总数：312，有效：213，基础设施失败：99

## 指标总览

| 指标 | 分子/分母 | 值 |
| --- | --- | --- |
| 工具选择准确率 | 176/213 | 82.6% |
| 调用 precision（诊断口径） | 175/232 | 75.4% |
| 调用 recall（诊断口径） | 175/195 | 89.7% |
| 原始 JSON 合法率 | 232/232 | 100.0% |
| schema 合规率 | 232/232 | 100.0% |
| 参数字段准确率 | 211/226 | 93.4% |
| 整调用参数准确率 | 159/168 | 94.6% |
| 联合成功率 | 142/168 | 84.5% |
| 误调用率（不应调用的运行中生成了调用） | 7/57 | 12.3% |

未定（semantic 待判/无配对调用）：字段 272 项，整调用 45 次，联合 45 次。

## 分类统计

| 类别 | 运行 | 选择通过 | 联合通过 | 联合未定 |
| --- | --- | --- | --- | --- |
| no_tool | 45 | 44 | 44 | 0 |
| get_time | 24 | 24 | 24 | 0 |
| search | 36 | 6 | 4 | 31 |
| open_page | 24 | 0 | 0 | 24 |
| set_reminder | 36 | 0 | 0 | 36 |
| add_memory | 24 | 4 | 3 | 21 |
| delete_memory | 18 | 17 | 9 | 9 |
| clear_all_memories | 15 | 12 | 10 | 2 |
| recall_memory | 18 | 15 | 9 | 6 |
| multi_tool | 18 | 13 | 9 | 8 |
| two_turn | 24 | 14 | 6 | 3 |
| context | 18 | 15 | 13 | 3 |
| hidden_param | 12 | 12 | 11 | 1 |

## 失败与未定样例（144 条）

### no-tool-003 (repeat 2)
- 工具选择不符：命中 path=null，生成 1 个调用（期望 0，诊断匹配 0）

### search-001 (repeat 3)
- 工具选择不符：命中 path=null，生成 2 个调用（期望 1，诊断匹配 0）

### search-003 (repeat 1)
- 工具选择不符：命中 path=null，生成 2 个调用（期望 1，诊断匹配 0）

### search-003 (repeat 2)
- 工具选择不符：命中 path=null，生成 2 个调用（期望 1，诊断匹配 0）

### search-003 (repeat 3)
- 工具选择不符：命中 path=null，生成 3 个调用（期望 1，诊断匹配 0）

### search-004 (repeat 2)
- 工具选择不符：命中 path=null，生成 2 个调用（期望 1，诊断匹配 1）

### search-004 (repeat 3)
- 工具选择不符：命中 path=null，生成 2 个调用（期望 1，诊断匹配 0）

### search-005 (repeat 1)
- 工具选择不符：命中 path=null，生成 2 个调用（期望 1，诊断匹配 0）

### search-005 (repeat 2)
- 工具选择不符：命中 path=null，生成 2 个调用（期望 1，诊断匹配 0）

### search-005 (repeat 3)
- 工具选择不符：命中 path=null，生成 3 个调用（期望 1，诊断匹配 0）

### search-006 (repeat 1)
- 基础设施错误：Embedding 接口返回 500: {"error":{"code":"1234","message":"网络错误，错误id：2026101215040725a8e1ddcf154f4e，请稍后重试"}}

### search-006 (repeat 2)
- 基础设施错误：Embedding 接口返回 500: {"error":{"code":"1234","message":"网络错误，错误id：20261012150407806922865e7d42b1，请稍后重试"}}

### search-006 (repeat 3)
- 基础设施错误：Embedding 接口返回 500: {"error":{"code":"1234","message":"网络错误，错误id：20261012150407a9024a19af674a2d，请稍后重试"}}

### search-007 (repeat 1)
- 基础设施错误：Embedding 接口返回 500: {"error":{"code":"1234","message":"网络错误，错误id：2026101215040756f8c4b63aec4a36，请稍后重试"}}

### search-007 (repeat 2)
- 基础设施错误：Embedding 接口返回 500: {"error":{"code":"1234","message":"网络错误，错误id：20261012150408508ac765537841c9，请稍后重试"}}

### search-007 (repeat 3)
- 基础设施错误：Embedding 接口返回 500: {"error":{"code":"1234","message":"网络错误，错误id：20261012150408c9efd7694ddd483f，请稍后重试"}}

### search-008 (repeat 1)
- 基础设施错误：Embedding 接口返回 500: {"error":{"code":"1234","message":"网络错误，错误id：20261012150408ada2f761f92c4ba6，请稍后重试"}}

### search-008 (repeat 2)
- 基础设施错误：Embedding 接口返回 500: {"error":{"code":"1234","message":"网络错误，错误id：20261012150408a4e7dbd76eeb4fd7，请稍后重试"}}

### search-008 (repeat 3)
- 基础设施错误：Embedding 接口返回 500: {"error":{"code":"1234","message":"网络错误，错误id：2026101215040812411ad4b50443c5，请稍后重试"}}

### search-009 (repeat 1)
- 基础设施错误：Embedding 接口返回 500: {"error":{"code":"1234","message":"网络错误，错误id：20261012150409f60453aa38244be1，请稍后重试"}}

### search-009 (repeat 2)
- 基础设施错误：Embedding 接口返回 500: {"error":{"code":"1234","message":"网络错误，错误id：20261012150409533e0d6a46cb4099，请稍后重试"}}

### search-009 (repeat 3)
- 基础设施错误：Embedding 接口返回 500: {"error":{"code":"1234","message":"网络错误，错误id：20261012150409ebd168da7cad4634，请稍后重试"}}

### search-010 (repeat 1)
- 基础设施错误：Embedding 接口返回 500: {"error":{"code":"1234","message":"网络错误，错误id：20261012150409e5cf61a186b74e56，请稍后重试"}}

### search-010 (repeat 2)
- 基础设施错误：Embedding 接口返回 500: {"error":{"code":"1234","message":"网络错误，错误id：202610121504099ca37f4dbc1944e8，请稍后重试"}}

### search-010 (repeat 3)
- 基础设施错误：Embedding 接口返回 500: {"error":{"code":"1234","message":"网络错误，错误id：20261012150410030df0e57ffc4414，请稍后重试"}}

### search-011 (repeat 1)
- 基础设施错误：Embedding 接口返回 500: {"error":{"code":"1234","message":"网络错误，错误id：202610121504108d1c9d8e281746f0，请稍后重试"}}

### search-011 (repeat 2)
- 基础设施错误：Embedding 接口返回 500: {"error":{"code":"1234","message":"网络错误，错误id：202610121504107e62218834f04efa，请稍后重试"}}

### search-011 (repeat 3)
- 基础设施错误：Embedding 接口返回 500: {"error":{"code":"1234","message":"网络错误，错误id：20261012150410de3b0420669c4308，请稍后重试"}}

### search-012 (repeat 1)
- 基础设施错误：Embedding 接口返回 500: {"error":{"code":"1234","message":"网络错误，错误id：20261012150411497bc2326f584927，请稍后重试"}}

### search-012 (repeat 2)
- 基础设施错误：Embedding 接口返回 500: {"error":{"code":"1234","message":"网络错误，错误id：2026101215041188031645ddc44327，请稍后重试"}}

### search-012 (repeat 3)
- 基础设施错误：Embedding 接口返回 500: {"error":{"code":"1234","message":"网络错误，错误id：202610121504117b797191dce64422，请稍后重试"}}

### open-page-001 (repeat 1)
- 基础设施错误：Embedding 接口返回 500: {"error":{"code":"1234","message":"网络错误，错误id：2026101215041134f5613480384a2d，请稍后重试"}}

### open-page-001 (repeat 2)
- 基础设施错误：Embedding 接口返回 500: {"error":{"code":"1234","message":"网络错误，错误id：2026101215041182b14b15cc9645f0，请稍后重试"}}

### open-page-001 (repeat 3)
- 基础设施错误：Embedding 接口返回 500: {"error":{"code":"1234","message":"网络错误，错误id：20261012150412ed501786e2464c2c，请稍后重试"}}

### open-page-002 (repeat 1)
- 基础设施错误：Embedding 接口返回 500: {"error":{"code":"1234","message":"网络错误，错误id：202610121504126a06e127ca9340f4，请稍后重试"}}

### open-page-002 (repeat 2)
- 基础设施错误：Embedding 接口返回 500: {"error":{"code":"1234","message":"网络错误，错误id：202610121504126b690519789d485d，请稍后重试"}}

### open-page-002 (repeat 3)
- 基础设施错误：Embedding 接口返回 500: {"error":{"code":"1234","message":"网络错误，错误id：20261012150412cc04c6c994e24506，请稍后重试"}}

### open-page-003 (repeat 1)
- 基础设施错误：Embedding 接口返回 500: {"error":{"code":"1234","message":"网络错误，错误id：20261012150413408857391f2a48c8，请稍后重试"}}

### open-page-003 (repeat 2)
- 基础设施错误：Embedding 接口返回 500: {"error":{"code":"1234","message":"网络错误，错误id：20261012150413bcc703cabd4e4833，请稍后重试"}}

### open-page-003 (repeat 3)
- 基础设施错误：Embedding 接口返回 500: {"error":{"code":"1234","message":"网络错误，错误id：20261012150413f1ba384d5126446d，请稍后重试"}}

### open-page-004 (repeat 1)
- 基础设施错误：Embedding 接口返回 500: {"error":{"code":"1234","message":"网络错误，错误id：202610121504138b4039a9406c489a，请稍后重试"}}

### open-page-004 (repeat 2)
- 基础设施错误：Embedding 接口返回 500: {"error":{"code":"1234","message":"网络错误，错误id：202610121504136320c35e0cc44c1f，请稍后重试"}}

### open-page-004 (repeat 3)
- 基础设施错误：Embedding 接口返回 500: {"error":{"code":"1234","message":"网络错误，错误id：202610121504132668801bf8234e40，请稍后重试"}}

### open-page-005 (repeat 1)
- 基础设施错误：Embedding 接口返回 500: {"error":{"code":"1234","message":"网络错误，错误id：202610121504144bab08e36a764ad1，请稍后重试"}}

### open-page-005 (repeat 2)
- 基础设施错误：Embedding 接口返回 500: {"error":{"code":"1234","message":"网络错误，错误id：202610121504140567182a61da4378，请稍后重试"}}

### open-page-005 (repeat 3)
- 基础设施错误：Embedding 接口返回 500: {"error":{"code":"1234","message":"网络错误，错误id：202610121504146effe302c2644228，请稍后重试"}}

### open-page-006 (repeat 1)
- 基础设施错误：Embedding 接口返回 500: {"error":{"code":"1234","message":"网络错误，错误id：2026101215041400c3979c1fdb4fa2，请稍后重试"}}

### open-page-006 (repeat 2)
- 基础设施错误：Embedding 接口返回 500: {"error":{"code":"1234","message":"网络错误，错误id：2026101215041438f0fb38abf34b99，请稍后重试"}}

### open-page-006 (repeat 3)
- 基础设施错误：Embedding 接口返回 500: {"error":{"code":"1234","message":"网络错误，错误id：20261012150415c4f67bf6c5f84ad9，请稍后重试"}}

### open-page-007 (repeat 1)
- 基础设施错误：Embedding 接口返回 500: {"error":{"code":"1234","message":"网络错误，错误id：202610121504158c55c33371b943cc，请稍后重试"}}

（其余 94 条见 trajectory JSONL）