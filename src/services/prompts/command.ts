// services/prompts/command.ts —— 提示词自定义命令：/set_personality <人格描述>
// 群聊/单聊均可用：隔离粒度由 tenantKey(event) 决定——群聊按群（整群共享一份），
// 单聊按用户（只影响该用户自己的对话）。写入数据库后刷新缓存，运行时立即生效。

import type { CommandService } from "../../types.js";
import { tenantKey } from "../../session/key.js";
import { setPersonality, clearPersonality } from "./store.js";

export const setPersonalityService: CommandService = {
  name: "set_personality",

  async handle(ctx) {
    const args = ctx.args.trim();

    // 子命令：清空 = 删除自定义人格，恢复默认（汐汐）。
    if (args === "清空" || args === "重置") {
      const removed = clearPersonality(tenantKey(ctx.event));
      if (!removed) {
        return "本来就没有设置过自定义人格哦～现在用的就是默认的。";
      }
      return "自定义人格已清空，恢复默认人设了～";
    }

    const personality = args;
    if (personality === "") {
      return "人格描述不能为空哦～用法：/set_personality <人格描述>，例如 /set_personality 你是一个严肃的学术助手；要恢复默认发 /set_personality 清空";
    }

    const key = tenantKey(ctx.event);
    setPersonality(key, personality);

    // 确认话术按场景说明生效范围，用户好知道这套人设影响的是谁。
    const scopeHint =
      ctx.event.type === "C2C_MESSAGE_CREATE"
        ? "只在你和本鲸鱼的单聊里生效"
        : "群里的所有人都会共享这套人设";
    return `自定义人格设置好了，${scopeHint}～以后的对话（日常聊天、Agent任务收尾、定时提醒等）都会用这套人设，工具判断逻辑不受影响。想恢复默认人设的话，发 /set_personality 清空 就行～`;
  },
};
