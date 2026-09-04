// agent/tools/get-time.ts —— 获取当前时间的工具。
// 为什么需要它：模型的训练数据有截止日期，对"今天几号、现在几点"没有可靠感知，
// 涉及日期的问题（"今天星期几""这个月还有几天"）会静默编造。调一次本工具就拿到
// 服务器真实时间，一次工具调用的成本换掉一类日期幻觉。
// 无参数：模型要的就是"现在"，没有可由它决定的东西。

import type { Tool } from "../tool.js";

// toLocaleDateString 的 timeZone 短名在装有 ICU 的 Node 上可用（项目已依赖
// Intl.Segmenter，同一 ICU），统一写死 Asia/Shanghai：服务器系统时区不可控，
// 机器人用户在国内，固定时区让输出稳定可复现。
const TIMEZONE = "Asia/Shanghai";

export const getTimeTool: Tool = {
  name: "get_time",
  description:
    "获取当前的日期和时间。当用户问到今天日期、现在几点、星期几、距今多久等" +
    "任何与当前时间相关的问题时调用；用户的请求包含「最近/最新/今年/近期/如今」" +
    "等相对时间表述，需要先确定当前日期才能准确搜索或计算时，也应先调用本工具。" +
    "你对当前时间的推测不可靠，不要凭感觉回答。",
  parameters: {
    type: "object",
    properties: {},
    // parameters 为空对象：无参数工具也必须带 type 声明，模型端才能正确解析。
  },

  async run() {
    const now = new Date();
    const datetime = new Intl.DateTimeFormat("en-CA", {
      timeZone: TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      // ISO 8601 偏移（+08:00）：en-CA 模板天然产出 "2026-09-04, 10:01:23"，
      // 再由 formatToParts 精确拼装；timeZoneName: "shortOffset" 拿到 "+08" 形式。
      timeZoneName: "shortOffset",
    }).formatToParts(now);
    const get = (type: string): string =>
      datetime.find((p) => p.type === type)?.value ?? "";
    const date = `${get("year")}-${get("month")}-${get("day")}`;
    const time = `${get("hour")}:${get("minute")}:${get("second")}`;
    // 偏移可能返回 "+8"（一位数）而非 "+08"，统一补零到 "+08:00" 的完整形式
    const offsetRaw = get("timeZoneName").replace("GMT", "");
    const offsetMatch = /([+-])(\d{1,2})(?::(\d{2}))?/.exec(offsetRaw);
    let offset = "+08:00";
    if (offsetMatch !== null) {
      const sign = offsetMatch[1];
      const hours = offsetMatch[2].padStart(2, "0");
      const minutes = (offsetMatch[3] ?? "00").padStart(2, "0");
      offset = `${sign}${hours}:${minutes}`;
    }
    return JSON.stringify({
      datetime: `${date}T${time}${offset}`,
      date,
      timezone: TIMEZONE,
    });
  },
};
