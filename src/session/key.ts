// session/key.ts —— 租户身份的唯一真相源：tenantKey。
//
// 历史：这里曾有三种 key（sessionKey 人粒度 / conversationKey、memoryKey 会话粒度），
// 加上 knowledge-base.ts 的 kbScope（kb: 前缀）共四种，值域重叠、名实不符，还出过
// "人粒度三段键误存进定时任务表"的真实事故（见 scheduler/store.ts 迁移注释）。
// 2026-10-14 产品语义决策统一：QQ 群场景里 bot 面向的是"群"这个整体，群员身份
// 平等——所有租户身份收敛为一个键。
//
// 语义变化（原 sessionKey 是人粒度，此次统一为群粒度）：
//   - 同一个群同时只允许一个长流程（Agent/深检），第二个会被并发闸拒绝；
//   - /stop 变成群粒度中止：任何群员可停掉本群正在跑的任务（abort 发起人记日志）；
//   - cron 定时任务与群内用户流程互斥，到点撞上静默跳过（cron.ts 现成处理）。
//
// 消费者速查：
//   状态机锁（session/runner）、/stop 并发闸（session/interrupt，loop.ts / deep-search.ts
//   登记处）、进度推送（services/progress-bus）、页面快照池（services/browse/page-pool）、
//   短期/长期记忆与图片表（agent/memory/*）、观察者落库（services/memory-log）、
//   自定义人格（services/prompts）、定时任务归属（services/scheduler）、知识库 scope
//   （services/knowledge-base + arg-injectors 注入）、规划中：工作台目录 hash。
//
// 持久化兼容：四张表（short_term_messages / message_images / scheduled_tasks /
// group_personalities）存的两段键形状与本函数输出一致，零迁移；sessionKey 的旧三段值
// 只存在于内存 Map（interrupt/progress-bus/page-pool），重启即清。

import type { BotEvent } from "../events/registry.js";

// 租户键：群聊一群一份（整群共享），单聊一人一份。
// 前缀 group: / c2c: 是命名空间隔离：万一群 openid 和用户 openid 字符串偶然相同，
// 有前缀就不会串到同一份状态里。event.type 一判，TS 把 event 收窄到对应事件，
// 才能安全访问 groupOpenid / authorOpenid（可辨识联合收窄，和 dispatcher 里同一套路）。
export function tenantKey(event: BotEvent): string {
  if (event.type === "GROUP_AT_MESSAGE_CREATE" || event.type === "GROUP_MESSAGE_CREATE") {
    return `group:${event.groupOpenid}`;
  }
  return `c2c:${event.authorOpenid}`;
}
