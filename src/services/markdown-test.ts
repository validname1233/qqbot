// services/markdown-test.ts —— 测试 QQ Markdown 消息的命令型 service。
// 用法：/md（群聊中使用）
// 收到后立刻发送一段预制的 Markdown 格式消息，用于测试 QQ 的 Markdown 渲染效果。

import type { CommandService, MessageContext } from "../types.js";
import { pushGroupMarkdown } from "../qq/messages.js";

const SAMPLE_MARKDOWN = `## 🐋 汐汐的 Markdown 测试

### 功能测试
这是一段测试文本，包含以下格式：
- **粗体文字**
- *斜体文字*（如果支持）
- ~~删除线~~（如果支持）

### 代码测试
行内代码：\`console.log("Hello")\`

### 列表测试
1. 第一项
2. 第二项
3. 第三项

### 引用测试
> 这是一段引用文字

### 链接测试
[QQ Bot 官方文档](https://bot.q.qq.com)

---
测试完成！如果你能看到上面的格式，说明 Markdown 功能正常工作 ✓`;

export const markdownTestService: CommandService = {
  name: "md",

  async handle(ctx: MessageContext): Promise<string | null> {
    const event = ctx.event;

    // 只在群聊场景可用
    if (event.type !== "GROUP_AT_MESSAGE_CREATE" && event.type !== "GROUP_MESSAGE_CREATE") {
      return "Markdown 测试只能在群里用哦～";
    }

    try {
      await pushGroupMarkdown(event.groupOpenid, SAMPLE_MARKDOWN);
      return null; // 发完 Markdown 后不再回复文本消息，避免刷屏
    } catch (error) {
      return `Markdown 发送失败：${error instanceof Error ? error.message : String(error)}`;
    }
  },
};
