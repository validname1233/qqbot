# 统一提示词管理系统

## 实现时间
2026-08-16

## 功能概述

实现了一个统一的提示词管理系统，支持：
- **人格与功能分离**：人格部分可自定义，功能规则固定不可改
- **按群隔离**：每个群可以设置独立的自定义人格
- **内存缓存**：启动时加载全部自定义人格到内存，避免运行时频繁查库
- **写透模式**：修改人格时同步更新数据库和缓存，立即生效
- **模块化组装**：运行时根据场景（日常聊天、Agent判断、定时提醒等）动态拼接提示词

## 设计理念

### 人格 vs 功能的分离

- **人格模块（可自定义）**：汐汐的角色设定、语气风格、行为习惯
  - 例：雌小鬼鲸鱼娘属性、傲娇调侃语气、称呼用户为"杂鱼"等
  - 各群可通过 `/set_personality` 命令自定义，覆盖默认人格

- **功能模块（固定不可改）**：针对特定场景的规则约束
  - `agent_judge`: Agent 判断工具调用时的系统提示词（强调工具选择准确性）
  - `agent_finalize`: Agent 收尾回复时的补充规则（整合工具结果）
  - `reminder`: 定时提醒场景的格式要求（催促执行、傲娇叮嘱）
  - `news_intro`: 新闻播报的开场白和分点介绍格式
  - `daily`: 日常聊天场景（无额外功能规则，只用人格）

### 拼接模式

运行时根据场景拼接：`人格 + 功能规则`

```typescript
// 日常聊天：只用人格
getSystemPrompt(event, "daily") 
// → "你是一只雌小鬼鲸鱼娘..."

// 定时提醒：人格 + 提醒规则
getSystemPrompt(event, "reminder")
// → "你是一只雌小鬼鲸鱼娘...\n\n定时提醒场景的具体规则..."
```

## 文件结构

### 新增文件

1. **src/services/prompts/functional.ts**
   - 导出 `DEFAULT_PERSONALITY`（默认人格）
   - 导出 `FUNCTIONAL_PROMPTS` 对象（各场景的功能规则）
   - 导出 `PromptScene` 类型（场景枚举）

2. **src/services/prompts/builder.ts**
   - 核心函数 `getSystemPrompt(event: BotEvent, scene: PromptScene = "daily"): string`
   - 维护 `personalityCache` 内存缓存
   - 按 `memoryKey(event)` 查询自定义人格或回退到默认人格
   - 拼接人格和功能规则返回完整系统提示词

3. **src/services/prompts/store.ts**
   - 管理 `data/prompts.sqlite` 数据库
   - 表结构：`group_personalities (key TEXT PRIMARY KEY, personality TEXT, updated_at INTEGER)`
   - `getPersonality(key)`: 读取一条记录（调试用，运行时走缓存）
   - `setPersonality(key, personality)`: 写入数据库 + 同步刷新缓存
   - `initializePersonalities()`: 启动时加载全部记录到缓存

4. **src/services/prompts/command.ts**
   - 实现 `/set_personality <人格描述>` 命令
   - 群聊/单聊均可用（2026-08-17 起支持单聊），隔离粒度由 `memoryKey(event)` 决定：群聊按群、单聊按用户
   - 调用 `setPersonality(memoryKey(event), personality)` 写入数据库并刷新缓存

### 修改的文件

1. **src/registry.ts**
   - 导入 `setPersonalityService`
   - 注册命令：`registerCommand(setPersonalityService)`

2. **src/webhook.ts**
   - 导入 `initializePersonalities`
   - 在 `server.listen()` 之前调用 `initializePersonalities()`，启动时加载缓存

3. **src/agent/loop.ts**
   - 导入 `BotEvent` 类型（修复类型错误）
   - `plainReply` 节点已使用 `getSystemPrompt(event, "daily")`
   - `synthesizeFinalReply` 函数已使用 `getSystemPrompt(event, "agent_finalize")`
   - `prepareContext` 节点已使用 `getSystemPrompt(event, "agent_judge")`

4. **src/services/reminder.ts**
   - 导入 `getSystemPrompt`
   - 两处 `callModel` 调用的 system prompt 改为 `getSystemPrompt(ctx.event, "reminder")`

5. **src/services/news/cron.ts**
   - 导入 `getSystemPrompt` 和 `BotEvent` 类型
   - 移除原来的 `NEWS_SYSTEM_PROMPT` 常量
   - `runNewsPush` 函数中构造假的 `BotEvent` 对象（只为获取 groupOpenid）
   - `callModel` 调用的 system prompt 改为 `getSystemPrompt(fakeEvent, "news_intro")`

6. **src/services/model.ts**
   - 导出 `DEFAULT_PERSONALITY as DEFAULT_SYSTEM_PROMPT` 用于向后兼容
   - 实际调用应该走 `getSystemPrompt(event, scene)` 而不是直接用这个常量

## 数据库结构

### prompts.sqlite

```sql
CREATE TABLE IF NOT EXISTS group_personalities (
  key TEXT PRIMARY KEY,           -- memoryKey(event) 的结果，格式：group:<groupOpenid> 或 c2c:<userOpenid>
  personality TEXT NOT NULL,      -- 自定义人格描述
  updated_at INTEGER NOT NULL     -- 更新时间戳（毫秒）
);
```

## 使用方式

### 用户侧

在群聊或单聊中发送命令：
```
/set_personality 你是一个严肃的学术助手，回答问题时引用权威文献，语气正式专业
```

机器人确认后，对应会话（该群，或该用户的单聊）的所有对话（日常聊天、Agent 收尾、定时提醒、新闻播报）都会使用新人格。

### 开发者侧

在需要调用大模型的地方：

```typescript
import { getSystemPrompt } from "./services/prompts/builder.js";

// 场景1：日常聊天（只用人格，无额外规则）
const systemPrompt = getSystemPrompt(event, "daily");

// 场景2：Agent 工具判断（人格 + 工具选择规则）
const systemPrompt = getSystemPrompt(event, "agent_judge");

// 场景3：定时提醒（人格 + 提醒格式规则）
const systemPrompt = getSystemPrompt(event, "reminder");

// 场景4：新闻播报（人格 + 新闻介绍规则）
const systemPrompt = getSystemPrompt(event, "news_intro");

// 场景5：Agent 收尾回复（人格 + 结果整合规则）
const systemPrompt = getSystemPrompt(event, "agent_finalize");
```

## 技术要点

### 缓存策略

- **启动加载**：`webhook.ts` 的 `server.listen()` 前调用 `initializePersonalities()`
- **写透更新**：`setPersonality()` 先写数据库，再调 `setPersonalityCache()` 同步刷新
- **读取优先级**：缓存中有 → 返回自定义人格；缓存中无 → 返回 `DEFAULT_PERSONALITY`

### 场景隔离

通过 `memoryKey(event)` 实现：
- 单聊：`c2c:<userOpenid>`
- 群聊：`group:<groupOpenid>`

不同群、不同单聊用户的自定义人格互不影响。

### 功能规则不可自定义的原因

功能规则（如工具选择逻辑、格式约束）是系统稳定运行的基础，不允许用户修改，避免：
- 破坏 Agent 的工具调用准确性
- 导致定时提醒、新闻播报格式混乱
- 影响长期记忆、会话管理等核心功能

## 后续扩展

### 已知限制

1. **恢复默认人格功能未实现**
   - 当前设置自定义人格后无法通过命令恢复默认
   - 可考虑增加 `/reset_personality` 命令，调用 `clearPersonalityCache(key)` 删除缓存和数据库记录

2. **单聊自定义人格已支持（2026-08-17 更新）**
   - 移除了 `command.ts` 中的群聊限制，单聊用户可设置自己独立的人格
   - 隔离粒度由 `memoryKey(event)` 天然决定：单聊 `c2c:<userOpenid>` 只影响该用户自己的对话，群聊 `group:<groupOpenid>` 整群共享，两套 key 互不干扰

### 可能的优化方向

1. **人格模板库**
   - 预置几种常见人格（严肃学术、轻松搞笑、专业客服等）
   - 用户可选模板或自定义描述

2. **人格版本管理**
   - 保存历史版本，支持回滚
   - 记录修改人和修改原因

3. **权限控制**
   - 限制只有群主/管理员可修改人格
   - 避免普通成员随意修改导致混乱

## 依赖

新增依赖项：
- `better-sqlite3`: 数据库驱动
- `@types/better-sqlite3`: TypeScript 类型定义

安装命令：
```bash
npm install better-sqlite3
npm install --save-dev @types/better-sqlite3
```

## 测试建议

1. **功能测试**
   - 在群聊中执行 `/set_personality <描述>`，验证确认消息
   - 发送普通消息，观察回复是否符合新人格
   - 触发定时提醒，验证提醒内容是否使用新人格
   - 触发新闻播报，验证播报风格是否使用新人格

2. **边界测试**
   - 单聊中执行 `/set_personality`，验证拒绝提示
   - 空描述：`/set_personality`，验证错误提示
   - 重启服务，验证自定义人格是否从缓存恢复

3. **隔离测试**
   - 在群A设置人格A，在群B设置人格B
   - 验证两个群的回复风格各自独立

## 总结

本次实现完成了统一的提示词管理系统，核心优势：
- **模块化**：人格与功能分离，各司其职
- **灵活性**：支持按群自定义人格，满足不同场景需求
- **高性能**：内存缓存避免频繁查库，写透模式保证一致性
- **可扩展**：新增场景只需在 `FUNCTIONAL_PROMPTS` 添加一项

完整实现包括 4 个新文件、6 个文件修改，通过 TypeScript 类型检查，可以直接部署使用。
