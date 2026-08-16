// services/prompts/command.ts —— 提示词自定义命令：/set_personality <人格描述>
// 只能在群聊使用（单聊走默认人格即可），写入数据库后刷新缓存，运行时立即生效。

import type { CommandService } from "../../types.js";
import { memoryKey } from "../../agent/context.js";
import { setPersonality } from "./store.js";

export const setPersonalityService: CommandService = {
  name: "set_personality",

  async handle(ctx) {
    // 只允许群聊使用（单聊用默认人格，不需要每个用户独立配置）
    if (ctx.event.type !== "GROUP_AT_MESSAGE_CREATE" && ctx.event.type !== "GROUP_MESSAGE_CREATE") {
      return "这个功能只能在群里用哦～单聊场景用默认人设就好啦";
    }

    const personality = ctx.args.trim();
    if (personality === "") {
      return "人格描述不能为空哦～用法：/set_personality <人格描述>，例如 /set_personality 你是一个严肃的学术助手";
    }

    const key = memoryKey(ctx.event);
    setPersonality(key, personality);

    return `已为当前群设置自定义人格～以后的对话（日常聊天、Agent任务收尾、定时提醒等）都会用这套人设，工具判断逻辑不受影响。要恢复默认人设的话……呃，暂时还没做这个功能，先凑合用吧～`;
  },
};
